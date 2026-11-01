import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { registerSessionSlot } from '../src/client.mjs';

const source = readFileSync(new URL('../src/client.mjs', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../client.bundle.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function client(implementation, bridge, initial = {}) {
  const states = [], refs = [], effects = [], pending = [];
  let cursor = 0, component, mounted = true;
  let sessionId = initial.sessionId ?? 'synthetic-session';
  let snapshot = { blank: true, subagent: null, removed: false, openState: 'open', running: false, ...initial.snapshot };
  let selection = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', ...initial.selection };
  const React = {
    useState(initialValue) { const i = cursor++; if (!(i in states)) states[i] = initialValue;
      return [states[i], value => { assert.equal(mounted, true, 'no state updates after unmount'); states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initialValue) { const i = cursor++; return refs[i] ??= { current: initialValue }; },
    useEffect(fn, deps) { const i = cursor++; if (!effects[i] || deps.some((value, j) => value !== effects[i].deps[j]))
      pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
    createElement(type, props, child) { return { type, props, child }; },
  };
  const slots = { inject: (_name, register) => register(), register: (_info, value) => { component = value; } };
  if (implementation === 'source') {
    registerSessionSlot({ slots }, React, bridge);
  } else {
    let module;
    runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { module = value; } } } });
    assert.equal(module.id, 'dsh-style-seed');
    const api = module.factory(name => { assert.equal(name, 'react'); return React; });
    api.apply({ slots, connection: { rpc: { async call(path, method, { args }) {
      assert.equal(path, '/api');
      if (method === 'dsh-style-seed-switch/get') return { ok: true, value: await bridge.get(args.sessionId) };
      assert.equal(method, 'dsh-style-seed-switch/set');
      return { ok: true, value: await bridge.set(args.sessionId, args.enabled) };
    } } } });
  }
  return {
    unmount() {
      effects.forEach(effect => effect?.cleanup?.());
      mounted = false;
    },
    render(update = {}) {
      if (Object.hasOwn(update, 'sessionId')) sessionId = update.sessionId;
      snapshot = { ...snapshot, ...update.snapshot };
      selection = { ...selection, ...update.selection };
      cursor = 0;
      const element = component({ sessionId, useSession: fn => fn(snapshot), useProjection: () => ({ next: selection }) });
      pending.splice(0).forEach(fn => fn());
      return element;
    },
  };
}

test('bundle contains the exact source implementation and the existing module loader wrapper', () => {
  assert.ok(bundle.includes(source.replace('export function registerSessionSlot', 'function registerSessionSlot')));
  assert.match(bundle, /window\.__ModuleLoader__\.load/);
  assert.match(bundle, /dsh-style-seed-switch\//);
});

for (const implementation of ['source', 'bundle']) {
  test(`${implementation}: new session starts off and explicit clicks save the setting`, async () => {
    let status = { enabled: false, editable: true, admission: null }, calls = [];
    const ui = client(implementation, { get: async () => ({ ...status }), set: async (id, enabled) => {
      calls.push([id, enabled]); status = { ...status, enabled }; return { ...status };
    } });
    assert.match(ui.render().child, /检查中/); await settle();
    let control = ui.render();
    assert.equal(control.type, 'button'); assert.equal(control.props.disabled, false);
    assert.equal(control.child, 'weneed开关：关'); assert.equal(control.props['aria-checked'], false);
    assert.equal(control.props.style.maxWidth, 136);
    assert.doesNotMatch(control.props.title, /d1api|deepseek|max/i);
    await control.props.onClick(); control = ui.render();
    assert.equal(control.child, 'weneed开关：开'); assert.equal(control.props['aria-checked'], true);
    assert.deepEqual(calls, [['synthetic-session', true]]);
  });

  test(`${implementation}: an idle started session can turn off but cannot turn back on`, async () => {
    let status = { enabled: true, editable: true, admission: 'active' }, calls = [];
    const ui = client(implementation, { get: async () => ({ ...status }), set: async (id, enabled) => {
      calls.push([id, enabled]); status = { enabled, editable: true, admission: 'disabled' }; return { ...status };
    } }, { snapshot: { blank: false } });
    ui.render(); await settle(); let control = ui.render();
    assert.equal(control.child, 'weneed开关：开'); assert.equal(control.props.disabled, false);
    await control.props.onClick(); control = ui.render();
    assert.equal(control.child, 'weneed开关：关'); assert.equal(control.props.disabled, true);
    assert.match(control.props.title, /不能重新开启/);
    await control.props.onClick(); assert.deepEqual(calls, [['synthetic-session', false]]);
  });

  test(`${implementation}: model failure still permits an idle close`, async () => {
    let status = { enabled: true, editable: true, admission: 'pending', reason: 'unsupported' }, calls = [];
    const ui = client(implementation, { get: async () => ({ ...status }), set: async (_id, enabled) => {
      calls.push(enabled); status = { enabled, editable: false, admission: 'disabled' }; return { ...status };
    } }, { snapshot: { blank: false } });
    ui.render(); await settle(); const control = ui.render();
    assert.equal(control.props.disabled, false); assert.match(control.props.title, /准备尚未完成/);
    await control.props.onClick(); assert.deepEqual(calls, [false]);
    assert.equal(ui.render().child, 'weneed开关：关');
  });

  test(`${implementation}: running and unconfirmed saved states stay visible but cannot be changed`, async () => {
    let status = { enabled: true, editable: true, admission: 'active' }, calls = 0;
    const ui = client(implementation, { get: async () => ({ ...status }), set: async () => { calls++; } },
      { snapshot: { blank: false } });
    ui.render(); await settle(); assert.equal(ui.render().props.disabled, false);
    assert.match(ui.render({ snapshot: { running: true } }).child, /检查中/); await settle();
    let control = ui.render(); assert.equal(control.child, 'weneed开关：开');
    assert.equal(control.props.disabled, true); assert.match(control.props.title, /运行中/);
    await control.props.onClick(); assert.equal(calls, 0);
    status = { enabled: true, editable: true, admission: 'active', savedOnly: true };
    ui.render({ snapshot: { running: false, openState: 'loading' } }); await settle();
    control = ui.render(); assert.equal(control.type, 'span'); assert.equal(control.props.role, 'status');
    assert.match(control.child, /开（未确认）/); assert.match(control.props.title, /已保存为开；当前状态尚未确认/);
    assert.equal(control.props.onClick, undefined); assert.equal(calls, 0);
  });

  test(`${implementation}: saving is single-flight and an RPC failure leaves the state unconfirmed`, async () => {
    const request = deferred(); let writes = 0;
    const ui = client(implementation, { get: async () => ({ enabled: false, editable: true, admission: null }),
      set: () => { writes++; return request.promise; } });
    ui.render(); await settle(); const control = ui.render();
    const first = control.props.onClick(); const duplicate = control.props.onClick();
    assert.match(ui.render().child, /保存中/); assert.equal(writes, 1);
    request.reject(new Error('unknown outcome')); await Promise.all([first, duplicate]);
    // An old event handler must not resubmit even before React renders the error.
    await control.props.onClick();
    const status = ui.render(); assert.equal(status.type, 'button'); assert.match(status.props['aria-label'], /状态未确认/);
    assert.match(status.child, /重试检查/); assert.equal(writes, 1);
  });

  test(`${implementation}: a failed or malformed read never displays a confirmed off state`, async () => {
    for (const get of [async () => { throw new Error('unavailable'); }, async () => ({ editable: true })]) {
      const ui = client(implementation, { get, set: async () => assert.fail('must not save') }, { snapshot: { blank: false } });
      ui.render(); await settle(); const status = ui.render();
      assert.equal(status.type, 'button'); assert.match(status.props['aria-label'], /状态未确认/);
      assert.match(status.child, /重试检查/);
    }
  });

  test(`${implementation}: retry reconciles a committed but failed save without resending it`, async () => {
    let enabled = false, reads = 0, writes = 0;
    const ui = client(implementation, {
      get: async () => { reads++; return { enabled, editable: true }; },
      set: async (_id, next) => { writes++; enabled = next; throw new Error('reply lost after commit'); },
    });
    ui.render(); await settle(); await ui.render().props.onClick();
    const retry = ui.render();
    retry.props.onClick(); retry.props.onClick();
    assert.match(ui.render().child, /检查中/); await settle();
    assert.equal(ui.render().child, 'weneed开关：开');
    assert.equal(reads, 2); assert.equal(writes, 1);
    retry.props.onClick(); ui.render(); await settle();
    assert.equal(reads, 2); assert.equal(writes, 1);
  });

  test(`${implementation}: failed reads can be retried repeatedly without any write`, async () => {
    let reads = 0;
    const ui = client(implementation, {
      get: async () => { if (++reads < 3) throw new Error('offline'); return { enabled: false, editable: true }; },
      set: async () => assert.fail('retry must never write'),
    });
    ui.render(); await settle();
    for (let i = 0; i < 2; i++) {
      ui.render().props.onClick(); assert.match(ui.render().child, /检查中/); await settle();
    }
    assert.equal(ui.render().child, 'weneed开关：关'); assert.equal(reads, 3);
  });

  test(`${implementation}: stale retry handlers and responses cannot affect a newer session`, async () => {
    const pendingRead = deferred(); let reads = 0;
    const ui = client(implementation, {
      get: async id => {
        reads++;
        if (id === 'two') return { enabled: false, editable: true };
        if (reads === 1) throw new Error('offline');
        return pendingRead.promise;
      }, set: async () => assert.fail('retry must never write'),
    }, { sessionId: 'one' });
    ui.render(); await settle(); const retry = ui.render();
    retry.props.onClick(); ui.render();
    ui.render({ sessionId: 'two' }); await settle();
    retry.props.onClick(); ui.render();
    pendingRead.resolve({ enabled: true, editable: true }); await settle();
    assert.equal(ui.render().child, 'weneed开关：关'); assert.equal(reads, 3);
  });

  test(`${implementation}: retry completion and stale handler do nothing after unmount`, async () => {
    for (const outcome of ['resolve', 'reject']) {
      const request = deferred(); let reads = 0, writes = 0;
      const ui = client(implementation, {
        get: async () => { if (++reads === 1) throw new Error('offline'); return request.promise; },
        set: async () => { writes++; assert.fail('retry must never write'); },
      });
      ui.render(); await settle(); const retry = ui.render();
      retry.props.onClick(); ui.render();
      assert.equal(reads, 2);
      ui.unmount();
      retry.props.onClick();
      if (outcome === 'resolve') request.resolve({ enabled: true, editable: true });
      else request.reject(new Error('still offline'));
      await settle();
      assert.equal(reads, 2); assert.equal(writes, 0);
    }
  });

  test(`${implementation}: stale reads cannot overwrite a newer model or session status`, async () => {
    const requests = [];
    const ui = client(implementation, { get: () => { const request = deferred(); requests.push(request); return request.promise; } });
    ui.render(); ui.render({ selection: { model: 'model-b' } });
    requests[1].resolve({ enabled: true, editable: true, admission: null }); await settle();
    assert.equal(ui.render().child, 'weneed开关：开');
    requests[0].resolve({ enabled: false, editable: true, admission: null }); await settle();
    assert.equal(ui.render().child, 'weneed开关：开');
  });

  test(`${implementation}: returning while a save is in flight cannot show or act on a stale read`, async () => {
    const request = deferred(); let enabled = true, writes = 0;
    const ui = client(implementation, { get: async id => ({ enabled: id === 'one' ? enabled : false, editable: true, admission: null }),
      set: async (_id, next) => { writes++; await request.promise; enabled = next; return { enabled, editable: true, admission: 'disabled' }; } },
      { sessionId: 'one', snapshot: { blank: false } });
    ui.render(); await settle(); const save = ui.render().props.onClick();
    ui.render({ sessionId: 'two', snapshot: { blank: true } }); await settle();
    assert.equal(ui.render().child, 'weneed开关：关');
    ui.render({ sessionId: 'one', snapshot: { blank: false } }); await settle();
    assert.match(ui.render().child, /保存中/); assert.equal(writes, 1);
    request.resolve(); await save; ui.render(); await settle();
    const control = ui.render(); assert.equal(control.child, 'weneed开关：关'); assert.equal(control.props.disabled, true);
  });

  test(`${implementation}: a pre-save read that finishes after the save cannot restore the old setting`, async () => {
    const saveRequest = deferred(), staleRead = deferred(); let reads = 0;
    const ui = client(implementation, { get: async () => {
      reads++;
      if (reads === 2) return staleRead.promise;
      return { enabled: reads === 1, editable: true, admission: reads === 1 ? 'active' : 'disabled' };
    }, set: async () => { await saveRequest.promise; return { enabled: false, editable: true, admission: 'disabled' }; } },
    { snapshot: { blank: false } });
    ui.render(); await settle(); const save = ui.render().props.onClick();
    ui.render({ selection: { model: 'model-b' } });
    saveRequest.resolve(); await save;
    staleRead.resolve({ enabled: true, editable: true, admission: 'active' }); await settle();
    assert.match(ui.render().child, /检查中/); await settle();
    const control = ui.render(); assert.equal(control.child, 'weneed开关：关'); assert.equal(control.props.disabled, true);
    assert.equal(reads, 3);
  });
}
