// KNOWN DEFECT CHARACTERIZATION: passing asserts reproduce unsafe .13 behavior.
// This is not evidence that unload/reload is safe. The fixture uses alpha.2
// host code, in-memory synthetic data and a network-blocked fake fetch.
// Run with DSH_RUNTIME_NODE_MODULES pointing at the alpha.2 runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

// Entire fixture is synthetic and held in memory. No real network fallback,
// session file, credential store, attachment, or seed file is consulted.
let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('NETWORK DISABLED'); };
net.Socket.prototype.connect = denyNetwork;
net.connect = net.createConnection = tls.connect = http.request = http.get = https.request = https.get = denyNetwork;
const seedPath = resolve('synthetic-memory-seed.json');
const seedBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'synthetic', provenance: {}, messages: [
  { role: 'user', content: 'synthetic-seed-user' },
  { role: 'assistant', content: 'synthetic-seed-answer', reasoning: 'synthetic-seed-reasoning', source: { provider: 'synthetic-origin', model: 'synthetic-origin' } },
] }));
fsPromises.open = async (path, mode) => {
  assert.equal(String(path), seedPath, 'unexpected file open is forbidden');
  assert.equal(mode, 'r');
  let offset = 0;
  return {
    stat: async () => ({ isFile: () => true }),
    async read(buffer, position, length) {
      const count = Math.min(length, seedBytes.length - offset);
      seedBytes.copy(buffer, position, offset, offset + count);
      offset += count;
      return { bytesRead: count, buffer };
    },
    close: async () => {},
  };
};
syncBuiltinESMExports();

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
if (!runtime) {
  test('known lifecycle defect characterization', { skip: 'Set DSH_RUNTIME_NODE_MODULES to the alpha.2 runtime node_modules' }, () => {});
} else {
const require = createRequire(join(runtime, '__synthetic_selected_entry.cjs'));
for (const name of ['dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-llm-pi-ai']) {
  assert.equal(require(`@deepseek-ai/${name}/package.json`).version, '0.2.2-alpha.2');
}
assert.equal(require('@deepseek-ai/cordis/package.json').version, '4.0.6-alpha.1');
const names = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-remote-access',
  '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-storage-domain', 'zod'];
const paths = new Map(names.map(name => [name, pathToFileURL(require.resolve(name)).href]));
paths.set('@earendil-works/pi-ai/providers/all', pathToFileURL(join(runtime, '@earendil-works/pi-ai/dist/providers/all.js')).href);
const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });

