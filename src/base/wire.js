import { DEFAULTS, PROVIDER, SeedError, validateHistoryReasoningField } from './constants.js';
import { readSeedCarrier, seedWireMessages } from './seed.js';

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function textContent(blocks) {
  if (!Array.isArray(blocks)) throw new SeedError('Message content must be a block array');
  return blocks.map((block) => {
    if (block?.type !== 'text') throw new SeedError(`Unsupported content block: ${String(block?.type)}`, 'UNSUPPORTED_CONTENT');
    if (typeof block.text !== 'string') throw new SeedError('Invalid text block');
    return block.text;
  }).join('');
}

// Versions are supplied by the caller after durable attachment preparation and
// request-budget checks. Never expose attachment identifiers or bytes in errors.
function imageParts(block, imageVersions) {
  if (block.offloaded === true) throw new SeedError('Offloaded image cannot be sent', 'UNSUPPORTED_CONTENT');
  const attachmentId = block.attachment?.attachmentId;
  if (typeof attachmentId !== 'string' || !attachmentId || !(imageVersions instanceof Map)) {
    throw new SeedError('Image attachment version is unavailable', 'UNSUPPORTED_CONTENT');
  }
  const version = imageVersions.get(attachmentId);
  if (!version || !(version.data instanceof Uint8Array) || version.data.byteLength === 0) {
    throw new SeedError('Image attachment version is unavailable', 'UNSUPPORTED_CONTENT');
  }
  if (!IMAGE_MEDIA_TYPES.has(version.mediaType)) throw new SeedError('Unsupported image media type', 'UNSUPPORTED_CONTENT');
  const handleText = version.handleTextByBlock instanceof WeakMap ? version.handleTextByBlock.get(block) : version.handleText;
  if ((version.handleTextByBlock !== undefined && !(version.handleTextByBlock instanceof WeakMap)) ||
      (version.handleTextByBlock instanceof WeakMap && handleText === undefined) ||
      (handleText !== undefined && typeof handleText !== 'string')) {
    throw new SeedError('Invalid image handle text', 'UNSUPPORTED_CONTENT');
  }
  return [
    ...(handleText === undefined ? [] : [{ type: 'text', text: handleText }]),
    { type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` } },
  ];
}

function multimodalContent(blocks, imageVersions) {
  if (!Array.isArray(blocks)) throw new SeedError('Message content must be a block array');
  const text = [], images = [], content = [];
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (typeof block.text !== 'string') throw new SeedError('Invalid text block');
      text.push(block.text);
      if (block.text) content.push({ type: 'text', text: block.text });
    } else if (block?.type === 'image') {
      const parts = imageParts(block, imageVersions);
      content.push(...parts);
      images.push(...parts);
    } else throw new SeedError(`Unsupported content block: ${String(block?.type)}`, 'UNSUPPORTED_CONTENT');
  }
  return { text: text.join(''), images, content };
}

/** Pure offline API. Preserves order, tools and system context, without touching options. */
export function buildWireRequest(options, supplied = {}, imageVersions = undefined) {
  const config = { ...DEFAULTS, ...supplied };
  const reasoningField = validateHistoryReasoningField(config.historyReasoningField);
  if (options.provider !== undefined && options.provider !== PROVIDER) throw new SeedError('The history adapter only serves its own provider', 'NO_ADAPTER');
  if (options.model !== config.model) throw new SeedError('Unknown history-template model', 'INVALID_MODEL');
  const messages = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  let seedCount = 0;
  let toolImages = [];
  const flushToolImages = () => {
    if (toolImages.length) messages.push({ role: 'user', content: [
      { type: 'text', text: 'Attached image(s) from tool result:' }, ...toolImages,
    ] });
    toolImages = [];
  };
  for (const message of options.messages ?? []) {
    if (message.role !== 'tool') flushToolImages();
    const carrier = readSeedCarrier(message, config.maxSeedBytes);
    if (carrier) {
      // A carrier's display text is replaced by its template; never hide an
      // image or another unsupported block that happens to be on the marker.
      if (Array.isArray(message.content) && message.content.some(block => block?.type !== 'text')) {
        throw new SeedError('Unsupported content block on history carrier', 'UNSUPPORTED_CONTENT');
      }
      if (++seedCount > 1) throw new SeedError('Multiple history templates on one visible surface', 'DUPLICATE_SEED');
      messages.push(...seedWireMessages(carrier.template, reasoningField));
      continue;
    }
    if (message.role === 'assistant') {
      const content = [], reasoning = [], tool_calls = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push(block.text);
        else if (block.type === 'reasoning') reasoning.push(block.text);
        else if (block.type === 'tool-call') {
          if (!block.id || !block.name || typeof block.arguments !== 'string') throw new SeedError('Invalid assistant tool call');
          tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
        } else throw new SeedError(`Unsupported assistant block: ${String(block.type)}`, 'UNSUPPORTED_CONTENT');
      }
      if (content.length || reasoning.length || tool_calls.length) messages.push({
        role: 'assistant', content: content.join('') || null,
        ...(reasoning.length ? { [reasoningField]: reasoning.join('\n') } : {}),
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    } else if (message.role === 'tool') {
      if (!message.toolCallId) throw new SeedError('Tool result requires its tool call id');
      if (Array.isArray(message.content) && message.content.some(block => block?.type === 'image')) {
        const result = multimodalContent(message.content, imageVersions);
        messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: result.text || '(see attached image)' });
        // Results must stay consecutive, so image groups follow them together.
        // Preserve which tool produced each group when several calls return.
        toolImages.push({ type: 'text', text: `Image(s) returned by tool call ${JSON.stringify(message.toolCallId)}:` }, ...result.content);
      } else messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: textContent(message.content) });
    } else if (['system', 'developer', 'user'].includes(message.role)) {
      if (message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block?.type === 'image')) {
        messages.push({ role: 'user', content: multimodalContent(message.content, imageVersions).content });
      } else {
        const content = textContent(message.content);
        if (content) messages.push({ role: message.role === 'developer' ? 'system' : message.role, content });
      }
    } else throw new SeedError('Unsupported message role', 'UNSUPPORTED_CONTENT');
  }
  flushToolImages();
  // Match the supported source route's OpenAI-completions persistence flag.
  const wire = { model: config.model, messages, stream: true, stream_options: { include_usage: true }, store: false };
  const tools = (options.tools ?? []).filter((tool) => tool.deferLoading !== true);
  if (tools.length) wire.tools = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const effort = options.reasoningEffort ?? config.reasoningEffort;
  if (effort) wire.reasoning_effort = effort;
  if (options.temperature !== undefined) wire.temperature = options.temperature;
  wire.max_completion_tokens = options.maxTokens ?? config.maxOutputTokens;
  if (options.stop !== undefined) wire.stop = options.stop;
  return wire;
}
