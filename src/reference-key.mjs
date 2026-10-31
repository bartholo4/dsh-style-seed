import { randomBytes } from 'node:crypto';
import { createReferenceCodec } from './reference.mjs';

// Experimental seam only. The caller supplies the official credentialKey
// function and a supported credentials service. Never log or export records.
// The credential provider's per-record modify operation supplies exclusion.
export async function loadOrCreateReferenceCodec(credentials, credentialKey, generate = randomBytes) {
  if (!credentials || typeof credentials.modifyRecord !== 'function' || typeof credentials.readRecord !== 'function' ||
      typeof credentialKey !== 'function' || typeof generate !== 'function') throw new Error('reference key service unavailable');
  try {
    const recordKey = credentialKey('dsh-style-seed', 'reference-auth');
    await credentials.modifyRecord(recordKey, current => {
      if (current !== undefined) return undefined; // Never replace an existing record.
      const bytes = generate(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('invalid key generator');
      return { kind: 'grant', payload: { version: 1, keyId: 'v1', secret: bytes.toString('base64') } };
    });
    const record = await credentials.readRecord(recordKey);
    const payload = record?.kind === 'grant' ? record.payload : undefined;
    if (!payload || payload.version !== 1 || payload.keyId !== 'v1' || typeof payload.secret !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/u.test(payload.secret)) throw new Error('invalid key record');
    const bytes = Buffer.from(payload.secret, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== payload.secret) throw new Error('invalid key record');
    return createReferenceCodec(payload.keyId, bytes);
  } catch { throw new Error('reference key unavailable'); }
}
