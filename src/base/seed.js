import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DEFAULTS, SEED_SOURCE, SeedError, validateHistoryReasoningField } from './constants.js';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (message) => { throw new SeedError(`Invalid history template: ${message}`); };
const text = (x, name, limit = 512) => {
  if (typeof x !== 'string' || !x.trim() || x.length > limit) fail(name);
  return x;
};
const keys = (x, allowed, name) => {
  if (!object(x) || Object.keys(x).some((key) => !allowed.includes(key))) fail(name);
};

/** Validate and detach an explicit user-owned import, never native replay metadata. */
export function validateSeed(value, maxBytes = DEFAULTS.maxSeedBytes) {
  keys(value, ['schemaVersion', 'id', 'provenance', 'messages'], 'root fields');
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  const id = text(value.id, 'id', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) fail('id must be a portable identifier');
  if (!object(value.provenance) || Object.keys(value.provenance).length > 16) fail('provenance');
  // Provenance is deliberately bounded metadata; no tokens, raw requests or paths are required.
  const provenance = {};
  for (const [key, item] of Object.entries(value.provenance)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) || /key|token|secret|password|authorization/i.test(key)) fail('provenance key');
    if (typeof item !== 'string' || item.length > 512) fail('provenance value');
    provenance[key] = item;
  }
  if (!Array.isArray(value.messages) || value.messages.length < 2 || value.messages.length > 32 || value.messages.length % 2) fail('paired user/assistant messages required');
  const messages = value.messages.map((message, index) => {
    const role = index % 2 ? 'assistant' : 'user';
    keys(message, role === 'user' ? ['role', 'content'] : ['role', 'content', 'reasoning', 'source'], `message ${index} fields`);
    if (message.role !== role) fail(`message ${index} role`);
    const content = text(message.content, `message ${index} content`, maxBytes);
    if (role === 'user') return { role, content };
    keys(message.source, ['provider', 'model'], `message ${index} source`);
    const source = { provider: text(message.source.provider, 'source provider'), model: text(message.source.model, 'source model') };
    if (message.reasoning !== undefined && typeof message.reasoning !== 'string') fail(`message ${index} reasoning`);
    return { role, content, ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }), source };
  });
  const template = { schemaVersion: 1, id, provenance, messages };
  const bytes = Buffer.byteLength(JSON.stringify(template));
  if (bytes > maxBytes) fail('byte limit exceeded');
  return template;
}

export function fingerprintSeed(template) {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex');
}

/** Bound the read before parsing; never print the file, its path, or a parser excerpt. */
export async function loadSeed(seedPath, maxBytes = DEFAULTS.maxSeedBytes, signal, options = {}) {
  if (!isAbsolute(seedPath)) fail('seedPath must be absolute');
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(seedPath, 'r');
    if (!(await handle.stat()).isFile()) fail('seedPath must name a regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail('byte limit exceeded');
    let parsed;
    try { parsed = JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/u, '')); }
    catch { fail('file must contain valid JSON'); }
    const template = validateSeed(parsed, maxBytes);
    return { template, sha256: fingerprintSeed(template), ...(options.includeFileSha256 === true
      ? { fileSha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex') } : {}) };
  } catch (error) {
    if (error instanceof SeedError || signal?.aborted) throw error;
    throw new SeedError('History template could not be read', 'SEED_READ_FAILED');
  } finally { await handle?.close(); }
}

export function seedCarrierSource(loaded, sessionId, importedAt = new Date().toISOString()) {
  return {
    kind: SEED_SOURCE,
    version: 1,
    ownerSessionId: String(sessionId),
    importedAt,
    sha256: loaded.sha256,
    template: loaded.template,
  };
}

export function readSeedCarrier(message, maxBytes = DEFAULTS.maxSeedBytes) {
  if (message?.role !== 'user' || message.source?.kind !== SEED_SOURCE) return undefined;
  const source = message.source;
  if (source.version !== 1) fail('unsupported carrier version');
  const template = validateSeed(source.template, maxBytes);
  if (source.sha256 !== fingerprintSeed(template)) fail('carrier fingerprint mismatch');
  return { template, sha256: source.sha256, ownerSessionId: source.ownerSessionId };
}

/** Imported reasoning is explicitly mapped; original provenance stays in the carrier. */
export function seedWireMessages(template, field = DEFAULTS.historyReasoningField) {
  const reasoningField = validateHistoryReasoningField(field);
  return template.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.role === 'assistant' && message.reasoning !== undefined ? { [reasoningField]: message.reasoning } : {}),
  }));
}
