// Only the selected history adapter expands the reference. The durable session
// and outer middleware never receive the template via this adapter.
import { HistoryTemplateAdapter } from './base/adapter.js';
import { fingerprintSeed, seedCarrierSource, validateSeed } from './base/seed.js';
import { DEFAULTS } from './base/constants.js';
import { createBindingVerifier } from './binding.mjs';

export class ReferenceHistoryAdapter extends HistoryTemplateAdapter {
  // Internal route only: resolveModel remains available for nested calls, but
  // ordinary model selection should not advertise a duplicate model entry.
  async listModels() { return []; }
  constructor(target, dependencies, loadPrivateSeed, codec, firstOnly = undefined) {
    const fields = ['provider', 'model', 'baseURL', 'apiKeyEnv', 'reasoningEffort', 'maxTokens'];
    if (!target || !Object.isFrozen(target) || Object.keys(target).length !== fields.length ||
        fields.some(field => !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(target, field) ?? {}, 'value')) ||
        fields.filter(field => field !== 'maxTokens').some(field => typeof target[field] !== 'string' || !target[field]) ||
        !Number.isSafeInteger(target.maxTokens) || target.maxTokens < 1 || typeof dependencies?.resolveCredential !== 'function' ||
        Object.prototype.hasOwnProperty.call(dependencies, 'resolveApiKey')) throw new Error('history switch binding target invalid');
    const { resolveCredential, ...otherDependencies } = dependencies;
    super({ ...DEFAULTS, model: target.model, baseURL: target.baseURL, apiKeyEnv: target.apiKeyEnv,
      maxOutputTokens: target.maxTokens, reasoningEffort: target.reasoningEffort, historyReasoningField: 'reasoning' },
    { ...otherDependencies, resolveApiKey: async () => resolveCredential(target.apiKeyEnv) });
    Object.defineProperty(this, 'boundTarget', { value: target, writable: false, configurable: false, enumerable: true });
    Object.defineProperty(this, 'config', { value: this.config, writable: false, configurable: false, enumerable: true });
    Object.freeze(this.dependencies);
    Object.defineProperty(this, 'dependencies', { value: this.dependencies, writable: false, configurable: false, enumerable: true });
    if (typeof loadPrivateSeed !== 'function') throw new TypeError('history switch private seed loader required');
    if (!codec || typeof codec.read !== 'function') throw new Error('reference codec unavailable');
    Object.defineProperty(this, 'loadPrivateSeed', { value: loadPrivateSeed, writable: false, configurable: false });
    Object.defineProperty(this, 'referenceCodec', { value: codec, writable: false, configurable: false });
    if (firstOnly !== undefined && (!firstOnly || typeof firstOnly.completed !== 'function' ||
        typeof firstOnly.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(firstOnly.sha256)))
      throw new Error('history switch first-turn policy invalid');
    Object.defineProperty(this, 'firstOnly', { value: firstOnly, writable: false, configurable: false });
  }
  async *stream(options) {
    const refs = options.messages.map(message => this.referenceCodec.read(message, options.sessionId)).filter(Boolean);
    if (refs.length !== 1 || refs[0].ownerSessionId !== options.sessionId) throw new Error('history switch reference ownership invalid');
    options.signal?.throwIfAborted();
    let loaded;
    try { loaded = await this.loadPrivateSeed(options.signal, refs[0].sha256); }
    catch { throw new Error('history switch private template unavailable'); }
    options.signal?.throwIfAborted();
    const template = validateSeed(loaded?.template, this.config.maxSeedBytes);
    const sha256 = fingerprintSeed(template);
    if (sha256 !== refs[0].sha256 || loaded?.sha256 !== sha256) throw new Error('history switch private template changed');
    // The authenticated carrier stays in the durable session for recovery.
    // Only its provider-bound expansion disappears after a completed reply.
    const omit = this.firstOnly?.sha256 === sha256 && this.firstOnly.completed(options.sessionId);
    const transient = options.messages.flatMap(message => {
      if (!this.referenceCodec.read(message, options.sessionId)) return [message];
      return omit ? [] : [{ ...message, source: seedCarrierSource({ template, sha256 }, options.sessionId) }];
    });
    // Only the bound target adapter receives the transient expansion.
    yield* super.stream({ ...options, messages: transient });
  }
}

// Both verifier and target adapter are created from precisely the same frozen
// target, so no second endpoint or credential reference can be configured here.
export function createBoundComponents(ctx, target, credentialRef, dependencies, loadPrivateSeed, codec, firstOnly = undefined) {
  const adapter = new ReferenceHistoryAdapter(target, dependencies, loadPrivateSeed, codec, firstOnly);
  const verifier = createBindingVerifier(ctx, target, credentialRef);
  return Object.freeze({ target, verifier, adapter });
}
