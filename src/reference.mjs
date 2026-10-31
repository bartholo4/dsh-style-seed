import { makeAuthenticatedReference, verifyAuthenticatedReference } from './authenticated-reference.mjs';

// Synthetic integration seam; production key provisioning and durable
// admission authority remain unimplemented and must be independently checked.
export const REFERENCE_KIND = 'dsh-style-seed-reference';
export const REFERENCE_TEXT = '[History template enabled]';
export function createReferenceCodec(keyId, key) {
  if (typeof keyId !== 'string' || !keyId || !Buffer.isBuffer(key) || key.length < 32) throw new Error('reference key unavailable');
  const privateKey = Buffer.from(key);
  const keyring = new Map([[keyId, privateKey]]);
  return Object.freeze({
    source: (sha256, sessionId) => makeAuthenticatedReference(sessionId, sha256, keyId, privateKey),
    read(message, sessionId) {
      if (message?.source?.kind !== REFERENCE_KIND) return undefined;
      if (message.role !== 'user') throw new Error('history reference authentication failed');
      return verifyAuthenticatedReference(message.source, sessionId, keyring);
    },
  });
}
