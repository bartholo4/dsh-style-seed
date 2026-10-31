import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReferenceCodec } from '../src/reference.mjs';

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
test('independent admission detects removed, forged and mismatched references without changing other routes',
  { skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to DSH 0.2.2-alpha.2 node_modules' }, async () => {
    const require = createRequire(join(runtime, '__candidate_guard_test.cjs'));
    const paths = new Map(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-attachment'].map(name => [name, pathToFileURL(require.resolve(name)).href]));
    const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });
    try {
      const { installSyntheticStream } = await import('../src/integration.mjs');
      const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm');
      let handler, active = true, activations = 0, inner = 0, originals = 0;
      const codec = createReferenceCodec('test', Buffer.alloc(32, 7)), sha = 'a'.repeat(64), sessionId = 'synthetic-session';
      const target = { provider: 'synthetic-source', model: 'deepseek-v4.1-flash' };
      const store = { get: () => active ? { owner: sessionId, sha256: sha, state: 'pending' } : undefined,
        activate: async (owner, fingerprint) => { assert.equal(owner, sessionId); assert.equal(fingerprint, sha); activations++; } };
      const ctx = { on: (_name, fn) => { handler = fn; return () => {}; },
        agents: { get: () => ({ session: { header: { id: sessionId }, snapshotEvents: () => [] } }) },
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }),
          stream: () => { inner++; return (async function* () { yield { type: 'synthetic' }; })(); } } };
      installSyntheticStream(ctx, { verifyStream: async () => true }, target, codec, store, {captureDispatchGuard: () => () => {}});
      const carrier = { role: 'user', source: codec.source(sha, sessionId), content: [{ type: 'text', text: '[History template enabled]' }] };
      const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      const options = markAgentLoopRequest(freeze({ ...target, reasoningEffort: 'max', maxTokens: 256, sessionId, messages: [carrier] }));
      const next = () => { originals++; return 'original'; };
      const stream = handler(options, next); assert.equal((await stream.next()).value.type, 'synthetic'); await stream.return();
      assert.equal(activations, 1); assert.equal(inner, 1);
      const stripped = markAgentLoopRequest(freeze({ ...options, messages: [{ ...carrier, source: { kind: 'ordinary' } }] }));
      assert.throws(() => handler(stripped, next), /left the active context/);
      const forged = markAgentLoopRequest(freeze({ ...options, messages: [{ ...carrier, source: { ...carrier.source, mac: '0'.repeat(64) } }] }));
      assert.throws(() => handler(forged, next), /authentication failed/);
      active = false;
      assert.throws(() => handler(options, next), /ownership invalid/);
      active = true;
      assert.equal(handler(markAgentLoopRequest(freeze({ ...stripped, model: 'synthetic-other' })), next), 'original');
      assert.equal(handler(freeze({ ...stripped, purpose: 'session-title' }), next), 'original');
      assert.equal(handler(freeze({ ...options, purpose: 'compaction' }), next), 'original');
      assert.equal(handler(freeze({ ...stripped }), next), 'original'); // unmarked auxiliary
      assert.equal(originals, 4); assert.equal(inner, 1); assert.equal(activations, 1);
    } finally { hook.deregister(); }
  });

test('configuration changes during durable activation are checked before dispatch',
  { skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to DSH 0.2.2-alpha.2 node_modules' }, async () => {
    const require = createRequire(join(runtime, '__candidate_guard_race_test.cjs'));
    const paths = new Map(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-attachment'].map(name => [name, pathToFileURL(require.resolve(name)).href]));
    const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });
    try {
      const { installSyntheticStream } = await import('../src/integration.mjs');
      const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm');
      let handler, revision = 1, inner = 0;
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const codec = createReferenceCodec('test', Buffer.alloc(32, 7)), sha = 'a'.repeat(64), sessionId = 'synthetic-session';
      const target = { provider: 'synthetic-source', model: 'deepseek-v4.1-flash' };
      const store = { get: () => ({ owner: sessionId, sha256: sha, state: 'pending' }),
        activate: async () => { entered.resolve(); await release.promise; } };
      const ctx = { on: (_name, fn) => { handler = fn; return () => {}; }, agents: { get: () => ({ session: { header: { id: sessionId } } }) },
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }),
          stream: () => { inner++; return (async function* () {})(); } } };
      const contract = { verifyStream: async () => { if (revision !== 1) throw new Error('binding changed'); } };
      installSyntheticStream(ctx, contract, target, codec, store, {captureDispatchGuard: () => () => {}});
      const carrier = { role: 'user', source: codec.source(sha, sessionId), content: [{ type: 'text', text: 'marker' }] };
      const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
      const options = markAgentLoopRequest(freeze({ ...target, reasoningEffort: 'max', maxTokens: 256, sessionId, messages: [carrier] }));
      const attempt = handler(options, () => { throw new Error('unexpected fallback'); }).next();
      await entered.promise; revision = 2; release.resolve();
      await assert.rejects(attempt, /binding changed/); assert.equal(inner, 0);
    } finally { hook.deregister(); }
  });

test('child, seeded, delegated and missing agents always pass through before reading references',
  { skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to DSH 0.2.2-alpha.2 node_modules' }, async () => {
    const require = createRequire(join(runtime, '__candidate_ineligible_guard_test.cjs'));
    const paths = new Map(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-attachment'].map(name => [name, pathToFileURL(require.resolve(name)).href]));
    const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });
    try {
      const { installSyntheticStream } = await import('../src/integration.mjs');
      const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm');
      let handler, currentAgent, originals = 0;
      const codec = { read: () => { throw new Error('reference must not be read'); } };
      const store = { get: () => { throw new Error('sidecar must not be read'); }, activate: () => {} };
      const ctx = { on: (_name, fn) => { handler = fn; return () => {}; }, agents: { get: () => currentAgent } };
      const target = { provider: 'synthetic-source', model: 'deepseek-v4.1-flash' };
      installSyntheticStream(ctx, {}, target, codec, store);
      const options = markAgentLoopRequest({ ...target, sessionId: 'child', messages: [{ role: 'user', source: { kind: 'dsh-style-seed-reference' }, content: [] }] });
      const next = () => { originals++; return 'original'; };
      for (const header of [undefined, { isSeeded: true }, { parentSession: 'parent' }, { delegationDepth: 1 }, { origin: 'subagent' }]) {
        currentAgent = header ? { session: { header } } : undefined;
        assert.equal(handler(options, next), 'original');
      }
      assert.equal(originals, 5);
    } finally { hook.deregister(); }
  });
