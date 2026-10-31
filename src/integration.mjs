// Experimental integration: use only in an isolated profile while the
// limitations documented in README remain unresolved.
import { createUserMessage, contentHasImage, isAgentLoopRequest, requiredImageOffload,
  requestImageHandleText, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';
import { DEFAULTS, PROVIDER } from './base/constants.js';
import { bindImageVersions } from './base/image-context.js';
import { prepareImageVersions } from './image-preparer.mjs';
import { REFERENCE_TEXT } from './reference.mjs';
import { isEligibleTopLevel } from './eligibility.mjs';
const abortIfNeeded = signal => { if (signal?.aborted) throw new Error('history switch operation canceled'); };

function deepFrozen(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.prototype.hasOwnProperty.call(property, 'value') && deepFrozen(property.value, seen);
  });
}

// This is a conservative byte-based preflight, not a provider tokenizer or a
// guarantee about remote truncation. Reserve the adapter's entire configured
// seed allowance plus per-message/tool framing and the requested output.
export function withinEstimatedBudget(options, contextWindow, seedReserve = DEFAULTS.maxSeedBytes) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(seedReserve) || seedReserve < 0 ||
      !Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || !Array.isArray(options.messages)) return false;
  try {
    const tools = options.tools ?? [];
    if (!Array.isArray(tools)) return false;
    let blocks = 0, images = 0, repeatedToolTextBytes = 0;
    for (const message of options.messages) {
      if (!Array.isArray(message?.content)) return false;
      blocks += message.content.length;
      images += message.content.filter(block => block?.type === 'image').length;
      if (message.role === 'tool' && message.content.some(block => block?.type === 'image')) {
        for (const block of message.content) if (block?.type === 'text' && typeof block.text === 'string') {
          repeatedToolTextBytes += Buffer.byteLength(block.text, 'utf8');
        }
      }
    }
    const visible = JSON.stringify({ messages: options.messages, system: options.system, tools, toolHistory: options.toolHistory, stop: options.stop });
    // Include extra envelope overhead for every message block (not merely for
    // each message): one assistant turn can expand into many tool calls.
    // Also reserve 32 seed-message envelopes, the validator's maximum.
    // DeepSeek documents up to 1024 tokens per image; this remains an estimate
    // for the configured gateway and is not a server-side capacity guarantee.
    const estimate = Buffer.byteLength(visible, 'utf8') + repeatedToolTextBytes + seedReserve + options.maxTokens + images * 1024 + 4096 + 256 * 32 +
      256 * (options.messages.length + tools.length + blocks);
    return Number.isSafeInteger(estimate) && estimate < contextWindow;
  } catch { return false; }
}

export function wireInputsFrozen(options) {
  if (!options || typeof options !== 'object' || !Object.isFrozen(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) return false;
  const keys = ['provider', 'model', 'reasoningEffort', 'maxTokens', 'messages', 'tools', 'toolHistory', 'system', 'temperature', 'stop'];
  if (!keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(options, key);
    if (!property) return !(key in options);
    return Object.prototype.hasOwnProperty.call(property, 'value') && deepFrozen(property.value);
  })) return false;
  return typeof options.provider === 'string' && typeof options.model === 'string' &&
    typeof options.reasoningEffort === 'string' && Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 &&
    Array.isArray(options.messages) && (options.tools === undefined || Array.isArray(options.tools)) &&
    (options.system === undefined || typeof options.system === 'string') &&
    (options.temperature === undefined || (typeof options.temperature === 'number' && Number.isFinite(options.temperature))) &&
    (options.stop === undefined || (Array.isArray(options.stop) && options.stop.every(value => typeof value === 'string')));
}

export function installSyntheticAgent(agentCtx, agent, selection, contract, target, loaded, codec, store) {
  if (!codec || typeof codec.source !== 'function' || typeof codec.read !== 'function') throw new Error('reference codec unavailable');
  if (!store || typeof store.arm !== 'function' || typeof store.get !== 'function') throw new Error('admission store unavailable');
  let candidate = false, armed = false;
  const stopPre = agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    abortIfNeeded(payload.signal);
    await contract.waitPending(agent, payload.signal);
    abortIfNeeded(payload.signal);
    const selected = selection.assembled;
    const prior = agent.session.snapshotEvents().some(event =>
      ['user/message', 'assistant/message', 'request/header'].includes(event.type));
    armed = contract.get(agent.id).enabled && !prior;
    if (armed && (!selected || typeof selected.provider !== 'string' || typeof selected.model !== 'string')) throw new Error('history switch selection unavailable');
    candidate = armed && selected?.provider === target.provider && selected?.model === target.model;
    if (!prior) {
      // A canceled first attempt may leave only a pending sidecar. If the
      // user explicitly selects another model before any conversation was
      // committed, abandon that pending admission and keep the original path.
      const previous = store.get(agent.session.id);
      if (previous && (previous.state === 'pending' || previous.state === 'skipped') &&
          (!armed || (candidate && previous.state === 'skipped') || (!candidate && previous.state === 'pending'))) {
        await store.abandonPending(agent.session.id, previous.sha256);
        abortIfNeeded(payload.signal);
      }
    }
    if (!candidate) {
      // Preserve why the enabled switch did not apply even across restarts.
      if (armed) { await store.skip(agent.session.id, loaded.sha256); abortIfNeeded(payload.signal); }
      return decision;
    }
    await store.arm(agent.session.id, loaded.sha256);
    abortIfNeeded(payload.signal);
    const source = codec.source(loaded.sha256, agent.session.id);
    if (source.ownerSessionId !== agent.session.id) throw new Error('history switch owner mismatch');
    const carrier = createUserMessage({ source, content: [{ type: 'text', text: REFERENCE_TEXT }] });
    // The core commits the system and this ordered user batch after prepareCall.
    return { ...decision, messages: [carrier, ...decision.messages] };
  }, { prepend: true });
  const stopRequest = agentCtx.on('agent/request', async (payload, next) => {
    const result = await contract.request(agent, payload, async () => {
      const route = await next();
      if (typeof selection.recordResolved === 'function') selection.recordResolved(route);
      return route;
    }, candidate);
    if (candidate && result.route?.reasoningEffort !== target.reasoningEffort) throw new Error('history switch requires max reasoning effort');
    if (candidate && (!result.ready || !result.bindingVerified || result.route?.provider !== target.provider || result.route?.model !== target.model)) {
      throw new Error('history switch admission failed');
    }
    if (armed && !candidate && result.route?.provider === target.provider && result.route?.model === target.model) {
      throw new Error('history switch selection changed during admission');
    }
    return result.route;
  }, { prepend: true });
  return () => { stopPre(); stopRequest(); };
}

