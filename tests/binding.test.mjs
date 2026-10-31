import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBindingVerifier } from '../src/binding.mjs';

function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
const target = deepFreeze({ provider: 'synthetic-route', model: 'synthetic-model', baseURL: 'https://synthetic.invalid/v1', apiKeyEnv: 'SYNTHETIC_REF', reasoningEffort: 'max', maxTokens: 8192,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] });
const validProfile = () => ({ api: 'openai-completions', baseURL: target.baseURL, apiKeyEnv: target.apiKeyEnv,
  defaultContextWindow: 65536, defaultMaxTokens: 16384, defaultInput: ['text'],
  models: [{ id: target.model, reasoningEfforts: { max: 'max' } }] });
function harness() {
  const state = { revision: 1, profile: validProfile(), configured: true, listeners: new Set(), calls: [],
    directory: [{ provider: target.provider, declared: true, settingsNs: 'synthetic-settings', settingsPath: ['providers', target.provider] }],
    info: { provider: target.provider, id: target.model, context: { contextWindow: 65536 }, inputModalities: ['text'], reasoning: { efforts: [{ id: 'max' }] } },
  };
  const ctx = {
    llm: { listConfigurableProviders: () => structuredClone(state.directory), resolveModelInfo: async () => structuredClone(state.info) },
    settings: { describe(options) { state.calls.push(options); return [{ ns: 'synthetic-settings', revision: state.revision,
      value: { providers: { [target.provider]: structuredClone(state.profile) } } }]; } },
    credentials: { describe: async () => ({ configured: state.configured }) },
    on(event, callback) { assert.ok(['settings/updated', 'credentials/reference-updated'].includes(event)); state.listeners.add(callback); return () => state.listeners.delete(callback); },
  };
  return { state, ctx, checker: createBindingVerifier(ctx, target, v => ({ syntheticReference: v })) };
}
const hasCode = code => error => error.code === code && !error.message.includes('header-secret');

test('valid explicit route is verified without exposing profile or key data; ticket is one use', async () => {
  const { state, checker } = harness();
  const ticket = await checker.acquire(target);
  assert.deepEqual(Object.keys(ticket), []);
  assert.equal(JSON.stringify(ticket), '{}');
  assert.equal(await checker.verify(ticket, target), true);
  await assert.rejects(checker.verify(ticket, target), hasCode('INVALID_TICKET'));
  assert.ok(state.calls.every(x => x.redactSecrets === true));
  checker.dispose(); assert.equal(state.listeners.size, 0);
});

test('dispatch guard rejects configuration and credential events after verification', () => {
  for (const mutate of [
    s => { s.revision++; },
    s => { s.profile.defaultInput = ['text', 'image']; },
    s => { for (const fn of s.listeners) fn(); },
    s => { for (const fn of s.listeners) fn(target.apiKeyEnv); },
  ]) {
    const {state, checker} = harness();
    const guard = checker.captureDispatchGuard();
    guard(); mutate(state);
    assert.throws(guard, hasCode('CONFIG_CHANGED'));
    checker.dispose();
  }
});

test('rejects missing, ambiguous or undeclared directory and wrong route/model', async () => {
  { const { checker } = harness(); await assert.rejects(checker.acquire({ ...target, model: 'other' }), hasCode('ROUTE_MISMATCH'));
    const ticket = await checker.acquire(target); await assert.rejects(checker.verify(ticket, deepFreeze({ ...target, provider: 'other' })), hasCode('ROUTE_MISMATCH'));
    await assert.rejects(checker.verify(ticket, target), hasCode('INVALID_TICKET')); }
  for (const route of [{ ...target, reasoningEffort: 'high' }, { ...target, maxTokens: 16385 }, { ...target, reasoningEffort: undefined }]) {
    const { checker } = harness(); const ticket = await checker.acquire(target);
    await assert.rejects(checker.verify(ticket, deepFreeze(route)), hasCode('CALL_PARAMETERS'));
  }
  for (const mutate of [
    s => s.directory = [], s => s.directory.push({ ...s.directory[0] }), s => s.directory[0].declared = false,
    s => s.directory[0].settingsPath = [], s => s.profile.api = 'anthropic-messages',
    s => s.profile.baseURL = 'https://different.invalid/v1', s => s.profile.apiKeyEnv = 'OTHER_REF',
    s => s.profile.models = [{ id: 'other' }], s => s.profile.models.push({ ...s.profile.models[0] }),
  ]) {
    const { state, checker } = harness(); mutate(state);
    await assert.rejects(checker.acquire(target), e => e.name === 'BindingError'); checker.dispose();
  }
});

