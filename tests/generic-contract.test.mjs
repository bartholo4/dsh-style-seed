import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenericSwitchContract } from '../src/generic-contract.mjs';

const sha = 'a'.repeat(64);
const record = (id, state) => ({ owner: id, sha256: sha, state });
const later = () => Promise.withResolvers();

function host(id = 'synthetic') {
  const events = [], records = new Map(), controls = {};
  const session = { id, header: { id }, snapshotEvents: () => [...events] };
  const agent = { id, session, status: 'idle' };
  const sessionMap = new Map([[id, session]]), agentMap = new Map([[id, agent]]);
  const store = {
    get(key) { if (controls.getError) throw controls.getError; return records.get(key); },
    async disable(key, digest) {
      if (controls.disable) return controls.disable(key, digest);
      const old = records.get(key);
      if (!old || old.owner !== key || old.sha256 !== digest) throw new Error('invalid synthetic identity');
      const saved = { ...old, state: 'disabled' }; records.set(key, saved); return saved;
    },
    async abandonPending(key, digest) {
      if (controls.abandon) return controls.abandon(key, digest);
      const old = records.get(key);
      if (!old || old.owner !== key || old.sha256 !== digest || !['pending', 'skipped'].includes(old.state)) throw new Error('invalid synthetic identity');
      records.delete(key); return true;
    },
  };
  const dependencies = {
    sessions: { get: key => sessionMap.get(key) }, agents: { get: key => agentMap.get(key) },
    store, defaultSelection: () => { throw new Error('selection must not be queried'); },
    isManaged: target => target === agent,
  };
  return { id, events, records, controls, session, agent, sessionMap, agentMap, store, dependencies,
    contract: createGenericSwitchContract(dependencies) };
}

test('new top-level session defaults off and can be toggled before starting', async () => {
  const h = host(), c = h.contract;
  assert.deepEqual(c.get(h.id), { editable: true, enabled: false, support: 'unknown', admission: null });
  assert.deepEqual(await c.set(h.id, true), { editable: true, enabled: true, support: 'unknown', admission: null });
  assert.deepEqual(await c.set(h.id, false), { editable: true, enabled: false, support: 'unknown', admission: null });
  h.agent.status = 'running';
  assert.equal(c.get(h.id).editable, false);
  await assert.rejects(c.set(h.id, true), /not editable/);
  h.agent.status = 'idle'; h.session.header.parentSession = 'parent';
  assert.equal(c.get(h.id).editable, false);
  await assert.rejects(c.set(h.id, true), /not editable/);
  await c.close();
});

test('old pending or skipped blank records can be abandoned before reopening', async () => {
  for (const state of ['pending', 'skipped']) {
    const h = host(state), c = h.contract;
    h.records.set(h.id, record(h.id, state));
    assert.equal(c.get(h.id).enabled, false);
    const opened = await c.set(h.id, true);
    assert.equal(opened.enabled, true);
    assert.equal(opened.admission, null);
    assert.equal(h.records.has(h.id), false);
    assert.equal((await c.set(h.id, false)).enabled, false);
    await c.close();
  }
});

test('nonblank active and pending records disable durably and stay off on restore', async () => {
  for (const state of ['active', 'pending']) {
    const h = host(state), c = h.contract;
    h.events.push({ type: 'turn/start' }, { type: 'user/message' });
    h.records.set(h.id, record(h.id, state));
    assert.deepEqual(c.get(h.id), { editable: true, enabled: true, support: 'unknown', admission: state });
    assert.deepEqual(await c.set(h.id, false), { editable: false, enabled: false, support: 'unknown', admission: 'disabled' });
    assert.deepEqual(h.records.get(h.id), record(h.id, 'disabled'));
    await assert.rejects(c.set(h.id, true), /not editable/);
    await c.closeAgent(h.agent);
    h.agentMap.delete(h.id);
    assert.deepEqual(c.get(h.id), { editable: false, enabled: false, support: 'unknown', admission: 'disabled', savedOnly: true });
    h.agentMap.set(h.id, h.agent);
    const restored = createGenericSwitchContract(h.dependencies);
    assert.equal(restored.get(h.id).enabled, false);
    assert.equal(restored.get(h.id).editable, false);
    await assert.rejects(restored.set(h.id, true), /not editable/);
    await restored.close(); await c.close();
  }
});

test('failed persistence is not reported off and leaves status unconfirmed', async () => {
  const h = host(), c = h.contract;
  h.events.push({ type: 'user/message' }); h.records.set(h.id, record(h.id, 'active'));
  h.controls.disable = async () => { throw new Error('synthetic private backend detail'); };
  await assert.rejects(c.set(h.id, false), { message: 'history switch status unavailable' });
  assert.equal(h.records.get(h.id).state, 'active');
  assert.throws(() => c.get(h.id), { message: 'history switch status unavailable' });
  await assert.rejects(c.waitPending(h.agent), { message: 'history switch status unavailable' });
  await assert.rejects(c.request(h.agent, {}, async () => ({}), true), { message: 'history switch status unavailable' });
  await c.closeAgent(h.agent);
  assert.equal(c.get(h.id).enabled, true);
  await c.close();
});

test('false success from storage is rejected and leaves status unconfirmed', async () => {
  const h = host(), c = h.contract;
  h.events.push({ type: 'user/message' }); h.records.set(h.id, record(h.id, 'active'));
  h.controls.disable = async id => record(id, 'disabled'); // claims success without storing it
  await assert.rejects(c.set(h.id, false), { message: 'history switch status unavailable' });
  assert.equal(h.records.get(h.id).state, 'active');
  assert.throws(() => c.get(h.id), { message: 'history switch status unavailable' });
  await c.close();
});

