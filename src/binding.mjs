// Isolated, fail-closed route binding candidate. Never log descriptor values:
// even a redacted descriptor can contain sensitive custom header strings.
import { isDeepStrictEqual } from 'node:util';

const validObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const definedKeys = value => Object.keys(value).filter(key => value[key] !== undefined);
const safeText = value => typeof value === 'string' && value.length > 0;
const safeNat = value => Number.isSafeInteger(value) && value > 0;
const only = (obj, allowed) => definedKeys(obj).every(key => allowed.has(key));
const PROFILE_FIELDS = new Set(['apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'headers', 'streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes', 'compat', 'modelOverrides', 'thinkingBudgets']);
const MODEL_FIELDS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']);
// SettingsForms may materialize nested empty objects from schemas. Empty arrays,
// scalar flags and non-empty values remain explicit and are rejected.
const blankTree = value => value === undefined || (validObject(value) && Object.values(value).every(blankTree));

export class BindingError extends Error {
  constructor(code) { super(`Route compatibility check failed (${code})`); this.name = 'BindingError'; this.code = code; }
}
function reject(code) { throw new BindingError(code); }
function checkAbort(signal) { if (signal?.aborted) reject('ABORTED'); }

/**
 * target: { provider, model, baseURL, apiKeyEnv, reasoningEffort, maxTokens }.
 * ctx services must be the live rc.3 services; credentialRef is the official
 * @deepseek-ai/dsh-credentials converter, injected to enable offline tests.
 * No endpoint, credential reference, config or headers are returned in tickets.
 */
export function createBindingVerifier(ctx, target, credentialRef) {
  if (!validObject(target) || !safeText(target.provider) || !safeText(target.model) ||
      !safeText(target.baseURL) || !safeText(target.apiKeyEnv) ||
      !safeText(target.reasoningEffort) || !safeNat(target.maxTokens) || typeof credentialRef !== 'function') reject('INVALID_TARGET');
  const expected = Object.freeze({ provider: target.provider, model: target.model, baseURL: target.baseURL,
    apiKeyEnv: target.apiKeyEnv, reasoningEffort: target.reasoningEffort, maxTokens: target.maxTokens });
  let endpoint;
  try { endpoint = new URL(expected.baseURL); } catch { reject('INVALID_TARGET'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) reject('INVALID_TARGET');
  const issued = new WeakMap();
  let invalidation = 0;
  let disposed = false;
  const stop = typeof ctx.on === 'function' ? ctx.on('settings/updated', () => { invalidation++; }) : undefined;
  const stopCredential = typeof ctx.on === 'function' ? ctx.on('credentials/reference-updated', ref => {
    if (ref === expected.apiKeyEnv) invalidation++;
  }) : undefined;

  function readSnapshot() {
    if (disposed) reject('DISPOSED');
    if (typeof ctx.llm?.listConfigurableProviders !== 'function' || typeof ctx.settings?.describe !== 'function') reject('SERVICE_UNAVAILABLE');
    const candidates = ctx.llm.listConfigurableProviders().filter(item => item?.provider === expected.provider);
    if (candidates.length !== 1) reject('DIRECTORY');
    const directory = candidates[0];
    if (directory.declared !== true || !safeText(directory.settingsNs) || !Array.isArray(directory.settingsPath) ||
        directory.settingsPath.length === 0 || directory.settingsPath.some(item => !safeText(item)) || directory.error !== undefined) reject('DIRECTORY');
    const docs = ctx.settings.describe({ redactSecrets: true });
    if (!Array.isArray(docs)) reject('SETTINGS_UNAVAILABLE');
    const matches = docs.filter(doc => doc?.ns === directory.settingsNs);
    if (matches.length !== 1) reject('SETTINGS_NAMESPACE');
    const doc = matches[0];
    if (!Number.isSafeInteger(doc.revision) || doc.revision < 0) reject('SETTINGS_REVISION');
    let profile = doc.value;
    for (const part of directory.settingsPath) {
      if (!validObject(profile) || !Object.prototype.hasOwnProperty.call(profile, part)) reject('PROFILE');
      profile = profile[part];
    }
    if (!validObject(profile)) reject('UNSUPPORTED_PROFILE');
    if (profile.headers !== undefined && (!validObject(profile.headers) || Object.keys(profile.headers).length !== 0)) reject('CUSTOM_HEADERS');
    if (!only(profile, PROFILE_FIELDS) || !['compat', 'modelOverrides', 'thinkingBudgets'].every(key => blankTree(profile[key]))) reject('UNSUPPORTED_PROFILE');
    if (profile.api !== 'openai-completions' || profile.baseURL !== expected.baseURL || profile.apiKeyEnv !== expected.apiKeyEnv) reject('ROUTE_MISMATCH');
    if (['streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']
      .some(key => profile[key] !== undefined && !safeNat(profile[key]))) reject('UNSUPPORTED_PROFILE');
    if (!Array.isArray(profile.models)) reject('MODELS');
    const models = profile.models.filter(model => validObject(model) && model.id === expected.model);
    if (models.length !== 1) reject('MODEL_MISMATCH');
    const model = models[0];
    if (!only(model, MODEL_FIELDS) || !blankTree(model.compat)) reject('UNSUPPORTED_MODEL');
    if (!validObject(model.reasoningEfforts) || model.reasoningEfforts[expected.reasoningEffort] !== expected.reasoningEffort ||
        Object.entries(model.reasoningEfforts).some(([key, value]) => !safeText(key) || (value !== null && !safeText(value)))) reject('UNSUPPORTED_REASONING');
    // For a declared route there are no catalog defaults for the selected model.
    const context = model.contextWindow ?? profile.defaultContextWindow;
    const maxTokens = model.maxTokens ?? profile.defaultMaxTokens;
    const input = Array.isArray(model.input) && model.input.length === 0 ? profile.defaultInput : model.input ?? profile.defaultInput;
    if (!safeNat(context) || !safeNat(maxTokens) || expected.maxTokens > maxTokens || expected.maxTokens >= context) reject('MODEL_CAPACITY');
    // Image content is admitted only when both this snapshot and resolved model
    // metadata explicitly advertise it; other unknown modalities stay rejected.
    if (!Array.isArray(input) || !input.includes('text') || new Set(input).size !== input.length ||
        input.some(modality => !['text', 'image'].includes(modality))) reject('UNSUPPORTED_INPUT');
    const digest = {
      directory: { provider: directory.provider, declared: directory.declared, settingsNs: directory.settingsNs, settingsPath: [...directory.settingsPath] },
      revision: doc.revision,
      // These fields stay in closure memory; no headers or raw profile are retained.
      baseURL: profile.baseURL, apiKeyEnv: profile.apiKeyEnv, api: profile.api,
      model: { id: model.id, context, maxTokens, input: [...input], reasoningWire: model.reasoningEfforts[expected.reasoningEffort] },
      options: Object.fromEntries(['streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes']
        .filter(key => profile[key] !== undefined).map(key => [key, profile[key]])),
    };
    return digest;
  }

  function snapshot() {
    try { return readSnapshot(); }
    catch (error) { if (error instanceof BindingError) throw error; reject('SETTINGS_LOOKUP_FAILED'); }
  }

  function modelSnapshot(info, expectedContext, expectedInput) {
    if (!validObject(info) || info.provider !== expected.provider || info.id !== expected.model ||
        info.context?.contextWindow !== expectedContext ||
        !Array.isArray(info.inputModalities) || !isDeepStrictEqual(info.inputModalities, expectedInput) ||
        !Array.isArray(info.reasoning?.efforts) || !info.reasoning.efforts.some(effort => effort.id === expected.reasoningEffort)) reject('MODEL_INFO');
    const effortIds = info.reasoning.efforts.map(item => item?.id);
    if (!effortIds.every(safeText) || new Set(effortIds).size !== effortIds.length ||
        (info.defaultMaxTokens !== undefined && !safeNat(info.defaultMaxTokens)) ||
        (info.reasoning.defaultEffort !== undefined && !safeText(info.reasoning.defaultEffort)) ||
        (info.toolUpdate !== undefined && !['in-history', 'addition-only'].includes(info.toolUpdate)) ||
        (info.systemPromptUpdate !== undefined && info.systemPromptUpdate !== 'in-history')) reject('MODEL_INFO');
    return { provider: info.provider, id: info.id, context: info.context.contextWindow,
      input: [...info.inputModalities], efforts: effortIds, defaultEffort: info.reasoning.defaultEffort,
      defaultMaxTokens: info.defaultMaxTokens, toolUpdate: info.toolUpdate, systemPromptUpdate: info.systemPromptUpdate };
  }

  function requireRoute(route) {
    if (!validObject(route) || route.provider !== expected.provider || route.model !== expected.model) reject('ROUTE_MISMATCH');
  }

  function requireSupportedMessages(messages, imageSupported) {
    if (!Array.isArray(messages)) reject('MESSAGES_UNAVAILABLE');
    const allowed = {
      user: new Set(['text', ...(imageSupported ? ['image'] : [])]), system: new Set(['text']), developer: new Set(['text']),
      assistant: new Set(['text', 'reasoning', 'tool-call']), tool: new Set(['text', ...(imageSupported ? ['image'] : [])]),
    };
    for (const message of messages) {
      if (!validObject(message) || !allowed[message.role] || !Array.isArray(message.content)) reject('UNSUPPORTED_MESSAGE');
      for (const block of message.content) {
        if (!validObject(block) || !allowed[message.role].has(block.type) || (block.type === 'image' && block.offloaded === true)) reject('UNSUPPORTED_MESSAGE');
        if (block.type === 'image' && (!validObject(block.attachment) || !safeText(block.attachment.attachmentId) ||
            !safeNat(block.attachment.width) || !safeNat(block.attachment.height) || !safeNat(block.attachment.bytes) ||
            !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(block.attachment.mediaType))) reject('UNSUPPORTED_MESSAGE');
      }
    }
  }

  function requireFrozenRequest(route) {
    const seen = new WeakSet();
    try {
      if (!validObject(route) || ![Object.prototype, null].includes(Object.getPrototypeOf(route)) || !Object.isFrozen(route)) reject('UNFROZEN_REQUEST');
      for (const name of ['provider', 'model', 'reasoningEffort', 'maxTokens', 'messages']) {
        const property = Object.getOwnPropertyDescriptor(route, name);
        if (!property || !Object.prototype.hasOwnProperty.call(property, 'value')) reject('UNFROZEN_REQUEST');
      }
      const messages = Object.getOwnPropertyDescriptor(route, 'messages').value;
      if (!Array.isArray(messages)) reject('MESSAGES_UNAVAILABLE');
      const stack = [messages];
      while (stack.length) {
        const node = stack.pop();
        if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') reject('UNFROZEN_REQUEST');
        if (node === null || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);
        // Mutable internal-slot objects such as Map remain mutable even if
        // Object.freeze() is used; only frozen arrays/plain records qualify.
        if (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) reject('UNFROZEN_REQUEST');
        if (!Object.isFrozen(node)) reject('UNFROZEN_REQUEST');
        for (const key of Reflect.ownKeys(node)) {
          const property = Object.getOwnPropertyDescriptor(node, key);
          if (!property || !Object.prototype.hasOwnProperty.call(property, 'value')) reject('UNFROZEN_REQUEST');
          stack.push(property.value);
        }
      }
    } catch (error) {
      if (error instanceof BindingError) throw error;
      reject('UNFROZEN_REQUEST');
    }
  }

  async function acquire(route, signal) {
    requireRoute(route);
    checkAbort(signal);
    if (disposed) reject('DISPOSED');
    const before = snapshot();
    // describe() itself can publish initial settings notifications. Those
    // describe the snapshot just obtained, not a later mutation.
    const epoch = invalidation;
    if (typeof ctx.credentials?.describe !== 'function' || typeof ctx.llm?.resolveModelInfo !== 'function') reject('SERVICE_UNAVAILABLE');
    let keyStatus, info;
    try {
      keyStatus = await ctx.credentials.describe(credentialRef(expected.apiKeyEnv));
      checkAbort(signal);
      info = await ctx.llm.resolveModelInfo(expected.provider, expected.model, signal);
    } catch (error) {
      if (signal?.aborted) reject('ABORTED');
      reject('LOOKUP_FAILED'); // Do not copy error text: implementations may contain secrets.
    }
    checkAbort(signal);
    if (keyStatus?.configured !== true) reject('CREDENTIAL_UNAVAILABLE');
    const modelInfo = modelSnapshot(info, before.model.context, before.model.input);
    const after = snapshot();
    if (epoch !== invalidation || !isDeepStrictEqual(before, after)) reject('CONFIG_CHANGED');
    const ticket = Object.freeze(Object.create(null));
    issued.set(ticket, { snapshot: before, modelInfo, epoch });
    return ticket;
  }

  async function verify(ticket, route, signal) {
    const held = issued.get(ticket);
    if (!held) reject('INVALID_TICKET');
    // Single use prevents accidentally reusing a preflight across attempts.
    issued.delete(ticket);
    checkAbort(signal);
    if (disposed) reject('DISPOSED');
    requireFrozenRequest(route);
    requireRoute(route);
    // Called on the final prepared request, not a pre-step draft: never change
    // the user's resolved effort or output budget behind their back.
    if (route.reasoningEffort !== expected.reasoningEffort || !safeNat(route.maxTokens) ||
        route.maxTokens > held.snapshot.model.maxTokens || route.maxTokens >= held.snapshot.model.context) reject('CALL_PARAMETERS');
    requireSupportedMessages(route.messages, held.snapshot.model.input.includes('image'));
    if (held.epoch !== invalidation || !isDeepStrictEqual(held.snapshot, snapshot())) reject('CONFIG_CHANGED');
    let configured, info;
    try {
      configured = await ctx.credentials.describe(credentialRef(expected.apiKeyEnv));
      checkAbort(signal);
      info = await ctx.llm.resolveModelInfo(expected.provider, expected.model, signal);
    }
    catch (error) { if (signal?.aborted) reject('ABORTED'); reject('LOOKUP_FAILED'); }
    checkAbort(signal);
    if (configured?.configured !== true) reject('CREDENTIAL_UNAVAILABLE');
    if (!isDeepStrictEqual(held.modelInfo, modelSnapshot(info, held.snapshot.model.context, held.snapshot.model.input))) reject('MODEL_CHANGED');
    if (held.epoch !== invalidation || !isDeepStrictEqual(held.snapshot, snapshot())) reject('CONFIG_CHANGED');
    requireFrozenRequest(route);
    requireRoute(route);
    if (route.reasoningEffort !== expected.reasoningEffort || !safeNat(route.maxTokens) ||
        route.maxTokens > held.snapshot.model.maxTokens || route.maxTokens >= held.snapshot.model.context) reject('CALL_PARAMETERS');
    requireSupportedMessages(route.messages, held.snapshot.model.input.includes('image'));
    return true;
  }

  // Only non-secret resource budgets leave this closure; verify() will later
  // compare the held snapshot and invalidate any intervening config changes.
  function imagePolicy() {
    const current = snapshot();
    if (!current.model.input.includes('image')) reject('UNSUPPORTED_INPUT');
    return Object.freeze({
      maxPixels: current.options.requestImagePixelBudget ?? 4_194_304,
      maxBytes: current.options.requestImageMaxBytes ?? 1_048_576,
      maxRequestImageBytes: current.options.maxRequestImageBytes ?? 20_971_520,
    });
  }

  // Capture before the last asynchronous verification and check synchronously
  // immediately before fetch, after seed and credential reads have completed.
  function captureDispatchGuard() {
    const held = snapshot();
    const epoch = invalidation;
    return () => {
      if (disposed || epoch !== invalidation || !isDeepStrictEqual(held, snapshot()) || epoch !== invalidation) reject('CONFIG_CHANGED');
    };
  }

  function dispose() { if (!disposed) { disposed = true; invalidation++; if (typeof stop === 'function') stop();
    if (typeof stopCredential === 'function') stopCredential(); } }
  return Object.freeze({ acquire, verify, imagePolicy, captureDispatchGuard, dispose });
}
