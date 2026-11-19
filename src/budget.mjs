import { DEFAULTS } from './base/constants.js';

const ESTIMATED_BYTES_PER_TOKEN = 3;
const ITEM_FRAMING_TOKENS = 16;

// Conservative byte-based preflight, not a provider tokenizer or a guarantee
// about remote truncation. Strip non-wire metadata and binary/base64 image
// payloads (images are budgeted separately at 1024 tokens each), convert UTF-8
// text bytes with a conservative ~3 bytes/token bound, and cap the preflight
// output reservation so models configured with maxTokens near or equal to
// contextWindow do not falsely trip during multi-step first turns.
export function estimateBudgetTokens(options, contextWindow, seedReserve = DEFAULTS.maxSeedBytes) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(seedReserve) || seedReserve < 0 ||
      !Number.isSafeInteger(options?.maxTokens) || options.maxTokens <= 0 || !Array.isArray(options.messages)) return null;
  try {
    const tools = options.tools ?? [];
    if (!Array.isArray(tools)) return null;
    let blocks = 0, images = 0, repeatedToolTextBytes = 0;
    const wireMessages = [];
    for (const message of options.messages) {
      if (!Array.isArray(message?.content)) return null;
      blocks += message.content.length;
      const wireContent = [];
      let messageHasImage = false;
      for (const block of message.content) {
        if (block?.type === 'image') {
          images++;
          messageHasImage = true;
          wireContent.push({ type: 'image' });
        } else {
          wireContent.push(block);
        }
      }
      if (message.role === 'tool' && messageHasImage) {
        for (const block of message.content) if (block?.type === 'text' && typeof block.text === 'string') {
          repeatedToolTextBytes += Buffer.byteLength(block.text, 'utf8');
        }
      }
      const { source: _source, ...wireMessage } = message;
      wireMessages.push({ ...wireMessage, content: wireContent });
    }
    const visible = JSON.stringify({ messages: wireMessages, system: options.system, tools, toolHistory: options.toolHistory, stop: options.stop });
    const textTokens = Math.ceil((Buffer.byteLength(visible, 'utf8') + repeatedToolTextBytes + seedReserve) / ESTIMATED_BYTES_PER_TOKEN);
    const outputReserve = Math.min(options.maxTokens, Math.floor(contextWindow / 4));
    const framingTokens = 1024 + ITEM_FRAMING_TOKENS * 32 + ITEM_FRAMING_TOKENS * (options.messages.length + tools.length + blocks);
    const estimate = textTokens + outputReserve + images * 1024 + framingTokens;
    return Number.isSafeInteger(estimate) ? estimate : null;
  } catch { return null; }
}

export function withinEstimatedBudget(options, contextWindow, seedReserve = DEFAULTS.maxSeedBytes) {
  const estimate = estimateBudgetTokens(options, contextWindow, seedReserve);
  return estimate !== null && estimate < contextWindow;
}
