import { DEFAULTS, SeedError } from './constants.js';

/** Decode SSE across arbitrary UTF-8 and CR/LF chunk boundaries, with bounded frames. */
export async function* parseSse(body, activity = () => {}, maxFrameBytes = 4 * 1024 * 1024) {
  if (!body) throw new SeedError('Provider response has no stream body', 'MALFORMED_RESPONSE');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', lines = [], frameSize = 0, done = false;
  const consume = (line) => {
    if (line === '') {
      const data = lines.join('\n');
      lines = []; frameSize = 0;
      return data || undefined;
    }
    frameSize += Buffer.byteLength(line);
    if (frameSize > maxFrameBytes) throw new SeedError('Provider SSE frame exceeds its limit', 'MALFORMED_RESPONSE');
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /u, ''));
    return undefined;
  };
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) { done = true; break; }
      activity();
      pending += decoder.decode(item.value, { stream: true });
      while (true) {
        const match = /[\r\n]/u.exec(pending);
        if (!match) break;
        const index = match.index;
        if (pending[index] === '\r' && index === pending.length - 1) break;
        const width = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
        const line = pending.slice(0, index);
        pending = pending.slice(index + width);
        const frame = consume(line);
        if (frame !== undefined) yield frame;
      }
      if (Buffer.byteLength(pending) + frameSize > maxFrameBytes) throw new SeedError('Provider SSE frame exceeds its limit', 'MALFORMED_RESPONSE');
    }
    pending += decoder.decode();
    // A final CR is a line terminator, but an incomplete frame is never accepted.
    if (pending.endsWith('\r')) {
      const frame = consume(pending.slice(0, -1));
      if (frame !== undefined) yield frame;
      pending = '';
    }
    if (pending.trim() || lines.length) throw new SeedError('Provider ended inside an SSE frame', 'TRANSPORT');
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function usageOf(value) {
  const prompt = value.prompt_tokens, output = value.completion_tokens;
  if (!Number.isSafeInteger(prompt) || prompt < 0 || !Number.isSafeInteger(output) || output < 0) throw new SeedError('Invalid provider token usage', 'MALFORMED_RESPONSE');
  const cache = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens ?? 0;
  if (!Number.isSafeInteger(cache) || cache < 0 || cache > prompt) throw new SeedError('Invalid provider cached token usage', 'MALFORMED_RESPONSE');
  return { inputTokens: prompt - cache, outputTokens: output, totalTokens: prompt + output, ...(cache > 0 ? { cacheReadTokens: cache } : {}) };
}

function httpError(response) {
  const status = response.status;
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST';
  const raw = response.headers.get('retry-after');
  const delay = raw === null ? NaN : /^\d+(?:\.\d+)?$/u.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
  return new SeedError(`History provider returned HTTP ${status}`, code, {
    status,
    ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
    ...(requestId && /^[A-Za-z0-9._:-]{1,200}$/u.test(requestId) ? { requestId } : {}),
  });
}

