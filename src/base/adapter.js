import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { DEFAULTS, PROVIDER, SeedError } from './constants.js';
import { buildWireRequest } from './wire.js';
import { streamCompletion } from './stream.js';
import { imageVersionsFor, dispatchGuardFor } from './image-context.js';

export class HistoryTemplateAdapter extends LlmAdapter {
  constructor(config, dependencies) {
    super();
    this.config = Object.freeze({ ...DEFAULTS, ...config });
    this.dependencies = dependencies;
  }
  providerInfo(provider) { return { id: provider, name: this.config.displayName }; }
  async listModels(provider) { return [await this.resolveModel(provider, this.config.model)]; }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted();
    if (provider !== PROVIDER || model !== this.config.model) throw new LlmError('Unknown history-template route', 'INVALID_MODEL');
    return {
      provider, id: model, name: `${this.config.displayName} · ${model}`,
      inputModalities: ['text', 'image'],
      // Reserve an upper byte bound because the carrier source is outside the core token meter.
      context: { contextWindow: this.config.contextWindow - this.config.maxSeedBytes },
      reasoning: { efforts: ['low', 'high', 'max'].map((id) => ({ id, name: id })), defaultEffort: this.config.reasoningEffort },
      defaultMaxTokens: this.config.maxOutputTokens,
    };
  }
  async *stream(options) {
    try {
      const wire = buildWireRequest(options, this.config, imageVersionsFor(options));
      const key = await this.dependencies.resolveApiKey();
      options.signal?.throwIfAborted();
      this.dependencies.observeSurface?.(options);
      yield* streamCompletion(wire, this.config, {
        fetch: this.dependencies.fetch,
        signal: options.signal,
        beforeDispatch: dispatchGuardFor(options),
        headers: { authorization: `Bearer ${key}`, ...attributionHeaders() },
      });
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof SeedError) throw new LlmError(error.message, error.code, error.facts);
      if (options.signal?.aborted) throw new LlmError('History provider request was cancelled', 'ABORTED');
      throw new LlmError('History provider request failed', 'INVALID_REQUEST');
    }
  }
}