test('in-flight disable gates requests and the stale candidate cannot reactivate it', async () => {
  const h = host(), c = h.contract, entered = later(), release = later();
  h.events.push({ type: 'user/message' }); h.records.set(h.id, record(h.id, 'active'));
  h.controls.disable = async (id, digest) => {
    assert.equal(digest, sha); entered.resolve(); await release.promise;
    const saved = record(id, 'disabled'); h.records.set(id, saved); return saved;
  };
  try {
    const disabling = c.set(h.id, false);
    await entered.promise;
    assert.deepEqual(c.get(h.id), { editable: false, enabled: true, support: 'unknown', admission: 'active' });
    await assert.rejects(c.set(h.id, false), /not editable/);
    h.agent.status = 'running';
    let resolved = false;
    const route = { provider: 'any provider', model: 'any model', reasoningEffort: 'any effort' };
    const request = c.request(h.agent, {}, async () => { resolved = true; return route; }, true);
    await Promise.resolve();
    assert.equal(resolved, false);
    release.resolve();
    const [off, result] = await Promise.all([disabling, request]);
    assert.equal(off.enabled, false);
    assert.equal(result.route, route);
    assert.equal(result.ready, false);
    assert.equal(result.bindingVerified, false);
  } finally { release.resolve(); await c.close(); }
});

test('candidate keeps the exact selected route without provider or effort filters', async () => {
  const h = host(), c = h.contract;
  await c.set(h.id, true);
  h.agent.status = 'running';
  for (const route of [{ provider: 'custom', model: 'x', maxTokens: 7 }, { provider: 'different', model: 'y', reasoningEffort: 'off' }]) {
    const result = await c.request(h.agent, {}, async () => route, true);
    assert.equal(result.route, route);
    assert.equal(result.ready, true);
    assert.equal(result.bindingVerified, true);
    assert.equal(result.support, 'unknown');
  }
  const ordinary = await c.request(h.agent, {}, async () => ({ provider: 'any' }), false);
  assert.equal(ordinary.ready, false); assert.equal(ordinary.bindingVerified, false);
  await c.close();
});

test('a request waiting on a failed disable is rejected before resolving its route', async () => {
  const h = host(), c = h.contract, entered = later(), release = later();
  h.events.push({ type: 'user/message' }); h.records.set(h.id, record(h.id, 'active'));
  h.controls.disable = async () => { entered.resolve(); await release.promise; throw new Error('synthetic failure'); };
  try {
    const disabling = c.set(h.id, false);
    await entered.promise;
    h.agent.status = 'running'; let resolved = false;
    const request = c.request(h.agent, {}, async () => { resolved = true; return {}; }, true);
    const results = Promise.allSettled([disabling, request]);
    release.resolve();
    assert.deepEqual((await results).map(item => item.status), ['rejected', 'rejected']);
    assert.equal(resolved, false);
    assert.throws(() => c.get(h.id), /status unavailable/);
  } finally { release.resolve(); await c.close(); }
});

test('an unowned agent cannot claim the state of a live session', async () => {
  const h = host(), c = h.contract;
  const impostor = { ...h.agent };
  await assert.rejects(c.waitPending(impostor), /status unavailable/);
  assert.equal((await c.set(h.id, true)).enabled, true);
  await c.close();
});

test('a started session with a missing admission does not claim the switch is off', async () => {
  const h = host(), c = h.contract;
  await c.set(h.id, true);
  h.events.push({ type: 'turn/start' }, { type: 'step/start' });
  assert.equal(c.get(h.id).enabled, true); // pre-step has not created the admission yet
  h.events.push({ type: 'user/message' });
  assert.throws(() => c.get(h.id), /status unavailable/);
  await assert.rejects(c.set(h.id, false), /status unavailable/);
  await c.close();
});

test('switch waits for ownership checks after persistence', async () => {
  const h = host(), c = h.contract, entered = later(), release = later();
  h.events.push({ type: 'user/message' }); h.records.set(h.id, record(h.id, 'active'));
  h.controls.disable = async id => {
    entered.resolve(); await release.promise;
    const saved = record(id, 'disabled'); h.records.set(id, saved); return saved;
  };
  try {
    const disabling = c.set(h.id, false);
    await entered.promise;
    h.agentMap.set(h.id, { ...h.agent });
    release.resolve();
    await assert.rejects(disabling, { message: 'history switch status unavailable' });
    assert.equal(h.records.get(h.id).state, 'disabled');
  } finally { release.resolve(); await c.close(); }
});

test('abort and close fail requests closed while draining a resolver that ignores abort', async () => {
  const h = host(), c = h.contract, entered = later(), release = later(), abort = new AbortController();
  await c.set(h.id, true);
  const request = c.request(h.agent, { signal: abort.signal }, async () => {
    entered.resolve(); await release.promise; return { provider: 'synthetic' };
  }, true);
  try {
    await entered.promise;
    assert.equal(c.get(h.id).editable, false);
    abort.abort();
    await assert.rejects(request, /canceled/);
    assert.equal(c.get(h.id).editable, false);
    let drained = false;
    const closing = c.closeAgent(h.agent).then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve(); await closing;
    assert.equal(drained, true);
  } finally { release.resolve(); await c.close(); }
});

test('saved-only status validates owner and never exposes storage errors', async () => {
  const h = host(), c = h.contract;
  h.agentMap.delete(h.id);
  h.records.set(h.id, record('wrong-owner', 'active'));
  assert.throws(() => c.get(h.id), { message: 'history switch status unavailable' });
  h.records.delete(h.id);
  h.controls.getError = new Error('synthetic private backend detail');
  assert.throws(() => c.get(h.id), { message: 'history switch status unavailable' });
  await c.close();
});
