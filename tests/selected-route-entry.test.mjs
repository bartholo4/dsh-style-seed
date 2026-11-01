import './_no-network.mjs';
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

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
if (!runtime) {
  test('selected route uses the DSH host', { skip: 'Set DSH_RUNTIME_NODE_MODULES to the DSH 0.2.2-alpha.2 node_modules directory' }, () => {});
} else {
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


const require = createRequire(join(runtime, '__synthetic_selected_entry.cjs'));
assert.equal(require('@deepseek-ai/dsh-llm-pi-ai/package.json').version, '0.2.2-alpha.2');
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
let requestTool = false, requestPartial = false;
globalThis.fetch = async (input, init) => {
  const url = String(input), spec = allowed[url];
  assert.ok(spec, 'fake fetch rejects every non-fixture URL');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), spec.auth);
  const body = JSON.parse(init.body);
  assert.equal(body.model, spec.model);
  requests.push({ url, body });
  if (requestPartial) {
    requestPartial = false;
    const chunk = { id: 'synthetic-partial', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { reasoning: 'synthetic-interrupted-reasoning' }, finish_reason: null }] };
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('synthetic canceled', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
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

test('selected-route entry with real AgentLoop and PiAiAdapter, entirely synthetic', { timeout: 30000 }, async t => {
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
      constructor(ctx) { super(ctx, 'storageDomain'); }
      async open() {
        const entries = new Map();
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
    fibers.push(await ctx.plugin(plugin, { enabled: true, followSelected: true, seedPath, firstTurnOnly: true }));
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
    await t.test('new sessions default off and selected route A works with first-turn seed, tools and images', async () => {
      const off = await create('synthetic-off', routes.a, false), offStart = requests.length;
      off.followup(user([text('synthetic-off-user')])); await off.whenIdle();
      assert.equal(lastTurn(off)?.kind, 'completed');
      assert.equal(requests.length - offStart, 1);
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
      const agent = await create('synthetic-a-enabled', routes.a, true), start = requests.length;
      requestTool = true;
      agent.followup(user([text('synthetic-before-user-image'), image('a'), text('synthetic-after-user-image')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.doesNotMatch(JSON.stringify(agent.session.snapshotEvents()),/synthetic-seed-user|synthetic-seed-reasoning|dsh-style-seed-reference/);
      assert.equal(toolCalls, 1);
      assert.equal(requests.length - start, 2);
      const [initial, continued] = requests.slice(start);
      for (const req of [initial, continued]) {
        assert.equal(req.url, 'https://alpha.synthetic.invalid/v1/chat/completions');
        assert.deepEqual(seedCounts(req.body), fullSeed);
        assert.equal(req.body.model, 'model-a');
        assert.equal(req.body.max_completion_tokens, 901);
        assert.equal(req.body.temperature, 0.2);
        assert.equal(req.body.reasoning_effort, 'high');
        assert.ok(req.body.messages.some(message => ['system', 'developer'].includes(message.role) && String(message.content).includes('synthetic system prompt')));
        assert.ok(req.body.tools.some(tool => tool.function?.name === 'read_image'));
      }
      const userImage = initial.body.messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.image_url?.url === dataUrl('a')));
      assert.ok(userImage);
      const userBefore = userImage.content.findIndex(block => block.text === 'synthetic-before-user-image');
      const userPicture = userImage.content.findIndex(block => block.image_url?.url === dataUrl('a'));
      const userAfter = userImage.content.findIndex(block => block.text === 'synthetic-after-user-image');
      assert.ok(userBefore < userPicture && userPicture < userAfter);
      const resultIndex = continued.body.messages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'call_synthetic');
      assert.ok(resultIndex > 0);
      const imageGroup = continued.body.messages[resultIndex + 1];
      assert.equal(imageGroup.role, 'user');
      const parts = imageGroup.content, label = parts.findIndex(block => block.text?.includes('call_synthetic'));
      const before = parts.findIndex(block => block.text === 'synthetic-tool-before');
      const picture = parts.findIndex(block => block.image_url?.url === dataUrl('b'));
      const after = parts.findIndex(block => block.text === 'synthetic-tool-after');
      assert.ok(label >= 0 && label < before && before < picture && picture < after);
      agent.followup(user([text('synthetic-followup')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed');
      assert.equal(requests.length - start, 3);
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
      assert.ok(requests.at(-1).body.messages.some(message => message.role === 'user' && message.content === 'synthetic-followup'));
    });
    await t.test('canceled native reasoning-only history retries with seed without legacy rewriting', async () => {
      const agent = await create('synthetic-abort-retry', routes.a, true), start = requests.length;
      const stop = agent.ctx.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') agent.cancel({ kind: 'user' });
      });
      requestPartial = true;
      agent.followup(user([text('synthetic-cancel-first')])); await agent.whenIdle(); stop();
      assert.equal(lastTurn(agent)?.kind, 'aborted');
      assert.deepEqual(seedCounts(requests.at(-1).body), fullSeed);
      const partial = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message');
      assert.equal(partial.data.interrupted, true);
      assert.deepEqual(partial.data.message.content, [{ type: 'reasoning', text: 'synthetic-interrupted-reasoning' }]);
      assert.equal(partial.data.message.source.replayState, undefined);
      const durable = JSON.stringify(partial);
      agent.followup(user([text('synthetic-retry-after-cancel')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.equal(requests.length, start + 2);
      assert.deepEqual(seedCounts(requests.at(-1).body), fullSeed);
      assert.equal(JSON.stringify(agent.session.snapshotEvents().find(event => event === partial)), durable);
      assert.doesNotMatch(JSON.stringify(agent.session.snapshotEvents()), /synthetic-seed-user|synthetic-seed-reasoning/);
      agent.followup(user([text('synthetic-after-success')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed');
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
    });
    await t.test('missing configured output cap reports configuration rather than a full context', async () => {
      const agent = await create('synthetic-missing-output-cap', { ...routes.a, maxTokens: undefined }, true);
      const start = requests.length;
      agent.followup(user([text('synthetic-no-cap')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'error');
      assert.match(lastTurn(agent)?.error?.message ?? '', /maxTokens/);
      assert.doesNotMatch(lastTurn(agent)?.error?.message ?? '', /上下文已满/);
      assert.equal(requests.length, start);
      assert.equal((await set(agent.id, false)).ok, true);
      agent.followup(user([text('synthetic-off-no-cap')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed');
      assert.deepEqual(seedCounts(requests.at(-1).body), noSeed);
    });
    await t.test('new enabled session follows route B, its endpoint, synthetic key, model and controls', async () => {
      const agent = await create('synthetic-b-enabled', routes.b, true), start = requests.length;
      agent.followup(user([text('synthetic-b-question')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.equal(requests.length - start, 1);
      const req = requests.at(-1);
      assert.equal(req.url, 'https://beta.synthetic.invalid/custom/v1/chat/completions');
      assert.equal(req.body.model, 'model-b');
      assert.equal(req.body.max_tokens, 1202);
      assert.equal(req.body.temperature, 0.7);
      assert.equal(req.body.reasoning_effort, 'max');
      assert.deepEqual(seedCounts(req.body), fullSeed);
      assert.ok(req.body.messages.some(message => message.role === 'user' && message.content === 'synthetic-b-question'));
    });
    await t.test('unsupported protocol can be disabled at idle and the original provider used', async () => {
      const agent = await create('synthetic-unsupported', routes.c, true), start = requests.length;
      agent.followup(user([text('synthetic-unsupported-question')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'error');
      assert.equal(requests.length, start, 'unsupported seeded protocol fails before dispatch');
      const status = await get(agent.id);
      assert.equal(status.ok, true);
      assert.equal(status.value.editable, true);
      assert.equal(status.value.enabled, true);
      const disabled = await set(agent.id, false);
      assert.equal(disabled.ok, true);
      assert.equal(disabled.value.enabled, false);
      agent.followup(user([text('synthetic-after-disable')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.equal(requests.length - start, 1);
      assert.equal(requests.at(-1).url, 'https://gamma.synthetic.invalid/v1/responses');
    });
    await t.test('a provider without an inspectable profile works after disabling the new switch',async()=>{
      const route={provider:'synthetic-opaque',model:'opaque-model',maxTokens:256};
      const agent=await create('synthetic-opaque-session',route,true),start=opaqueCalls.length;
      agent.followup(user([text('synthetic first question')]));await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind,'error');assert.equal(opaqueCalls.length,start);
      assert.equal((await set(agent.id,false)).ok,true);
      agent.followup(user([text('synthetic next question')]));await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind,'completed');assert.equal(opaqueCalls.length,start+1);
      assert.doesNotMatch(JSON.stringify(opaqueCalls.at(-1).messages),/synthetic-seed-user|dsh-style-seed-reference/);
    });
    await t.test('native DeepSeek Messages adapter carries seed thinking, user image and tool image', async () => {
      const agent = await create('synthetic-deepseek-enabled', routes.d, true), start = requests.length;
      requestTool = true;
      agent.followup(user([text('synthetic-deepseek-before'), image('a'), text('synthetic-deepseek-after')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.equal(requests.length - start, 2);
      const [initial, continued] = requests.slice(start);
      for (const req of [initial, continued]) {
        assert.equal(req.url, 'https://deepseek.synthetic.invalid/v1/messages');
        assert.equal(req.body.model, 'messages-model');
        assert.equal(req.body.max_tokens, 1403);
        assert.equal(req.body.output_config.effort, 'high');
        assert.ok(req.body.system.includes('synthetic system prompt'));
        assert.ok(req.body.tools.some(tool => tool.name === 'read_image'));
        const content = req.body.messages.flatMap(message => message.content);
        assert.ok(content.some(block => block.type === 'text' && block.text === 'synthetic-seed-user'));
        assert.ok(content.some(block => block.type === 'text' && block.text === 'synthetic-seed-answer'));
        const reasoning = content.find(block => block.type === 'thinking' && block.thinking === 'synthetic-seed-reasoning');
        assert.ok(reasoning);
        assert.equal(reasoning.signature, undefined);
      }
      const userContent = initial.body.messages.flatMap(message => message.content);
      assert.ok(userContent.some(block => block.type === 'image' && block.source?.type === 'base64' && block.source.data === imageData.get(imageRef('a').attachmentId).toString('base64')));
      const continuation = continued.body.messages.flatMap(message => message.content);
      const tool = continuation.find(block => block.type === 'tool_result' && block.tool_use_id === 'call_synthetic');
      assert.ok(tool);
      const before = tool.content.findIndex(block => block.text === 'synthetic-tool-before');
      const picture = tool.content.findIndex(block => block.type === 'image' && block.source?.type === 'base64' && block.source.data === imageData.get(imageRef('b').attachmentId).toString('base64'));
      const after = tool.content.findIndex(block => block.text === 'synthetic-tool-after');
      assert.ok(before >= 0 && before < picture && picture < after);
      agent.followup(user([text('synthetic-deepseek-followup')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed');
      assert.equal(requests.length - start, 3);
      const later = requests.at(-1).body.messages.flatMap(message => message.content);
      assert.ok(!later.some(block => block.type === 'thinking' && block.thinking === 'synthetic-seed-reasoning'));
      assert.ok(!later.some(block => block.type === 'text' && block.text === 'synthetic-seed-user'));
    });
    await t.test('catalog provider without explicit api uses native protocol and its reasoning field', async () => {
      const snapshot = selectedRouteSnapshot(pluginContext, routes.catalog);
      assert.equal(snapshot.api, 'openai-completions');
      assert.equal(snapshot.reasoningContent, true);
      const agent = await create('synthetic-catalog', routes.catalog, true), start = requests.length;
      agent.followup(user([text('synthetic-catalog-question')])); await agent.whenIdle();
      assert.equal(lastTurn(agent)?.kind, 'completed', JSON.stringify(lastTurn(agent)));
      assert.equal(requests.length - start, 1);
      const req = requests.at(-1);
      assert.equal(req.url, 'https://catalog.synthetic.invalid/v1/chat/completions');
      assert.equal(req.body.model, 'deepseek-flash');
      assert.equal(req.body.max_tokens, 1604);
      assert.equal(req.body.reasoning_effort, 'max');
      const sample = req.body.messages.find(message => message.role === 'assistant' && message.content === 'synthetic-seed-answer');
      assert.equal(sample.reasoning_content, 'synthetic-seed-reasoning');
    });
    await t.test('settings revision drift fails before the selected provider fetch', async () => {
      const agent = await create('synthetic-drift', routes.a, true), start = requests.length;
      describeCount = 0; driftOnSecond = true;
      try {
        agent.followup(user([text('synthetic-drift-question')])); await agent.whenIdle();
        assert.equal(lastTurn(agent)?.kind, 'error');
        assert.ok(describeCount >= 2);
        assert.equal(requests.length, start);
      } finally { driftOnSecond = false; }
    });
    assert.equal(networkAttempts, 0);
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    for (const stop of stops.reverse()) stop();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    hook.deregister();
    assert.equal(networkAttempts, 0);
  }
});

}
