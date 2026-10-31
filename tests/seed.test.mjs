import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSeed, loadSeed, fingerprintSeed } from '../src/base/seed.js';
import { createSeedRegistry } from '../src/seed-registry.mjs';

// All inputs are synthetic and have no relationship to any user's history.
const fixture = (id = 'synthetic-v1') => ({
  schemaVersion: 1, id, provenance: { origin: 'synthetic' }, messages: [
    { role: 'user', content: 'Synthetic question.' },
    { role: 'assistant', content: 'Synthetic answer.', reasoning: 'Synthetic rationale.',
      source: { provider: 'example-provider', model: 'example-model' } },
  ],
});

test('accepts a paired synthetic template and optional reasoning', () => {
  const sample = fixture();
  assert.deepEqual(validateSeed(sample), sample);
  delete sample.messages[1].reasoning;
  assert.deepEqual(validateSeed(sample), sample);
});

test('rejects extra fields, malformed metadata, unpaired roles, and oversized input', () => {
  const cases = [
    { ...fixture(), extra: true },
    { ...fixture(), schemaVersion: 2 },
    { ...fixture(), id: 'invalid id' },
    { ...fixture(), provenance: { apiKey: 'synthetic' } },
    { ...fixture(), provenance: { origin: 1 } },
    { ...fixture(), messages: [fixture().messages[0]] },
    { ...fixture(), messages: [fixture().messages[1], fixture().messages[0]] },
    { ...fixture(), messages: [fixture().messages[0], { ...fixture().messages[1], source: undefined }] },
    { ...fixture(), messages: [fixture().messages[0], { ...fixture().messages[1], reasoning: 1 }] },
    { ...fixture(), messages: [fixture().messages[0], { ...fixture().messages[1], content: 'x'.repeat(65536) }] },
  ];
  for (const value of cases) assert.throws(() => validateSeed(value), /Invalid history template/);
});

test('requires an absolute seed file path', async () => {
  await assert.rejects(loadSeed('synthetic-relative-seed.json'), /seedPath must be absolute/);
});

test('registered synthetic files stay pinned and unknown identities fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-public-seed-test-'));
  const first = join(directory, 'seed.json'), legacy = join(directory, 'legacy.json');
  try {
    const a = fixture(), b = fixture('synthetic-v2');
    await writeFile(first, JSON.stringify(a), 'utf8');
    await writeFile(legacy, JSON.stringify(b), 'utf8');
    const registry = await createSeedRegistry(first, [legacy]);
    assert.equal((await registry.read()).sha256, fingerprintSeed(validateSeed(a)));
    assert.equal((await registry.read(undefined, fingerprintSeed(validateSeed(b)))).sha256, fingerprintSeed(validateSeed(b)));
    await assert.rejects(registry.read(undefined, 'a'.repeat(64)), /not registered/);
    await writeFile(first, JSON.stringify(a) + ' ', 'utf8');
    await assert.rejects(registry.read(), /registered file changed/);
  } finally {
    await unlink(first).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(legacy).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});
