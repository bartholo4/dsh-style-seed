export const PROVIDER = 'style-seed';
export const SEED_SOURCE = 'dsh-style-seed';
export const HISTORY_REASONING_FIELDS = Object.freeze(['reasoning_content', 'reasoning']);
export const DEFAULTS = Object.freeze({
  enabled: false,
  historyReasoningField: 'reasoning_content',
  seedPath: '',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'STYLE_SEED_API_KEY',
  model: 'deepseek-v4.1-flash',
  displayName: 'History template (experimental)',
  contextWindow: 1_000_000,
  maxOutputTokens: 32_768,
  maxSeedBytes: 65_536,
  reasoningEffort: 'max',
  streamIdleTimeoutMs: 60_000,
});

export class SeedError extends Error {
  constructor(message, code = 'INVALID_REQUEST', facts = {}) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
    this.facts = facts;
  }
}

export function validateHistoryReasoningField(field) {
  if (!HISTORY_REASONING_FIELDS.includes(field)) throw new SeedError('Unsupported history reasoning field', 'INVALID_CONFIG');
  return field;
}
