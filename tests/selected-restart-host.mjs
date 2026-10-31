import './_no-network.mjs';
// Separate process with its own real JSON storage and JSONL session backend.
// All profiles, credentials, messages, and payloads are synthetic.
import assert from 'node:assert/strict';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('NETWORK DISABLED'); };
net.Socket.prototype.connect = denyNetwork;
net.connect = net.createConnection = tls.connect = http.request = http.get = https.request = https.get = denyNetwork;
syncBuiltinESMExports();

const [mode, rawDirectory] = process.argv.slice(2);
const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
if (!runtime || !rawDirectory || !['create', 'resume-disable', 'resume-other', 'failed-create', 'failed-resume'].includes(mode)) throw new Error('synthetic host arguments invalid');
const directory = resolve(rawDirectory);
const require = createRequire(join(runtime, '__selected_synthetic_restart.cjs'));
assert.equal(require('@deepseek-ai/dsh-llm-pi-ai/package.json').version, '0.2.2-alpha.2');
const names = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-session-persistence-jsonl', 'zod'];
const paths = new Map(names.map(name => [name, pathToFileURL(require.resolve(name)).href]));
paths.set('@earendil-works/pi-ai/providers/all', pathToFileURL(join(runtime, '@earendil-works/pi-ai/dist/providers/all.js')).href);
const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });
const routeA = { provider: 'restart-a', model: 'model-a', reasoningEffort: 'high', maxTokens: 901 };
const routeB = { provider: 'restart-b', model: 'model-b', reasoningEffort: 'max', maxTokens: 1202 };
const routeC = { provider: 'restart-c', model: 'model-c' };
const profiles = {
  'restart-c': { api: 'openai-responses', baseURL: 'https://restart-c.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_RESTART_C', models: [{ id: 'model-c' }] },
  'restart-a': { api: 'openai-completions', baseURL: 'https://restart-a.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_RESTART_A',
    models: [{ id: 'model-a', reasoningEfforts: { high: 'high', max: 'max' } }] },
  'restart-b': { api: 'openai-completions', baseURL: 'https://restart-b.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_RESTART_B',
    models: [{ id: 'model-b', reasoningEfforts: { high: 'high', max: 'max' } }] },
};
const allowed = {
  'https://restart-a.synthetic.invalid/v1/chat/completions': { auth: 'Bearer synthetic-key-a', model: 'model-a' },
  'https://restart-b.synthetic.invalid/v1/chat/completions': { auth: 'Bearer synthetic-key-b', model: 'model-b' },
};
const fetches = [];
globalThis.fetch = async (input, init) => {
  const url = String(input), expected = allowed[url];
  assert.ok(expected, 'fake fetch rejects non-fixture URLs');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), expected.auth);
  const body = JSON.parse(init.body);
  assert.equal(body.model, expected.model);
  fetches.push({ url, body });
  const chunk = { id: `synthetic-${mode}`, object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta: { reasoning: `synthetic-answer-reasoning-${mode}`, content: `synthetic-answer-${mode}` }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const countSeed = body => ({
  user: body.messages.filter(message => message.role === 'user' && message.content === 'synthetic-seed-user').length,
  answer: body.messages.filter(message => message.role === 'assistant' && message.content === 'synthetic-seed-answer').length,
  reasoning: body.messages.filter(message => message.reasoning === 'synthetic-seed-reasoning').length,
});
const fullSeed = { user: 1, answer: 1, reasoning: 1 }, noSeed = { user: 0, answer: 0, reasoning: 0 };
const fibers = [], handles = [], stops = [];
let stage = 'imports';
try {
  const [{ Context, Service }, { AgentRegistry, installModelSelection }, { AgentLoop }, { LlmRuntime, createUserMessage }, pi,
    { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime }, { TypertRegistry }, { RemoteAccessService },
    { TypertGatewayService }, { default: Storage }, json, storageDomain, persistence, plugin] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-llm'),
    import('@deepseek-ai/dsh-llm-pi-ai'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-typert-registry'),
    import('@deepseek-ai/dsh-api-remote-access'), import('@deepseek-ai/dsh-api-gateway'), import('@deepseek-ai/dsh-storage'),
    import('@deepseek-ai/dsh-storage-json'), import('@deepseek-ai/dsh-storage-domain'), import('@deepseek-ai/dsh-session-persistence-jsonl'),
    import('../src/index.mjs'),
  ]);
  class FakeSettings extends Service {
    constructor(ctx) { super(ctx, 'settings'); }
    configure() { return () => {}; }
    describe() { return [{ ns: 'llm-pi-ai', revision: 1, value: { providers: structuredClone(profiles) } }]; }
  }
  class FakeCredentials extends Service {
    constructor(ctx) {
      super(ctx, 'credentials');
      // Deterministic synthetic key, never a real credential.
      this.records = new Map([['dsh-style-seed/reference-auth', { kind: 'grant',
        payload: { version: 1, keyId: 'v1', secret: Buffer.alloc(32, 42).toString('base64') } }]]);
    }
    async describe() { return { configured: true }; }
    async resolve(ref) {
      const value = { SYNTHETIC_RESTART_A: 'synthetic-key-a', SYNTHETIC_RESTART_B: 'synthetic-key-b', SYNTHETIC_RESTART_C: 'synthetic-key-c' }[ref];
      if (!value) throw new Error('unexpected credential reference');
      return { value };
    }
    async modifyRecord(key, fn) { const next = await fn(this.records.get(key)); if (next !== undefined) this.records.set(key, next); }
    async readRecord(key) { return this.records.get(key); }
    async listRecords() { return []; }
  }
  class FakeDefaultModel extends Service {
    constructor(ctx) { super(ctx, 'agentDefaultModel'); }
    currentSelection() { return routeA; }
  }
  stage = 'services';
  const ctx = new Context();
  for (const service of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, TypertRegistry, RemoteAccessService,
    Storage, FakeSettings, FakeCredentials, FakeDefaultModel]) fibers.push(await ctx.plugin(service));
  fibers.push(await ctx.plugin(json, { root: join(directory, 'storage') }));
  fibers.push(await ctx.plugin(storageDomain, { backend: 'json' }));
  fibers.push(await ctx.plugin(persistence, { root: join(directory, 'sessions'), compression: 'none' }));
  fibers.push(await ctx.plugin(SystemPrompt, { includeRuntimeContext: false, personaPrefix: 'synthetic system' }));
  fibers.push(await ctx.plugin(ToolRuntime, {}));
  fibers.push(await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'), {}));
  fibers.push(await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }));
  fibers.push(await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 10000, streamInboxBytes: 65536 }));
  fibers.push(await ctx.plugin(pi, { providers: structuredClone(profiles) }));
  stage = 'plugin';
  const seedPath = join(directory, 'synthetic-seed.json');
  const config = { enabled: true, followSelected: true, firstTurnOnly: true, seedPath };
  fibers.push(await ctx.plugin(plugin, config));
  const setup = agentCtx => { installModelSelection(agentCtx); };
  const failScenario = mode.startsWith('failed-');
  const sessionId = failScenario ? 'synthetic-failed-session' : 'synthetic-sidecar-session';
  const create = mode === 'create' || mode === 'failed-create';
  const initialRoute = mode === 'failed-create' ? routeC : routeA;
  stage = create ? 'create-session' : 'resume-session';
  const handle = create
    ? await ctx.agents.create({ sessionId, agentOptions: initialRoute, setup })
    : await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: initialRoute, setup });
  handles.push(handle);
  const agent = handle.agent, contract = ctx.get('switchContract').contract, store = ctx.get('switchContract').admissionStore;
  const user = value => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] });
  const ensureNoCarrier = () => {
    const events = agent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'dsh-style-seed-reference').length, 0);
    const serialized = JSON.stringify(events);
    for (const value of ['synthetic-seed-user', 'synthetic-seed-answer', 'synthetic-seed-reasoning']) assert.ok(!serialized.includes(value));
  };
  const lastTurn = () => agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind;
  if (mode === 'create') {
    stage = 'initial-enable';
    assert.equal(contract.get(agent.id).enabled, false);
    await contract.set(agent.id, true);
    agent.followup(user('synthetic-initial-question')); await agent.whenIdle();
    assert.equal(lastTurn(), 'completed');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://restart-a.synthetic.invalid/v1/chat/completions');
    assert.deepEqual(countSeed(fetches[0].body), fullSeed);
    assert.equal(store.get(agent.id)?.mode, 'sidecar-only');
    assert.equal(store.get(agent.id)?.state, 'active');
    ensureNoCarrier();
  } else if (mode === 'resume-disable') {
    stage = 'resume-followup';
    assert.equal(contract.get(agent.id).enabled, true);
    assert.equal(store.get(agent.id)?.mode, 'sidecar-only');
    assert.equal(store.get(agent.id)?.state, 'active');
    ensureNoCarrier();
    agent.followup(user('synthetic-reopened-question')); await agent.whenIdle();
    assert.equal(lastTurn(), 'completed');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://restart-a.synthetic.invalid/v1/chat/completions');
    assert.deepEqual(countSeed(fetches[0].body), noSeed);
    assert.ok(fetches[0].body.messages.some(message => message.content === 'synthetic-reopened-question'));
    ensureNoCarrier();
    stage = 'disable';
    await contract.set(agent.id, false);
    assert.equal(contract.get(agent.id).enabled, false);
    assert.equal(store.get(agent.id)?.state, 'disabled');
  } else if (mode === 'failed-create') {
    stage = 'failed-enable';
    await contract.set(agent.id, true);
    agent.followup(user('synthetic-unsupported-question')); await agent.whenIdle();
    assert.equal(lastTurn(), 'error');
    assert.equal(fetches.length, 0);
    assert.equal(store.get(agent.id)?.mode, 'sidecar-only');
    assert.equal(store.get(agent.id)?.state, 'pending');
    ensureNoCarrier();
    assert.equal(contract.get(agent.id).editable, true);
    await contract.set(agent.id, false);
    assert.equal(contract.get(agent.id).enabled, false);
    assert.equal(store.get(agent.id)?.state, 'disabled');
    agent.model.select({ provider: routeA.provider, model: routeA.model, reasoningEffort: routeA.reasoningEffort });
    stage = 'failed-close-continue';
    agent.followup(user('synthetic-after-failure-close')); await agent.whenIdle();
    assert.equal(lastTurn(), 'completed');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://restart-a.synthetic.invalid/v1/chat/completions');
    assert.deepEqual(countSeed(fetches[0].body), noSeed);
    ensureNoCarrier();
  } else if (mode === 'failed-resume') {
    stage = 'failed-resume-disabled';
    assert.equal(contract.get(agent.id).enabled, false);
    assert.equal(store.get(agent.id)?.state, 'disabled');
    ensureNoCarrier();
    agent.followup(user('synthetic-after-failure-restart')); await agent.whenIdle();
    assert.equal(lastTurn(), 'completed');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://restart-a.synthetic.invalid/v1/chat/completions');
    assert.deepEqual(countSeed(fetches[0].body), noSeed);
    ensureNoCarrier();
  } else {
    stage = 'resume-disabled';
    assert.equal(contract.get(agent.id).enabled, false);
    assert.equal(store.get(agent.id)?.mode, 'sidecar-only');
    assert.equal(store.get(agent.id)?.state, 'disabled');
    ensureNoCarrier();
    agent.model.select({ provider: routeB.provider, model: routeB.model, reasoningEffort: routeB.reasoningEffort });
    stage = 'other-provider';
    agent.followup(user('synthetic-other-provider-question')); await agent.whenIdle();
    assert.equal(lastTurn(), 'completed');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://restart-b.synthetic.invalid/v1/chat/completions');
    assert.equal(fetches[0].body.model, 'model-b');
    assert.deepEqual(countSeed(fetches[0].body), noSeed);
    assert.ok(fetches[0].body.messages.some(message => message.content === 'synthetic-other-provider-question'));
    ensureNoCarrier();
  }
  assert.equal(networkAttempts, 0);
  stage = 'cleanup';
  for (const handle of handles.reverse()) await handle.dispose();
  for (const stop of stops.reverse()) stop();
  for (const fiber of fibers.reverse()) await fiber.dispose();
  hook.deregister();
  process.stdout.write(JSON.stringify({ mode, status: 'ok', calls: fetches.length, carrierCount: 0, networkAttempts }));
} catch (error) {
  // Inputs are synthetic; no request headers, payloads, or credentials are logged.
  process.stderr.write(`synthetic restart failed at ${stage}: ${error?.name ?? 'Error'}\n`);
  for (const handle of handles.reverse()) await handle.dispose().catch(() => {});
  for (const stop of stops.reverse()) try { stop(); } catch {}
  for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {});
  hook.deregister();
  process.exitCode = 1;
}
