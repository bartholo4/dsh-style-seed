import { isAbsolute, resolve } from 'node:path';
import { DEFAULTS } from './base/constants.js';
import { loadSeed } from './base/seed.js';

// Paths are configured locally, never recovered from a session or RPC payload.
// The mutable lookup remains private; consumers receive only a frozen reader.
export async function createSeedRegistry(seedPath, legacySeedPaths = [], maxBytes = DEFAULTS.maxSeedBytes) {
  if (typeof seedPath !== 'string' || !isAbsolute(seedPath) || !Array.isArray(legacySeedPaths) ||
      legacySeedPaths.length > 16 || legacySeedPaths.some(value => typeof value !== 'string' || !isAbsolute(value))) {
    throw new Error('history template registry configuration invalid');
  }
  const paths = [seedPath, ...legacySeedPaths];
  const normalized = paths.map(value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
  if (new Set(normalized).size !== normalized.length) throw new Error('history template registry contains duplicate paths');
  const byFingerprint = new Map();
  let defaultIdentity;
  for (const file of paths) {
    const loaded = await loadSeed(file, maxBytes, undefined, { includeFileSha256: true });
    if (byFingerprint.has(loaded.sha256)) throw new Error('history template registry contains duplicate identities');
    byFingerprint.set(loaded.sha256, Object.freeze({ file, fileSha256: loaded.fileSha256 }));
    defaultIdentity ??= Object.freeze({ sha256: loaded.sha256 });
  }
  const read = async (signal, expectedSha256 = defaultIdentity.sha256) => {
    signal?.throwIfAborted();
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('history template identity invalid');
    const pinned = byFingerprint.get(expectedSha256);
    if (!pinned) throw new Error('history template identity is not registered');
    const loaded = await loadSeed(pinned.file, maxBytes, signal, { includeFileSha256: true });
    signal?.throwIfAborted();
    if (loaded.sha256 !== expectedSha256 || loaded.fileSha256 !== pinned.fileSha256) throw new Error('history template registered file changed');
    return loaded;
  };
  return Object.freeze({ defaultIdentity, read });
}