/** No retries or logging here: the Harness owns retry policy and durable stream recording. */
export async function* streamCompletion(wire, supplied, dependencies = {}) {
  const config = { ...DEFAULTS, ...supplied };
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, controller.signal]) : controller.signal;
  let idleTimer, timeoutKind;
  const expire = (kind) => { timeoutKind = kind; controller.abort(); };
  const pulse = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => expire('idle'), config.streamIdleTimeoutMs); idleTimer.unref?.(); };
  const blocks = new Map();
  let finish, sawDone = false, usage;
  const blockFor = (key, type) => {
    if (!blocks.has(key)) blocks.set(key, { index: blocks.size, type, text: '', id: '', name: '', arguments: '' });
    return blocks.get(key);
  };
  try {
    signal.throwIfAborted();
    pulse();
    const body = JSON.stringify(wire);
    dependencies.beforeDispatch?.();
    signal.throwIfAborted();
    const response = await fetchImpl(`${config.baseURL.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...dependencies.headers },
      body,
    });
    pulse();
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response); }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      await response.body?.cancel().catch(() => {});
      throw new SeedError('History provider did not return an SSE stream', 'MALFORMED_RESPONSE');
    }
    for await (const data of parseSse(response.body, pulse)) {
      signal.throwIfAborted();
      if (data === '[DONE]') { sawDone = true; break; }
      let packet;
      try { packet = JSON.parse(data); } catch { throw new SeedError('Provider SSE contains invalid JSON', 'MALFORMED_RESPONSE'); }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new SeedError('Invalid provider SSE object', 'MALFORMED_RESPONSE');
      if (packet.error) throw new SeedError('Provider reported a stream error', 'SERVER');
      if (packet.usage) usage = usageOf(packet.usage);
      if (!Array.isArray(packet.choices)) throw new SeedError('Provider SSE choices are missing', 'MALFORMED_RESPONSE');
      if (packet.choices.length > 1) throw new SeedError('Multiple provider choices are unsupported', 'MALFORMED_RESPONSE');
      const choice = packet.choices[0];
      if (!choice) continue;
      if (choice.index !== undefined && choice.index !== 0) throw new SeedError('Unexpected provider choice index', 'MALFORMED_RESPONSE');
      const delta = choice.delta ?? {};
      if (finish !== undefined && (delta.content || delta.reasoning_content || delta.reasoning || delta.reasoning_text || delta.tool_calls?.length)) throw new SeedError('Provider emitted content after its finish reason', 'MALFORMED_RESPONSE');
      for (const [key, type, value] of [
        ['reasoning', 'reasoning', delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text],
        ['text', 'text', delta.content],
      ]) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') throw new SeedError('Invalid provider content delta', 'MALFORMED_RESPONSE');
        const fresh = !blocks.has(key), block = blockFor(key, type);
        if (fresh) yield { type: 'block-start', index: block.index, blockType: type };
        block.text += value;
        yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: value };
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new SeedError('Invalid tool call list', 'MALFORMED_RESPONSE');
      for (const call of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index > 128) throw new SeedError('Invalid tool call index', 'MALFORMED_RESPONSE');
        if (call.type !== undefined && call.type !== 'function') throw new SeedError('Unsupported tool call type', 'MALFORMED_RESPONSE');
        const key = `tool:${call.index}`, fresh = !blocks.has(key), block = blockFor(key, 'tool-call');
        if (call.id !== undefined) {
          if (typeof call.id !== 'string' || !call.id || (block.id && block.id !== call.id)) throw new SeedError('Invalid or changed tool call id', 'MALFORMED_RESPONSE');
          block.id = call.id;
        }
        if (!block.id) throw new SeedError('Tool call is missing its initial id', 'MALFORMED_RESPONSE');
        if (call.function?.name !== undefined) {
          if (typeof call.function.name !== 'string') throw new SeedError('Invalid tool name', 'MALFORMED_RESPONSE');
          block.name += call.function.name;
        }
        const argumentsDelta = call.function?.arguments ?? '';
        if (typeof argumentsDelta !== 'string') throw new SeedError('Invalid tool arguments delta', 'MALFORMED_RESPONSE');
        block.arguments += argumentsDelta;
        if (fresh) yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: block.index, id: block.id, ...(block.name ? { name: block.name } : {}), argumentsDelta };
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (finish !== undefined) throw new SeedError('Duplicate provider finish reason', 'MALFORMED_RESPONSE');
        if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new SeedError('Provider ended with an unsupported finish reason', 'PROVIDER_FINISH');
        finish = choice.finish_reason;
      }
    }
    if (!sawDone || finish === undefined) throw new SeedError('Provider stream ended before its terminal marker', 'TRANSPORT');
    const hasToolCalls = [...blocks.values()].some((block) => block.type === 'tool-call');
    if ((finish === 'stop' && hasToolCalls) || (finish === 'tool_calls' && !hasToolCalls)) {
      throw new SeedError('Provider finish reason does not match its tool calls', 'MALFORMED_RESPONSE');
    }
    if (blocks.size === 0 && finish !== 'length') throw new SeedError('Provider returned no content', 'EMPTY_RESPONSE');
    const toolIds = new Set();
    for (const block of blocks.values()) {
      let content;
      if (block.type === 'tool-call') {
        if (finish === 'length') continue; // Harness keeps complete prose and drops partial calls.
        if (!block.name || toolIds.has(block.id)) throw new SeedError('Incomplete or duplicate tool call', 'MALFORMED_RESPONSE');
        let args;
        try { args = JSON.parse(block.arguments); } catch { throw new SeedError('Provider tool arguments are not valid JSON', 'MALFORMED_RESPONSE'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new SeedError('Provider tool arguments must be an object', 'MALFORMED_RESPONSE');
        toolIds.add(block.id);
        content = { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments };
      } else content = { type: block.type, text: block.text };
      yield { type: 'block-end', index: block.index, block: content };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: finish === 'length' ? 'max-tokens' : 'stop' } };
  } catch (error) {
    if (dependencies.signal?.aborted) throw new SeedError('History provider request was cancelled', 'ABORTED');
    if (timeoutKind) throw new SeedError(`History provider ${timeoutKind} timeout`, 'TIMEOUT');
    if (error instanceof SeedError) throw error;
    throw new SeedError('History provider transport failed', 'TRANSPORT');
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
  }
}
