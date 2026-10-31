import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installRecovery } from '../src/recovery.mjs';
import { createReferenceCodec } from '../src/reference.mjs';

test('recovery respects a valid reference already queued by another hook', async () => {
  const id = 'synthetic', sha = 'a'.repeat(64), codec = createReferenceCodec('test', Buffer.alloc(32, 1));
  const carrier = { role: 'user', source: codec.source(sha, id), content: [{ type: 'text', text: 'marker' }] };
  const listeners = new Map(), ctx = { on: (name, fn) => { listeners.set(name, fn); return () => {}; } };
  let surface = [], history = [];
  const session = { deriveMessages: () => surface, snapshotEvents: () => history }, agent = { id, session };
  const target = { provider: 'synthetic', model: 'target', reasoningEffort: 'max' }, selection = { assembled: target };
  installRecovery(ctx, agent, selection, target, async () => ({ sha256: sha }), codec,
    { get: () => ({ owner: id, sha256: sha, state: 'active' }) });
  const payload = { signal: new AbortController().signal }, decision = { kind: 'accept', messages: [carrier] };
  assert.equal(await listeners.get('agent/pre-step')(payload, async () => decision), decision);
  surface = [carrier];
  await assert.rejects(listeners.get('agent/pre-step')(payload, async () => decision), /invalid live reference/);
});