test('rejects unknown behavior, header values, aliasing efforts, unsupported modalities and capacities', async () => {
  const cases = [
    [s => s.profile.headers = { authorization: 'header-secret' }, 'CUSTOM_HEADERS'],
    [s => s.profile.compat = { arbitrary: true }, 'UNSUPPORTED_PROFILE'],
    [s => s.profile.transport = 'websocket', 'UNSUPPORTED_PROFILE'],
    [s => s.profile.models[0].compat = { arbitrary: true }, 'UNSUPPORTED_MODEL'],
    [s => s.profile.models[0].reasoningEfforts.max = 'high', 'UNSUPPORTED_REASONING'],
    [s => s.profile.defaultInput = ['text', 'audio'], 'UNSUPPORTED_INPUT'],
    [s => s.profile.defaultMaxTokens = 100, 'MODEL_CAPACITY'],
  ];
  for (const [mutate, code] of cases) {
    const { state, checker } = harness(); mutate(state);
    await assert.rejects(checker.acquire(target), hasCode(code)); checker.dispose();
  }
});

test('rejects missing credentials, bad model capability, config revision/value drift and events', async () => {
  { const { state, checker } = harness(); state.configured = false; await assert.rejects(checker.acquire(target), hasCode('CREDENTIAL_UNAVAILABLE')); }
  { const { state, checker } = harness(); state.info.inputModalities.push('image'); await assert.rejects(checker.acquire(target), hasCode('MODEL_INFO')); }
  for (const mutate of [s => s.revision++, s => s.profile.baseURL = 'https://changed.invalid', s => { for (const fn of s.listeners) fn(); }]) {
    const { state, checker } = harness(); const ticket = await checker.acquire(target); mutate(state);
    await assert.rejects(checker.verify(ticket, target), e => ['CONFIG_CHANGED', 'ROUTE_MISMATCH'].includes(e.code));
  }
});

test('changes during await and lookup failures reject without copying sensitive error messages', async () => {
  { const { state, ctx, checker } = harness(); ctx.credentials.describe = async () => { state.revision++; return { configured: true }; };
    await assert.rejects(checker.acquire(target), hasCode('CONFIG_CHANGED')); }
  { const { state, ctx, checker } = harness(); const ticket = await checker.acquire(target); ctx.credentials.describe = async () => { for (const fn of state.listeners) fn(); return { configured: true }; };
    await assert.rejects(checker.verify(ticket, target), hasCode('CONFIG_CHANGED')); }
  { const { ctx, checker } = harness(); ctx.llm.resolveModelInfo = async () => { throw new Error('header-secret'); };
    await assert.rejects(checker.acquire(target), hasCode('LOOKUP_FAILED')); }
  { const { ctx, checker } = harness(); ctx.settings.describe = () => { throw new Error('header-secret'); };
    await assert.rejects(checker.acquire(target), hasCode('SETTINGS_LOOKUP_FAILED')); }
  { const { state, checker } = harness(); const ticket = await checker.acquire(target); state.info.defaultMaxTokens = 7777;
    await assert.rejects(checker.verify(ticket, target), hasCode('MODEL_CHANGED')); }
});

test('a credential event status change, cancellation, disposal and invalid target fail closed', async () => {
  { const { state, checker } = harness(); const ticket = await checker.acquire(target); state.configured = false; await assert.rejects(checker.verify(ticket, target), hasCode('CREDENTIAL_UNAVAILABLE')); }
  { const { checker } = harness(); const ticket = await checker.acquire(target); const abort = new AbortController(); abort.abort(new Error('cancel'));
    await assert.rejects(checker.verify(ticket, target, abort.signal), hasCode('ABORTED'));
    await assert.rejects(checker.verify(ticket, target), hasCode('INVALID_TICKET')); checker.dispose(); }
  assert.throws(() => createBindingVerifier({}, { ...target, baseURL: 'http://synthetic.invalid/v1' }, x => x), hasCode('INVALID_TARGET'));
});

test('lookup rejection concurrent with cancellation never exposes service error or signal reason', async () => {
  const acquireCase = harness(); const firstAbort = new AbortController();
  acquireCase.ctx.credentials.describe = async () => { firstAbort.abort(new Error('header-secret signal')); throw new Error('header-secret lookup'); };
  await assert.rejects(acquireCase.checker.acquire(target, firstAbort.signal), hasCode('ABORTED'));
  const verifyCase = harness(); const ticket = await verifyCase.checker.acquire(target); const secondAbort = new AbortController();
  verifyCase.ctx.llm.resolveModelInfo = async () => { secondAbort.abort(new Error('header-secret signal')); throw new Error('header-secret lookup'); };
  await assert.rejects(verifyCase.checker.verify(ticket, target, secondAbort.signal), hasCode('ABORTED'));
});

test('model-specific supported limits take precedence and initial describe notification does not invalidate itself', async () => {
  const { state, ctx, checker } = harness();
  state.profile.models[0].contextWindow = 32768; state.profile.models[0].maxTokens = 9000;
  state.info.context.contextWindow = 32768;
  const describe = ctx.settings.describe; let initial = true;
  ctx.settings.describe = options => { if (initial) { initial = false; for (const fn of state.listeners) fn(); } return describe(options); };
  const ticket = await checker.acquire(target); assert.equal(await checker.verify(ticket, target), true);
});