const routes = {
  a: { provider: 'synthetic-a', model: 'model-a', reasoningEffort: 'high', maxTokens: 901, temperature: 0.2 },
  b: { provider: 'synthetic-b', model: 'model-b', reasoningEffort: 'max', maxTokens: 1202, temperature: 0.7 },
  c: { provider: 'synthetic-c', model: 'model-c' },
  d: { provider: 'deepseek-official', model: 'messages-model', reasoningEffort: 'high', maxTokens: 1403 },
  catalog: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 1604 },
};
const profiles = {
  deepseek: { baseURL: 'https://catalog.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_CATALOG', models: [{ id: 'deepseek-flash' }] },
  'synthetic-a': { api: 'openai-completions', baseURL: 'https://alpha.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_A',
    defaultInput: ['text', 'image'], models: [{ id: 'model-a', reasoningEfforts: { high: 'high', max: 'max' } }],
    compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_completion_tokens' } },
  'synthetic-b': { api: 'openai-completions', baseURL: 'https://beta.synthetic.invalid/custom/v1', apiKeyEnv: 'SYNTHETIC_B',
    defaultInput: ['text', 'image'], models: [{ id: 'model-b', reasoningEfforts: { high: 'high', max: 'max' } }],
    compat: { thinkingFormat: 'openai', maxTokensField: 'max_tokens' } },
  'synthetic-c': { api: 'openai-responses', baseURL: 'https://gamma.synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_C',
    defaultInput: ['text'], models: [{ id: 'model-c' }] },
};
const allowed = {
  'https://alpha.synthetic.invalid/v1/chat/completions': { auth: 'Bearer synthetic-key-a', model: 'model-a' },
  'https://beta.synthetic.invalid/custom/v1/chat/completions': { auth: 'Bearer synthetic-key-b', model: 'model-b' },
  'https://gamma.synthetic.invalid/v1/responses': { auth: 'Bearer synthetic-key-c', model: 'model-c' },
  'https://deepseek.synthetic.invalid/v1/messages': { auth: 'Bearer synthetic-key-d', model: 'messages-model' },
  'https://catalog.synthetic.invalid/v1/chat/completions': { auth: 'Bearer synthetic-key-catalog', model: 'deepseek-flash' },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const imageData = new Map([[`sha256:${'a'.repeat(64)}`, png], [`sha256:${'b'.repeat(64)}`, Buffer.concat([png, Buffer.from([1])])]]);
const imageRef = char => ({ attachmentId: `sha256:${char.repeat(64)}`, mediaType: 'image/png', bytes: imageData.get(`sha256:${char.repeat(64)}`).length,
  width: 1, height: 1, name: `synthetic-${char}.png` });
const image = char => ({ type: 'image', attachment: imageRef(char) });
const text = value => ({ type: 'text', text: value });
const dataUrl = char => `data:image/png;base64,${imageData.get(`sha256:${char.repeat(64)}`).toString('base64')}`;
const requests = [];
let requestTool = false;
globalThis.fetch = async (input, init) => {
  const url = String(input), spec = allowed[url];
  assert.ok(spec, 'fake fetch rejects every non-fixture URL');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), spec.auth);
  const body = JSON.parse(init.body);
  assert.equal(body.model, spec.model);
  requests.push({ url, body });
  if (url.endsWith('/messages')) {
    const tool = requestTool;
    requestTool = false;
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'synthetic-native-thinking' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: tool
        ? { type: 'tool_use', id: 'call_synthetic', name: 'read_image', input: {} }
        : { type: 'text', text: 'synthetic-deepseek-answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  if (url.endsWith('/responses')) {
    const item = { id: 'synthetic-item', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic-response-answer', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'synthetic-response', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'synthetic-response-answer' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'synthetic-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  const tool = requestTool;
  requestTool = false;
  const delta = tool
    ? { reasoning: 'synthetic-reply-reasoning', tool_calls: [{ index: 0, id: 'call_synthetic', type: 'function', function: { name: 'read_image', arguments: '{}' } }] }
    : { reasoning: 'synthetic-reply-reasoning', content: 'synthetic-answer' };
  const chunk = { id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const seedCounts = body => ({
  user: body.messages.filter(message => message.role === 'user' && message.content === 'synthetic-seed-user').length,
  answer: body.messages.filter(message => message.role === 'assistant' && message.content === 'synthetic-seed-answer').length,
  reasoning: body.messages.filter(message => message.reasoning === 'synthetic-seed-reasoning').length,
});
const fullSeed = { user: 1, answer: 1, reasoning: 1 }, noSeed = { user: 0, answer: 0, reasoning: 0 };
const lastTurn = agent => agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason;

test('disposal race with actual alpha.2 host services and in-memory synthetic fixtures', { timeout: 30000 }, async t => {
  const fibers = [], handles = [], stops = [];
  let revision = 1, driftOnSecond = false, describeCount = 0, toolCalls = 0;
  try {
    const [{ Context, Service }, { AgentRegistry, installModelSelection }, { AgentLoop }, { LlmRuntime, LlmAdapter, createUserMessage }, pi, deepseek,
      { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime, defineTool }, { TypertRegistry },
      { RemoteAccessService }, { TypertGatewayService }, plugin] = await Promise.all([
      import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-llm'),
      import('@deepseek-ai/dsh-llm-pi-ai'), import('@deepseek-ai/dsh-llm-deepseek'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
      import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-typert-registry'),
      import('@deepseek-ai/dsh-api-remote-access'), import('@deepseek-ai/dsh-api-gateway'), import('../src/index.mjs'),
    ]);
    class FakeSettings extends Service {
      constructor(ctx) { super(ctx, 'settings'); }
      configure() { return () => {}; }
      describe() {
        describeCount++;
        if (driftOnSecond && describeCount === 2) revision++;
        return [{ ns: 'llm-pi-ai', revision, value: { providers: structuredClone(profiles) } },
          { ns: 'llm-deepseek-api-key-synthetic', revision, value: {} }];
      }
    }
    class FakeCredentials extends Service {
      constructor(ctx) { super(ctx, 'credentials'); this.records = new Map(); }
      async resolve(ref) {
        const value = { SYNTHETIC_A: 'synthetic-key-a', SYNTHETIC_B: 'synthetic-key-b', SYNTHETIC_C: 'synthetic-key-c', SYNTHETIC_CATALOG: 'synthetic-key-catalog' }[ref];
        if (!value) throw new Error('unexpected credential reference');
        return { value };
      }
      async modifyRecord(key, fn) { const next = await fn(this.records.get(key)); if (next !== undefined) this.records.set(key, next); }
      async readRecord(key) { return this.records.get(key); }
      async listRecords() { return []; }
    }
    class FakeStorageDomain extends Service {
      constructor(ctx) { super(ctx, 'storageDomain'); this.domains = new Map(); }
      async open(spec) {
        if (!this.domains.has(spec.name)) this.domains.set(spec.name, new Map());
        const entries = this.domains.get(spec.name);
        return { table: () => ({ get: key => entries.get(key), put: async (key, value) => entries.set(key, value), delete: async key => entries.delete(key) }), close: async () => {} };
      }
    }
    class FakeDefaultModel extends Service {
      constructor(ctx) { super(ctx, 'agentDefaultModel'); }
      currentSelection() { return routes.a; }
    }
    class FakeAttachments extends Service {
      constructor(ctx) { super(ctx, 'attachments'); }
      imageHostPath() { return undefined; }
      async readImageRequest(ref, _target, signal) {
        signal?.throwIfAborted();
        const data = imageData.get(ref.attachmentId);
        assert.ok(data, 'attachment is synthetic');
        return { data: Uint8Array.from(data), bytes: data.length, mediaType: 'image/png', width: 1, height: 1 };
      }
    }
    const opaqueCalls=[];
    class OpaqueAdapter extends LlmAdapter {
      async resolveModel(provider,model) { return {provider,id:model,name:model,context:{contextWindow:1000000},
        inputModalities:['text'],defaultMaxTokens:1024}; }
      async *stream(options) {
        opaqueCalls.push(options);
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text:'synthetic opaque reply'};
        yield {type:'block-end',index:0,block:{type:'text',text:'synthetic opaque reply'}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    const ctx = new Context();
    for (const service of [SessionStore, SessionProjectionRegistry, AgentRegistry, LlmRuntime, TypertRegistry, RemoteAccessService,
      FakeSettings, FakeCredentials, FakeStorageDomain, FakeDefaultModel, FakeAttachments]) fibers.push(await ctx.plugin(service));
    fibers.push(await ctx.plugin(SystemPrompt, { includeRuntimeContext: false, personaPrefix: 'synthetic system prompt' }));
    fibers.push(await ctx.plugin(ToolRuntime, {}));
    fibers.push(await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'), {}));
    stops.push(ctx.tools.register(defineTool({ name: 'read_image', description: 'Return a synthetic image.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [text(value), image('b'), text('synthetic-tool-after')] },
      execute: async () => { toolCalls++; return 'synthetic-tool-before'; } })));
    fibers.push(await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }));
    fibers.push(await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 10000, streamInboxBytes: 65536 }));
    fibers.push(await ctx.plugin(pi, { providers: structuredClone(profiles) }));
    const deepseekOptions = deepseek.resolveAdapterOptions({ baseURL: 'https://deepseek.synthetic.invalid',
      models: [{ id: 'messages-model', inputModalities: ['text', 'image'] }] });
    const deepseekAdapter = new deepseek.DeepSeekAdapter({
      options: () => deepseekOptions,
      resolveAuth: async () => ({ headers: { authorization: 'Bearer synthetic-key-d' } }),
      resolveUserId: () => 'synthetic-user',
      resolveAttachments: () => ctx.get('attachments'),
      // Force the official adapter's inline fallback without attempting an upload.
      resolveFiles: () => ({ ensureUploaded: async () => { throw new Error('synthetic upload unavailable'); } }),
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    stops.push(ctx.llm.registerAdapter(['deepseek-official'], deepseekAdapter));
    stops.push(ctx.llm.registerAdapter(['synthetic-opaque'],new OpaqueAdapter()));
    stops.push(ctx.llm.registerConfigurableProviders([{ provider: 'deepseek-official', displayName: 'Synthetic DeepSeek',
      settingsNs: 'llm-deepseek-api-key-synthetic', settingsPath: [], declared: true }]));
    let pluginFiber = await ctx.plugin(plugin, { enabled: true, followSelected: true, seedPath, firstTurnOnly: true });
    fibers.push(pluginFiber);
    const pluginContext = fibers.at(-1).ctx;
    const { selectedRouteSnapshot } = await import('../src/selected-route.mjs');
    const configured = ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'synthetic-a');
    assert.equal(configured?.settingsNs, 'llm-pi-ai');
    assert.equal(selectedRouteSnapshot(ctx, routes.a).api, 'openai-completions');
    assert.equal(selectedRouteSnapshot(pluginContext, routes.a).api, 'openai-completions');
    const signal = new AbortController().signal, owner = { principal: { kind: 'owner' }, signal };
    const gateway = ctx.get('typertGateway');
    const get = id => gateway.invokeRpc('dsh-style-seed-switch/get', { args: { sessionId: id } }, signal, owner);
    const set = (id, enabled) => gateway.invokeRpc('dsh-style-seed-switch/set', { args: { sessionId: id, enabled } }, signal, owner);
    const user = content => createUserMessage({ source: { kind: 'user' }, content });
    async function create(id, route, enabled) {
      const selection = { current: route, assembled: undefined };
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: route, setup: agentCtx => {
        installModelSelection(agentCtx, selection);
        agentCtx.on('agent/request', async (_payload, next) => {
          const result = await next();
          return route.temperature === undefined ? result : { ...result, temperature: route.temperature };
        }, { prepend: true });
      } });
      handles.push(handle);
      const status = await get(id);
      assert.equal(status.ok, true);
      assert.equal(status.value.enabled, false);
      if (enabled) assert.equal((await set(id, true)).ok, true);
      return handle.agent;
    }
    const deadline = (promise, label) => Promise.race([promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 4000);
      promise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    })]);
    let interruptedAgent;
    await t.test('characterizes .13: teardown during route resolution can lose claimed input', async () => {
      const agent = await create('synthetic-dispose-preparing', routes.a, true);
      interruptedAgent = agent;
      const reached = Promise.withResolvers(), resume = Promise.withResolvers();
      stops.push(agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next();
        reached.resolve();
        await resume.promise;
        return result;
      }));
      agent.followup(user([text('synthetic-claimed-input')]));
      await deadline(reached.promise, 'request pause');
      const baseline = requests.length;
      const disposing = pluginFiber.dispose();
      try {
        let closing = false;
        for (let i = 0; i < 100; i++) {
          await Promise.resolve();
          if (ctx.get('switchContract')?.contract.get(agent.id).editable === false) { closing = true; break; }
        }
        assert.equal(closing, true, 'the plugin has entered its closing gate');
      } finally { resume.resolve(); }
      await deadline(disposing, 'plugin disposal');
      await deadline(agent.whenIdle(), 'agent idle');
      const events = agent.session.snapshotEvents();
      const committed = events.filter(event => event.type === 'user/message' &&
        event.data.content?.some(block => block.type === 'text' && block.text === 'synthetic-claimed-input'));
      const reason = lastTurn(agent)?.kind;
      console.log('CHARACTERIZATION route preparation', JSON.stringify({ committed: committed.length, requests: requests.length - baseline, reason }));
      assert.equal(committed.length, 0, 'current behavior removes the claimed input before commit');
      assert.equal(requests.length, baseline, 'current behavior ends without a model request');
      assert.notEqual(reason, 'completed');
    });
    await t.test('characterizes .13: an unseeded first reply during an outage remains unseeded after reloading', async () => {
      const pending = ctx.get('storageDomain').domains.get('style_seed_admission_v2').get(interruptedAgent.id);
      assert.equal(pending?.state, 'pending');
      assert.equal(pending?.mode, 'sidecar-only');
      const beforeOffline = requests.length;
      interruptedAgent.followup(user([text('synthetic-first-without-plugin')]));
      await deadline(interruptedAgent.whenIdle(), 'offline followup');
      assert.equal(requests.length, beforeOffline + 1);
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
      assert.equal(lastTurn(interruptedAgent)?.kind, 'completed');
      pluginFiber = await ctx.plugin(plugin, { enabled: true, followSelected: true, seedPath, firstTurnOnly: true });
      fibers.push(pluginFiber);
      const restored = await get(interruptedAgent.id);
      assert.equal(restored.ok, true);
      assert.equal(restored.value.enabled, true);
      const beforeResume = requests.length;
      interruptedAgent.followup(user([text('synthetic-after-plugin-reload')]));
      await deadline(interruptedAgent.whenIdle(), 'post-reload followup');
      assert.equal(requests.length, beforeResume + 1);
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
      assert.equal(lastTurn(interruptedAgent)?.kind, 'completed');
      console.log('CHARACTERIZATION offline completed turn', JSON.stringify({ restoredEnabled: restored.value.enabled,
        offlineSeed: seedCounts(requests[beforeOffline].body), resumedSeed: seedCounts(requests.at(-1).body) }));
    });
    await t.test('characterizes .13: enqueue after final idle snapshot can silently omit the seed', async () => {
      const agent = await create('synthetic-dispose-window', routes.a, true);
      const originalList = ctx.agents.list.bind(ctx.agents);
      let idleSnapshots = 0, inserted = false;
      const baseline = requests.length;
      ctx.agents.list = function () {
        const agents = originalList();
        if (agents.every(item => item.status === 'idle') && ++idleSnapshots === 2) {
          queueMicrotask(() => { inserted = true; agent.followup(user([text('synthetic-late-input')])); });
        }
        return agents;
      };
      try {
        await deadline(pluginFiber.dispose(), 'window disposal');
        await deadline(agent.whenIdle(), 'late agent idle');
      } finally { ctx.agents.list = originalList; }
      const events = agent.session.snapshotEvents();
      const committed = events.filter(event => event.type === 'user/message' &&
        event.data.content?.some(block => block.type === 'text' && block.text === 'synthetic-late-input'));
      const actual = requests.slice(baseline);
      console.log('CHARACTERIZATION final idle window', JSON.stringify({ idleSnapshots, inserted, committed: committed.length,
        requests: actual.length, seed: actual.map(request => seedCounts(request.body)), reason: lastTurn(agent)?.kind }));
      assert.equal(inserted, true);
      assert.equal(committed.length, 1);
      assert.equal(actual.length, 1);
      assert.deepEqual(seedCounts(actual[0].body), noSeed, 'current behavior routes without the requested seed');
      assert.equal(lastTurn(agent)?.kind, 'completed');
    });
    await t.test('characterizes legacy marker after an offline plugin removal', async () => {
      const { createReferenceCodec } = await import('../src/reference.mjs');
      const id = 'synthetic-legacy-after-removal';
      const selection = { current: routes.a, assembled: undefined };
      const handle = await ctx.agents.create({ sessionId: id, agentOptions: routes.a,
        setup: agentCtx => { installModelSelection(agentCtx, selection); } });
      handles.push(handle);
      const codec = createReferenceCodec('synthetic-signing-key', Buffer.alloc(32, 7));
      const marker = createUserMessage({ source: codec.source('a'.repeat(64), id),
        content: [text('[History template enabled]')] });
      handle.agent.session.append('user/message', marker, { surfaceOp: 'append' });
      const before = requests.length;
      handle.agent.followup(user([text('synthetic-question-after-removal')]));
      await deadline(handle.agent.whenIdle(), 'legacy continuation');
      assert.equal(requests.length, before + 1);
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
      assert.ok(requests.at(-1).body.messages.some(message => message.role === 'user' &&
        message.content === '[History template enabled]'));
      assert.equal(lastTurn(handle.agent)?.kind, 'completed');
      console.log('CHARACTERIZATION offline legacy marker', JSON.stringify({ markerSent: true, seed: seedCounts(requests.at(-1).body) }));
    });
    assert.equal(networkAttempts, 0);
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    for (const stop of stops.reverse()) stop();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    hook.deregister();
  }
});
}
