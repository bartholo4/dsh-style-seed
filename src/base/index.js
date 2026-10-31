import z from '@deepseek-ai/schemastery';
import { LlmError, assertUsableApiKey, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DEFAULTS, PROVIDER, SEED_SOURCE } from './constants.js';
import { HistoryTemplateAdapter } from './adapter.js';
import { eligibleNewSession, createFirstRequestHook } from './lifecycle.js';

export const name = 'dsh-style-seed';
export const inject = ['llm'];
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  historyReasoningField: z.union(['reasoning_content', 'reasoning']).default(DEFAULTS.historyReasoningField),
  seedPath: z.string().default(DEFAULTS.seedPath),
  baseURL: z.string().default(DEFAULTS.baseURL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULTS.apiKeyEnv),
  model: z.string().default(DEFAULTS.model),
  displayName: z.string().default(DEFAULTS.displayName),
  contextWindow: z.number().step(1).min(8192).default(DEFAULTS.contextWindow),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULTS.maxOutputTokens),
  maxSeedBytes: z.number().step(1).min(1024).max(262144).default(DEFAULTS.maxSeedBytes),
  reasoningEffort: z.union(['low', 'high', 'max']).default(DEFAULTS.reasoningEffort),
  streamIdleTimeoutMs: z.number().step(1).min(1000).max(3600000).default(DEFAULTS.streamIdleTimeoutMs),
});

export function apply(ctx, supplied) {
  const config = { ...DEFAULTS, ...supplied };
  if (!config.enabled) return;
  let endpoint;
  try { endpoint = new URL(config.baseURL); } catch { throw new LlmError('Invalid history provider baseURL', 'INVALID_CONFIG'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new LlmError('History provider requires HTTPS or a loopback HTTP endpoint without embedded credentials', 'INVALID_CONFIG');
  }
  if (config.contextWindow <= config.maxSeedBytes + config.maxOutputTokens) throw new LlmError('Context window must leave room after template and output reservations', 'INVALID_CONFIG');
  if (!config.model || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.apiKeyEnv)) throw new LlmError('Invalid model or credential reference', 'INVALID_CONFIG');
  const warned = new Set(), listeners = new Map(), lifetime = new AbortController();
  const adapter = new HistoryTemplateAdapter(config, {
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials');
      const raw = credentials ? (await credentials.resolve(config.apiKeyEnv))?.value : launchEnvironmentOf(ctx).get(config.apiKeyEnv)?.value;
      if (raw === undefined) throw new LlmError('History provider credential reference is unavailable', 'MISSING_CREDENTIAL');
      return assertUsableApiKey(raw, name, config.apiKeyEnv);
    },
    observeSurface: (options) => {
      if (!options.sessionId || warned.has(options.sessionId) || options.messages.some((message) => message.source?.kind === SEED_SOURCE)) return;
      const session = ctx.get('sessions')?.get(options.sessionId);
      if (session?.snapshotEvents().some((event) => event.type === 'user/message' && event.data.source?.kind === SEED_SOURCE)) {
        warned.add(options.sessionId);
        ctx.logger.warn('History template left the visible context (for example after compaction); no template was reinserted.');
      }
    },
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.on('agent/created', ({ agent, source }) => {
    if (!eligibleNewSession(agent, source) || listeners.has(agent.id)) return;
    const callback = createFirstRequestHook(agent, config, { createSystemMessage, createUserMessage, lifecycleSignal: lifetime.signal });
    const stop = agent.ctx.on('agent/request', callback, { prepend: true });
    listeners.set(agent.id, stop);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    listeners.get(agent.id)?.(); listeners.delete(agent.id); warned.delete(agent.id);
  });
  ctx.on('dispose', () => {
    lifetime.abort();
    for (const stop of listeners.values()) stop();
    listeners.clear(); warned.clear();
  });
}