export function installSyntheticStream(ctx, contract, target, codec, store, imageVerifier = undefined) {
  if (!codec || typeof codec.read !== 'function') throw new Error('reference codec unavailable');
  if (!store || typeof store.get !== 'function' || typeof store.activate !== 'function') throw new Error('admission store unavailable');
  return ctx.on('llm/stream', (options, next) => {
    // Only the exact request object marked by rc.3 AgentLoop is eligible.
    // Auxiliary calls and our own nested request keep their original route.
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next();
    if (options.provider !== target.provider || options.model !== target.model) return next();
    const targetAgent = ctx.agents.get(options.sessionId);
    // Child, seeded and other unowned calls must keep the host's original
    // route, including when they inherit an ancestor's reference marker.
    if (!isEligibleTopLevel(targetAgent)) return next();
    const carriers = options.messages.map(message => codec.read(message, options.sessionId)).filter(Boolean);
    const admission = store.get(options.sessionId);
    if (!carriers.length) {
      const agent = targetAgent;
      // A previously admitted reference may be absent after compaction. Never
      // silently fall back to an unseeded target request in that case.
      if ((admission && admission.state !== 'skipped') || agent?.session?.snapshotEvents().some(event => event.type === 'user/message' && codec.read(event.data, options.sessionId))) {
        throw new Error('history switch history reference left the active context');
      }
      return next();
    }
    if (carriers.length !== 1 || carriers[0].ownerSessionId !== options.sessionId || !admission || admission.state === 'skipped' ||
        admission.owner !== options.sessionId || admission.sha256 !== carriers[0].sha256) throw new Error('history switch carrier ownership invalid');
    const messages = options.messages;
    const hasImages = messages.some(message => contentHasImage(message.content));
    if (!wireInputsFrozen(options)) throw new Error('history switch request is not immutable');
    const agent = targetAgent;
    return (async function* () {
      let versions;
      try {
        // Resolve public capability metadata before reading any image data.
        const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
        abortIfNeeded(options.signal);
        if (!withinEstimatedBudget(options, info?.context?.contextWindow)) throw new Error('history switch context budget exceeded');
        if (hasImages) {
          if (!info?.inputModalities?.includes('image') || typeof imageVerifier?.imagePolicy !== 'function') throw new Error('history switch image model unavailable');
          const policy = imageVerifier.imagePolicy();
          const attachments = ctx.get('attachments');
          abortIfNeeded(options.signal);
          versions = await prepareImageVersions(messages, {
            attachments, dimensions: requestImageDimensions, requiredOffload: requiredImageOffload,
            handleText: requestImageHandleText,
            resolveAccess: typeof attachments?.imageHostPath === 'function'
              ? ref => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref)
              : undefined,
          }, policy, options.signal);
        }
        // Revalidate after attachment I/O and durable state writes, immediately
        // before dispatch; a changed route must not receive an old image.
        await store.activate(options.sessionId, carriers[0].sha256);
        abortIfNeeded(options.signal);
        if (typeof imageVerifier?.captureDispatchGuard !== 'function') throw new Error('history switch dispatch guard unavailable');
        const dispatchGuard = imageVerifier.captureDispatchGuard();
        await contract.verifyStream(agent, options, options.signal, true);
        abortIfNeeded(options.signal);
        if (options.messages !== messages || !wireInputsFrozen(options) ||
            messages.some(message => contentHasImage(message.content)) !== hasImages) {
          throw new Error('history switch request changed before dispatch');
        }
        const nested = { ...options, messages, provider: PROVIDER };
        const bound = bindImageVersions(nested, versions, dispatchGuard);
        // A later llm/stream hook must not reroute this bound request or
        // replace its authenticated message history before adapter selection.
        Object.freeze(bound.options);
        try { yield* ctx.llm.stream(bound.options); }
        finally { bound.release(); }
      } finally { versions?.clear(); }
    })();
  });
}
