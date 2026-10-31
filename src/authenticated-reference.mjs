// Isolated proof of signed session references. Key provisioning, authenticated
// gateway access and authoritative durable admission are deliberately outside
// this module; do not connect it to a real profile as-is.
import { createHmac, timingSafeEqual } from 'node:crypto';

const KIND = 'dsh-style-seed-reference';
const VERSION = 2;
const FIELDS = ['kind', 'version', 'ownerSessionId', 'sha256', 'keyId', 'mac'];
const idOK = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const digestOK = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const keyOK = key => Buffer.isBuffer(key) && key.length >= 32;
const canonical = source => JSON.stringify([KIND, VERSION, source.ownerSessionId, source.sha256, source.keyId]);
const macFor = (source, key) => createHmac('sha256', key).update(canonical(source), 'utf8').digest();
const invalid = () => { throw new Error('history reference authentication failed'); };

export function makeAuthenticatedReference(ownerSessionId, sha256, keyId, key) {
  if (!idOK(ownerSessionId) || !digestOK(sha256) || !idOK(keyId) || !keyOK(key)) invalid();
  const source = { kind: KIND, version: VERSION, ownerSessionId, sha256, keyId };
  return Object.freeze({ ...source, mac: macFor(source, key).toString('hex') });
}

export function verifyAuthenticatedReference(source, expectedSessionId, keyring) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).length !== FIELDS.length || FIELDS.some(field => !Object.hasOwn(source, field)) ||
      source.kind !== KIND || source.version !== VERSION || !idOK(source.ownerSessionId) ||
      source.ownerSessionId !== expectedSessionId || !digestOK(source.sha256) ||
      !idOK(source.keyId) || !digestOK(source.mac) || !(keyring instanceof Map)) invalid();
  const key = keyring.get(source.keyId);
  if (!keyOK(key)) invalid();
  const expected = macFor(source, key), supplied = Buffer.from(source.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid();
  return Object.freeze({ ownerSessionId: source.ownerSessionId, sha256: source.sha256, keyId: source.keyId });
}