test('invalid image, file, and unknown content fail closed', async () => {
  for (const block of [{ type: 'image' }, { type: 'file' }, { type: 'other' }]) {
    const { state, checker } = harness(); state.profile.defaultInput = ['text', 'image']; state.info.inputModalities = ['text', 'image'];
    const ticket = await checker.acquire(target);
    await assert.rejects(checker.verify(ticket, deepFreeze({ ...target, messages: [{ role: 'user', content: [block] }] })), hasCode('UNSUPPORTED_MESSAGE'));
  }
  const { state, checker } = harness(); state.profile.defaultInput = ['text', 'image']; state.info.inputModalities = ['text', 'image'];
  const ticket = await checker.acquire(target); assert.equal(await checker.verify(ticket, target), true);
  const missing = await checker.acquire(target); await assert.rejects(checker.verify(missing, deepFreeze({ ...target, messages: undefined })), hasCode('MESSAGES_UNAVAILABLE'));
});

test('valid user and tool images require an explicitly image-capable route', async () => {
  const block = {type:'image', attachment:{attachmentId:'sha256:synthetic', mediaType:'image/png', bytes:10, width:16, height:16}};
  for (const role of ['user', 'tool']) {
    const {state, checker}=harness();
    state.profile.defaultInput=['text','image']; state.info.inputModalities=['text','image'];
    const ticket=await checker.acquire(target);
    assert.equal(await checker.verify(ticket, deepFreeze({...target,messages:[{role,content:[block]}]})),true);
  }
  { const {checker}=harness(); const ticket=await checker.acquire(target);
    await assert.rejects(checker.verify(ticket, deepFreeze({...target,messages:[{role:'user',content:[block]}]})),hasCode('UNSUPPORTED_MESSAGE'));
    assert.throws(()=>checker.imagePolicy(),hasCode('UNSUPPORTED_INPUT')); }
  for (const blockVariant of [{...block,offloaded:true}, {...block,attachment:{...block.attachment,mediaType:'image/svg+xml'}}]) {
    const {state,checker}=harness(); state.profile.defaultInput=['text','image']; state.info.inputModalities=['text','image'];
    const ticket=await checker.acquire(target);
    await assert.rejects(checker.verify(ticket,deepFreeze({...target,messages:[{role:'user',content:[blockVariant]}]})),hasCode('UNSUPPORTED_MESSAGE'));
  }
});

test('image policy uses verified provider budgets and drift still invalidates the ticket', async () => {
  const {state,checker}=harness(); state.profile.defaultInput=['text','image']; state.info.inputModalities=['text','image'];
  state.profile.requestImagePixelBudget=12345; state.profile.requestImageMaxBytes=54321; state.profile.maxRequestImageBytes=98765;
  const ticket=await checker.acquire(target);
  assert.deepEqual(checker.imagePolicy(),{maxPixels:12345,maxBytes:54321,maxRequestImageBytes:98765});
  state.revision++;
  await assert.rejects(checker.verify(ticket,target),hasCode('CONFIG_CHANGED'));
});

test('verification requires deep-frozen dispatched messages and consumes a ticket before pre-abort', async () => {
  const { checker } = harness();
  const shallow = Object.freeze({ ...target, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }] });
  const ticket = await checker.acquire(target);
  await assert.rejects(checker.verify(ticket, shallow), hasCode('UNFROZEN_REQUEST'));
  await assert.rejects(checker.verify(ticket, target), hasCode('INVALID_TICKET'));
  const aborted = await checker.acquire(target); const signal = new AbortController(); signal.abort(new Error('secret'));
  await assert.rejects(checker.verify(aborted, target, signal.signal), hasCode('ABORTED'));
  await assert.rejects(checker.verify(aborted, target), hasCode('INVALID_TICKET'));
  const internalSlot = Object.freeze(new Map()); const mapTicket = await checker.acquire(target);
  const bad = deepFreeze({ ...target, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }], source: { extra: internalSlot } }] });
  await assert.rejects(checker.verify(mapTicket, bad), hasCode('UNFROZEN_REQUEST'));
  const getterTicket = await checker.acquire(target);
  const dynamic = { ...target }; Object.defineProperty(dynamic, 'provider', { get() { return target.provider; }, enumerable: true }); Object.freeze(dynamic);
  await assert.rejects(checker.verify(getterTicket, dynamic), hasCode('UNFROZEN_REQUEST'));
});

test('the verified frozen request cannot be changed during async lookup or after verification', async () => {
  const { ctx, checker } = harness(); const ticket = await checker.acquire(target); let attempted = false;
  ctx.credentials.describe = async () => {
    attempted = true;
    assert.throws(() => target.messages[0].content.push({ type: 'image' }), TypeError);
    assert.throws(() => { target.messages = []; }, TypeError);
    return { configured: true };
  };
  assert.equal(await checker.verify(ticket, target), true); assert.equal(attempted, true);
  assert.throws(() => target.messages[0].content.push({ type: 'image' }), TypeError);
  assert.equal(target.messages[0].content[0].type, 'text');
});


test('keeps the caller output limit within the configured capacity', async () => {
  for (const maxTokens of [4096, 12000, 16384]) {
    const { checker } = harness(); const ticket = await checker.acquire(target);
    const request = deepFreeze({ ...target, maxTokens });
    assert.equal(await checker.verify(ticket, request), true);
    assert.equal(request.maxTokens, maxTokens); checker.dispose();
  }
});
