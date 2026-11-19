import { isAgentLoopRequest, callConfigEquals } from '@deepseek-ai/dsh-llm';
import { fingerprintSeed, validateSeed } from './base/seed.js';
import { DEFAULTS } from './base/constants.js';
import { estimateBudgetTokens } from './budget.mjs';
import { isEligibleTopLevel, isInheritableChild, findInheritedParentAdmission } from './eligibility.mjs';
import { findSeedInsertionIndex, sidecarNeedsSeed, sidecarFirstReplyCompleted } from './message-kind.mjs';
import { selectedRouteSnapshot, assertSameRouteSnapshot, seedMessages, restoreLegacyReasoning, preserveToolImages } from './selected-route.mjs';

export { sidecarNeedsSeed, sidecarFirstReplyCompleted };

const cancel = signal => { if (signal?.aborted) throw new Error('weneed开关请求已取消'); };
const routeConfig = options => Object.fromEntries(['provider','model','reasoningEffort','temperature','maxTokens','stop']
  .filter(key => options[key] !== undefined).map(key => [key,options[key]]));

// The carrier is the only durable addition. Each request is projected to a
// bound, one-use native DSH prepared call; no base URL or API key is copied.
export function installSelectedStream(ctx, {
  codec, store, registry, firstOnly, routeByAgent, topology,
  reseedAfterCompaction = true, inheritToChildren = false,
  seedReasoningPlacement = 'native', keepSeedPrefix = false, audit,
}) {
  const log = entry => { try { audit?.record?.(entry); } catch {} };
  return ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next();
    const agent = ctx.agents.get(options.sessionId);

    // Optional inheritance for child/subagent/team sessions whose top-level
    // ancestor explicitly enabled sidecar-only weneed. Always degrades
    // gracefully to next() if the child's route, modalities, or budget differ.
    if (!isEligibleTopLevel(agent)) {
      if (!inheritToChildren || !isInheritableChild(agent)) return next();
      const inherited = findInheritedParentAdmission(ctx, agent, store);
      if (!inherited) return next();
      const childSeedState = sidecarNeedsSeed(agent.session.snapshotEvents(), { reseedAfterCompaction, keepSeedPrefix });
      if (!childSeedState.needed) {
        log({ event: 'skip', reason: 'child-cycle-completed', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: options.messages?.length ?? 0 });
        return next();
      }
      if (!Object.isFrozen(options) || !Object.isFrozen(options.messages)) return next();
      const childPosition = findSeedInsertionIndex(options.messages, { afterLastCompaction: childSeedState.afterCompaction });
      if (childPosition < 0) {
        log({ event: 'skip', reason: 'child-no-task', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: options.messages.length });
        return next();
      }
      let held;
      try { held = selectedRouteSnapshot(ctx, routeConfig(options)); } catch { held = undefined; }
      if (!held || !['openai-completions', 'deepseek-messages'].includes(held.api) || held.thinkingAsText) {
        log({ event: 'skip', reason: 'child-route-unsupported', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held?.api ?? null, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: options.messages.length });
        return next();
      }
      const originalMessages = options.messages;
      return (async function* () {
        cancel(options.signal);
        let prepared;
        try {
          prepared = await ctx.llm.prepareCall(routeConfig(options), options.signal);
        } catch {
          log({ event: 'skip', reason: 'child-prepare-failed', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        cancel(options.signal);
        if (!callConfigEquals(prepared.config, options)) {
          log({ event: 'skip', reason: 'child-config-changed', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        try { assertSameRouteSnapshot(ctx, held); } catch {
          log({ event: 'skip', reason: 'child-route-changed', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        const images = originalMessages.flatMap(message => message.content.filter(block => block.type === 'image'));
        if (images.some(block => block.offloaded === true) || (images.length && !prepared.inputModalities?.includes('image'))) {
          log({ event: 'skip', reason: 'child-image-unsupported', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        let template;
        try {
          const loaded = await registry.read(options.signal, inherited.admission.sha256);
          cancel(options.signal);
          template = validateSeed(loaded?.template, DEFAULTS.maxSeedBytes);
          if (loaded?.sha256 !== inherited.admission.sha256 || fingerprintSeed(template) !== inherited.admission.sha256) throw new Error('seed mismatch');
        } catch {
          log({ event: 'skip', reason: 'child-seed-unavailable', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        const context = prepared.context?.contextWindow;
        const seedBytes = Buffer.byteLength(JSON.stringify(template), 'utf8');
        const estimated = context !== undefined ? estimateBudgetTokens(options, context, seedBytes) : null;
        if (context !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || estimated === null || estimated >= context)) {
          log({ event: 'skip', reason: 'child-budget-exceeded', sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: childSeedState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length, estimatedTokens: estimated, contextWindow: context });
          yield* next();
          return;
        }
        const route = { provider: options.provider, model: options.model };
        const field = held.reasoningContent ? 'reasoning_content' : 'reasoning';
        const auditField = seedReasoningPlacement === 'native' ? field : 'content';
        let projected = [...originalMessages.slice(0, childPosition), ...seedMessages(template, route, field, held.api, seedReasoningPlacement), ...originalMessages.slice(childPosition)];
        if (held.api === 'openai-completions') projected = preserveToolImages(projected);
        cancel(options.signal);
        if (options.messages !== originalMessages || !Object.isFrozen(originalMessages)) { yield* next(); return; }
        const childReason = childSeedState.afterCompaction
          ? (childSeedState.keptPrefix ? 'child-post-compaction-keep-prefix' : 'child-post-compaction')
          : (childSeedState.keptPrefix ? 'child-keep-prefix' : 'child-inherited');
        log({ event: 'inject', reason: childReason, sessionId: options.sessionId, inheritedFrom: inherited.parentSessionId, provider: options.provider, model: options.model, api: held.api, field: auditField, placement: seedReasoningPlacement, keepPrefix: keepSeedPrefix, includeSeed: true, afterCompaction: childSeedState.afterCompaction, messageCount: originalMessages.length, estimatedTokens: estimated, contextWindow: context ?? null });
        const nested = Object.freeze({ ...options, messages: Object.freeze(projected) });
        yield* prepared.stream(nested);
      })();
    }

    const carriers = options.messages.map(message => codec.read(message, options.sessionId)).filter(Boolean);
    const admission = store.get(options.sessionId);
    const sidecarOnly = admission?.mode === 'sidecar-only';
    let sidecarState = { needed: true, afterCompaction: false };
    if (sidecarOnly) {
      if (admission.owner !== options.sessionId || carriers.length || !['pending', 'active', 'disabled'].includes(admission.state))
        throw new Error('weneed开关的会话记录不匹配');
      // No hidden message was ever added to this session. Off or a completed
      // turn in the current cycle (when keepSeedPrefix is false) can use the
      // original DSH prepared route directly.
      sidecarState = sidecarNeedsSeed(agent.session.snapshotEvents(), { reseedAfterCompaction, keepSeedPrefix });
      if (admission.state === 'disabled' || !sidecarState.needed) {
        log({ event: 'skip', reason: admission.state === 'disabled' ? 'disabled' : 'cycle-completed', sessionId: options.sessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: options.messages?.length ?? 0 });
        return next();
      }
      if ((sidecarState.afterCompaction || sidecarState.keptPrefix) && findSeedInsertionIndex(options.messages, { afterLastCompaction: sidecarState.afterCompaction }) < 0) {
        const skipPrefix = sidecarState.afterCompaction ? 'post-compaction' : 'keep-prefix';
        log({ event: 'skip', reason: `${skipPrefix}-no-task`, sessionId: options.sessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: options.messages?.length ?? 0 });
        return next();
      }
    }
    const disabledWithoutCarrier = !carriers.length && admission?.state === 'disabled';
    // If no carrier remains and the route has no inspectable settings, a
    // disabled session can use the original prepared request untouched.
    if (disabledWithoutCarrier && !routeByAgent.get(agent)?.snapshot) return next();
    if (!carriers.length && !disabledWithoutCarrier && !sidecarOnly) {
      if (admission && ['pending', 'active'].includes(admission.state)) throw new Error('weneed开关历史引用不在当前上下文');
      return next();
    }
    if (!admission || admission.owner !== options.sessionId ||
        (!sidecarOnly && !disabledWithoutCarrier && (carriers.length !== 1 || admission.sha256 !== carriers[0].sha256)) ||
        !['pending', 'active', 'disabled'].includes(admission.state)) {
      throw new Error('weneed开关的会话记录不匹配');
    }
    if (!Object.isFrozen(options) || !Object.isFrozen(options.messages)) throw new Error('weneed开关的请求状态未固定');
    const originalMessages = options.messages;
    return (async function* () {
      cancel(options.signal);
      const includeSeed = sidecarOnly || (admission.state !== 'disabled' &&
        !(firstOnly?.sha256 === admission.sha256 && firstOnly.completed(options.sessionId)));
      const gracefulSkip = sidecarOnly && (sidecarState.afterCompaction || sidecarState.keptPrefix === true);
      const skipPrefix = sidecarState.afterCompaction ? 'post-compaction' : 'keep-prefix';
      const entry = routeByAgent.get(agent);
      if (entry && (entry.route?.provider !== options.provider || entry.route?.model !== options.model)) {
        if (gracefulSkip) {
          log({ event: 'skip', reason: `${skipPrefix}-route-changed`, sessionId: options.sessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        throw new Error('所选模型在请求准备期间发生变化，请重试');
      }
      const checkTopology = () => {
        if (!entry || entry.topologyRevision !== topology?.revision ||
          entry.settingsRevision !== topology?.settingsRevision) throw new Error('模型服务在请求准备期间发生变化，请重试');
      };
      if (gracefulSkip) {
        try { checkTopology(); } catch {
          log({ event: 'skip', reason: `${skipPrefix}-topology-changed`, sessionId: options.sessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
      } else checkTopology();
      const held = entry?.snapshot;
      if (!held || held.provider !== options.provider || held.model !== options.model) {
        if (gracefulSkip) {
          log({ event: 'skip', reason: `${skipPrefix}-snapshot-unavailable`, sessionId: options.sessionId, provider: options.provider, model: options.model, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        throw new Error('weneed开关无法确认所选模型的服务配置；请新建会话并保持开关关闭');
      }
      if (gracefulSkip) {
        try { assertSameRouteSnapshot(ctx, held); } catch {
          log({ event: 'skip', reason: `${skipPrefix}-snapshot-changed`, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
      } else assertSameRouteSnapshot(ctx, held);
      if (includeSeed) {
        if (!['openai-completions', 'deepseek-messages'].includes(held.api) || held.thinkingAsText) {
          if (gracefulSkip) {
            log({ event: 'skip', reason: `${skipPrefix}-route-unsupported`, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
            yield* next();
            return;
          }
          throw new Error('weneed开关暂不支持所选服务的接口格式；请关闭开关后继续');
        }
      }
      const prepared = await ctx.llm.prepareCall(routeConfig(options), options.signal);
      cancel(options.signal);
      checkTopology();
      if (!callConfigEquals(prepared.config, options)) throw new Error('所选模型的请求参数在准备期间发生变化，请重试');
      assertSameRouteSnapshot(ctx, held);
      const images = originalMessages.flatMap(message => message.content.filter(block => block.type === 'image'));
      if (admission.state !== 'disabled' && (images.some(block => block.offloaded === true) || (images.length && !prepared.inputModalities?.includes('image')))) {
        if (gracefulSkip) {
          log({ event: 'skip', reason: `${skipPrefix}-image-unsupported`, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length });
          yield* next();
          return;
        }
        throw new Error('所选模型无法完整接收图片；请检查图片或关闭weneed开关');
      }
      let template;
      let estimated = null;
      const context = prepared.context?.contextWindow;
      if (includeSeed) {
        const loaded = await registry.read(options.signal, admission.sha256);
        cancel(options.signal);
        template = validateSeed(loaded?.template, DEFAULTS.maxSeedBytes);
        if (loaded?.sha256 !== admission.sha256 || fingerprintSeed(template) !== admission.sha256) throw new Error('weneed开关历史样例不可用');
        if (context !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
          if (gracefulSkip) {
            log({ event: 'skip', reason: `${skipPrefix}-max-tokens-missing`, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length, contextWindow: context });
            yield* next();
            return;
          }
          throw new Error('weneed开关无法确认输出 token 上限；请在所选模型配置中设置 maxTokens 后重试，或关闭开关');
        }
        const seedBytes = Buffer.byteLength(JSON.stringify(template), 'utf8');
        estimated = context !== undefined ? estimateBudgetTokens(options, context, seedBytes) : null;
        if (context !== undefined && (estimated === null || estimated >= context)) {
          if (gracefulSkip) {
            log({ event: 'skip', reason: `${skipPrefix}-budget-exceeded`, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: sidecarState.afterCompaction, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length, estimatedTokens: estimated, contextWindow: context });
            yield* next();
            return;
          }
          log({ event: 'reject', reason: 'budget-exceeded', sessionId: options.sessionId, provider: options.provider, model: options.model, api: held.api, includeSeed: false, afterCompaction: false, keepPrefix: keepSeedPrefix, messageCount: originalMessages.length, estimatedTokens: estimated, contextWindow: context });
          throw new Error('weneed开关的会话上下文已满');
        }
        assertSameRouteSnapshot(ctx, held);
        checkTopology();
        await store.activate(options.sessionId, admission.sha256);
        cancel(options.signal);
        assertSameRouteSnapshot(ctx, held);
        checkTopology();
      }
      const current = store.get(options.sessionId);
      if (!current || current.owner !== admission.owner || current.sha256 !== admission.sha256 ||
          (includeSeed && current.state !== 'active') || (!includeSeed && current.state !== admission.state)) {
        throw new Error('weneed开关在请求准备期间发生变化，请重试');
      }
      const route = { provider: options.provider, model: options.model };
      const field = held?.reasoningContent ? 'reasoning_content' : 'reasoning';
      const auditField = seedReasoningPlacement === 'native' ? field : 'content';
      let projected;
      if (sidecarOnly) {
        const position = findSeedInsertionIndex(originalMessages, { afterLastCompaction: sidecarState.afterCompaction });
        if (position < 0) throw new Error('weneed开关找不到当前用户消息');
        projected = [...originalMessages.slice(0, position), ...seedMessages(template, route, field, held.api, seedReasoningPlacement), ...originalMessages.slice(position)];
      } else projected = originalMessages.flatMap(message => {
        const reference = codec.read(message, options.sessionId);
        if (!reference) return [message];
        return includeSeed ? seedMessages(template, route, field, held.api, seedReasoningPlacement) : [];
      });
      if (held?.api === 'openai-completions') {
        // New sidecar sessions contain native host history, including canceled
        // reasoning-only partials. Do not mistake those for .12 imports or
        // invent successful replay metadata for an interrupted response.
        if (!sidecarOnly) projected = restoreLegacyReasoning(projected, route, field);
        if (admission.state !== 'disabled') projected = preserveToolImages(projected);
      }
      cancel(options.signal);
      if (options.messages !== originalMessages || !Object.isFrozen(originalMessages)) throw new Error('请求消息在准备期间发生变化');
      assertSameRouteSnapshot(ctx, held);
      checkTopology();
      const injectReason = sidecarOnly
        ? (sidecarState.afterCompaction
          ? (sidecarState.keptPrefix ? 'post-compaction-keep-prefix' : 'post-compaction')
          : (sidecarState.keptPrefix ? 'keep-prefix' : 'first-turn'))
        : (includeSeed ? 'legacy-seed' : 'legacy-pass');
      log({ event: includeSeed ? 'inject' : 'pass', reason: injectReason, sessionId: options.sessionId, provider: options.provider, model: options.model, api: held?.api ?? null, field: auditField, placement: seedReasoningPlacement, keepPrefix: keepSeedPrefix, includeSeed, afterCompaction: sidecarState.afterCompaction, messageCount: originalMessages.length, estimatedTokens: estimated, contextWindow: context ?? null });
      const nested = Object.freeze({ ...options, messages: Object.freeze(projected) });
      yield* prepared.stream(nested);
    })();
  });
}

export function installSelectedAgent(ctx, agent, selection, contract, codec, store, seedIdentity, routeByAgent, topology, runtimeCtx = ctx) {
  let candidate = false;
  const stopPre = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    await contract.waitPending(agent, payload.signal); cancel(payload.signal);
    const prior = agent.session.snapshotEvents().some(event => ['user/message', 'assistant/message', 'request/header'].includes(event.type));
    candidate = !prior && contract.get(agent.id).enabled;
    if (!candidate) return decision;
    if (!selection.assembled?.provider || !selection.assembled?.model) throw new Error('weneed开关无法确认所选模型');
    await store.arm(agent.id, seedIdentity.sha256, 'sidecar-only'); cancel(payload.signal);
    return decision;
  }, { prepend: true });
  const stopRequest = ctx.on('agent/request', async (payload, next) => {
    const result = await contract.request(agent, payload, async () => {
      const route = await next(); selection.recordResolved(route); return route;
    }, candidate);
    if (candidate && (!result.ready || result.route?.provider !== selection.assembled?.provider || result.route?.model !== selection.assembled?.model))
      throw new Error('weneed开关的模型选择发生变化，请重试');
    const admission = store.get(agent.id);
    let snapshot;
    if (admission && ['pending', 'active', 'disabled'].includes(admission.state)) {
      // Some non-configurable routes can still continue normally once the
      // first-turn sample is no longer needed, or after the switch is off.
      // Only seed injection requires a verified compatible route snapshot.
      try { snapshot = selectedRouteSnapshot(runtimeCtx, result.route); } catch { snapshot = undefined; }
    }
    routeByAgent.set(agent, { route: result.route, snapshot, topologyRevision: topology.revision, settingsRevision: topology.settingsRevision });
    return result.route;
  }, { prepend: true });
  return () => { stopPre(); stopRequest(); routeByAgent.delete(agent); };
}
