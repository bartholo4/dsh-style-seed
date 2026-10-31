import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
const LEGACY = 'style_seed_admission', NEXT = 'style_seed_admission_v2';

// A synthetic medium keeps its records across unit reopen without touching
// a user's storage. DomainFacility and its schema/queue are the real host code.
function syntheticMedium(initial = {}, initialNext = {}) {
  const datasets = new Map([[LEGACY, structuredClone(initial)], [NEXT, structuredClone(initialNext)]]);
  const opened = new Set(), closeCalls = [], openFaults = new Map(), closeFaults = new Map();
  let pause, fault, writes = 0;
  const backend = {
    kv: { async open(descriptor) {
      assert.ok(datasets.has(descriptor.name));
      assert.equal(descriptor.version, 1);
      if (openFaults.has(descriptor.name)) throw openFaults.get(descriptor.name);
      assert.equal(opened.has(descriptor.name), false);
      opened.add(descriptor.name);
      const records = datasets.get(descriptor.name);
      return {
        async loadAll() { return { tables: { sessions: structuredClone(records) }, global: null }; },
        async putRecord(table, key, value) {
          assert.equal(table, 'sessions');
          writes++;
          if (pause?.state === value.state) {
            const held = pause; pause = undefined;
            held.entered.resolve(); await held.release.promise;
          }
          if (fault) {
            const held = fault; fault = undefined;
            if (held.commit) records[key] = structuredClone(value);
            throw held.error;
          }
          records[key] = structuredClone(value);
        },
        async deleteRecord(table, key) { assert.equal(table, 'sessions'); delete records[key]; },
        async deleteRecords(table, keys) { assert.equal(table, 'sessions'); for (const key of keys) delete records[key]; },
        async close() {
          closeCalls.push(descriptor.name); opened.delete(descriptor.name);
          if (closeFaults.has(descriptor.name)) throw closeFaults.get(descriptor.name);
        },
      };
    } },
    async close() {},
  };
  return {
    backend,
    get writes() { return writes; },
    get openUnits() { return [...opened]; },
    get closeCalls() { return [...closeCalls]; },
    snapshot(name) { return structuredClone(datasets.get(name)); },
    failOpen(name, error) { openFaults.set(name, error); },
    failClose(name, error) { closeFaults.set(name, error); },
    pauseNext(state) {
      pause = { state, entered: Promise.withResolvers(), release: Promise.withResolvers() };
      return pause;
    },
    failNext(error, commit = false) { fault = { error, commit }; },
  };
}

test('official storage-domain handles disabled admissions, races and failed writes',
  { skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to the host runtime node_modules' }, async t => {
    const require = createRequire(join(runtime, '__admission_disable_test.cjs'));
    const names = ['@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage', 'zod'];
    const paths = new Map(names.map(name => [name, pathToFileURL(require.resolve(name)).href]));
    const hook = registerHooks({ resolve(name, context, next) { return next(paths.get(name) ?? name, context); } });
    try {
      const [{ DomainFacility, defineDomain, domainTable }, { StorageError }, { openAdmissionStore }, { z }] = await Promise.all([
        import('@deepseek-ai/dsh-storage-domain'), import('@deepseek-ai/dsh-storage'), import('../src/admission-store.mjs'), import('zod'),
      ]);
      const sha = 'a'.repeat(64), other = 'b'.repeat(64);
      const record = (owner, state) => ({ owner, sha256: sha, state });
      // Independent copy of the experimental.12 schema, used as an old reader.
      const oldSpec = defineDomain({ name: LEGACY, version: 1, tables: { sessions: domainTable(z.object({
        owner: z.string().min(1).max(256), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        state: z.enum(['pending', 'active', 'skipped']),
      }).strict()) } });
      function setup(initial = {}, initialNext = {}) {
        const medium = syntheticMedium(initial, initialNext);
        const ctx = { storage: { backend: { get: () => medium.backend } }, emit() {}, logger: { warn() {} } };
        const facility = new DomainFacility(ctx, { backend: 'synthetic' });
        return { medium, facility };
      }
      async function open(initial = {}, initialNext = {}) {
        const env = setup(initial, initialNext);
        return { ...env, store: await openAdmissionStore(env.facility) };
      }

      await t.test('existing admission operations keep their prior behavior', async () => {
        const env = await open();
        let store = env.store;
        try {
          assert.equal(store.get('a'), undefined);
          const [one, two] = await Promise.all([store.arm('a', sha), store.arm('a', sha)]);
          assert.deepEqual(one, record('a', 'pending'));
          assert.deepEqual(two, record('a', 'pending'));
          await assert.rejects(store.arm('a', other), /identity changed/);
          assert.deepEqual(await store.activate('a', sha), record('a', 'active'));
          await assert.rejects(store.abandonPending('a', sha), /cannot be abandoned/);
          await store.arm('b', sha);
          assert.equal(await store.abandonPending('b', sha), true);
          await store.skip('c', sha);
          await store.close(); store = await openAdmissionStore(env.facility);
          assert.deepEqual(store.get('a'), record('a', 'active'));
          assert.equal(store.get('b'), undefined);
          assert.deepEqual(store.get('c'), record('c', 'skipped'));
          assert.equal(await store.abandonPending('c', sha), true);
        } finally { await store.close(); }
      });

      await t.test('sidecar-only admissions preserve their mode through disable and reopen', async () => {
        const env = await open({ legacy: record('legacy', 'pending') });
        let store = env.store;
        const withMode = (id, state) => ({ ...record(id, state), mode: 'sidecar-only' });
        try {
          assert.deepEqual(await store.arm('legacy', sha), record('legacy', 'pending'));
          assert.equal(Object.hasOwn(store.get('legacy'), 'mode'), false);
          await assert.rejects(store.arm('legacy', sha, 'sidecar-only'), /mode changed/);
          assert.deepEqual(await store.arm('new', sha, 'sidecar-only'), withMode('new', 'pending'));
          assert.deepEqual(await store.arm('new', sha, 'sidecar-only'), withMode('new', 'pending'));
          await assert.rejects(store.arm('new', sha), /mode changed/);
          assert.deepEqual(await store.activate('new', sha), withMode('new', 'active'));
          assert.deepEqual(await store.disable('new', sha), withMode('new', 'disabled'));
          assert.deepEqual(await store.arm('pending', sha, 'sidecar-only'), withMode('pending', 'pending'));
          assert.deepEqual(await store.disable('pending', sha), withMode('pending', 'disabled'));
          await store.close(); store = await openAdmissionStore(env.facility);
          assert.deepEqual(store.get('legacy'), record('legacy', 'pending'));
          assert.deepEqual(store.get('new'), withMode('new', 'disabled'));
          assert.deepEqual(store.get('pending'), withMode('pending', 'disabled'));
          await assert.rejects(store.arm('new', sha, 'sidecar-only'), /disabled/);
          await assert.rejects(store.arm('new', sha), /disabled/);
          await assert.rejects(store.activate('new', sha), /disabled/);
          await assert.rejects(store.abandonPending('new', sha), /cannot be abandoned/);
        } finally { await store.close(); }
      });

      await t.test('competing and invalid admission modes fail without changing identity', async () => {
        const env = await open(), { store } = env;
        try {
          for (const invalid of ['', 'legacy', null, 1]) {
            assert.throws(() => store.arm('invalid', sha, invalid), /invalid admission mode/);
          }
          assert.equal(store.get('invalid'), undefined);
          const firstNew = await Promise.allSettled([
            store.arm('race-new', sha, 'sidecar-only'), store.arm('race-new', sha),
          ]);
          assert.deepEqual(firstNew.map(item => item.status), ['fulfilled', 'rejected']);
          assert.match(firstNew[1].reason.message, /mode changed/);
          assert.deepEqual(store.get('race-new'), { ...record('race-new', 'pending'), mode: 'sidecar-only' });
          const firstLegacy = await Promise.allSettled([
            store.arm('race-legacy', sha), store.arm('race-legacy', sha, 'sidecar-only'),
          ]);
          assert.deepEqual(firstLegacy.map(item => item.status), ['fulfilled', 'rejected']);
          assert.match(firstLegacy[1].reason.message, /mode changed/);
          assert.deepEqual(store.get('race-legacy'), record('race-legacy', 'pending'));
        } finally { await store.close(); }
        await assert.rejects(open({ invalid: { ...record('invalid', 'pending'), mode: 'unexpected' } }), { code: 'invalid-record' });
      });

      await t.test('new writes and legacy disable leave the .12 domain readable and unchanged', async () => {
        const env = await open({ old: record('old', 'active'), pending: record('pending', 'pending') });
        let store = env.store, oldDomain;
        try {
          await store.arm('fresh', sha, 'sidecar-only');
          await store.activate('fresh', sha);
          await store.arm('fresh-off', sha, 'sidecar-only');
          await store.disable('fresh-off', sha);
          await store.arm('new-legacy', sha);
          await store.activate('new-legacy', sha);
          await store.disable('old', sha);
          assert.deepEqual(env.medium.snapshot(LEGACY), {
            old: record('old', 'active'), pending: record('pending', 'pending'), 'new-legacy': record('new-legacy', 'active'),
          });
          assert.deepEqual(env.medium.snapshot(NEXT), {
            old: record('old', 'disabled'),
            fresh: { ...record('fresh', 'active'), mode: 'sidecar-only' },
            'fresh-off': { ...record('fresh-off', 'disabled'), mode: 'sidecar-only' },
          });
          await store.close();
          oldDomain = await env.facility.open(oldSpec);
          assert.deepEqual(oldDomain.table('sessions').get('old'), record('old', 'active'));
          assert.deepEqual(oldDomain.table('sessions').get('new-legacy'), record('new-legacy', 'active'));
          assert.equal(oldDomain.table('sessions').get('fresh'), undefined);
          await oldDomain.close(); oldDomain = undefined;
          store = await openAdmissionStore(env.facility);
          assert.deepEqual(store.get('old'), record('old', 'disabled'));
          assert.deepEqual(store.get('fresh'), { ...record('fresh', 'active'), mode: 'sidecar-only' });
        } finally { await oldDomain?.close(); await store.close(); }
      });

      await t.test('dual rows require a matching legacy disabled overlay before any operation', async () => {
        const same = await open({ item: record('item', 'active') }, {
          item: record('item', 'disabled'),
        });
        try {
          assert.deepEqual(same.store.get('item'), record('item', 'disabled'));
          await assert.rejects(same.store.arm('item', sha), /disabled/);
          await assert.rejects(same.store.abandonPending('item', sha), /cannot be abandoned/);
        } finally { await same.store.close(); }
        for (const conflict of [
          { ...record('item', 'disabled'), sha256: other }, record('another-owner', 'disabled'),
          { ...record('item', 'pending'), mode: 'sidecar-only' },
          { ...record('item', 'disabled'), mode: 'sidecar-only' },
        ]) {
          const env = await open({ item: record('item', 'active') }, { item: conflict });
          try {
            assert.throws(() => env.store.get('item'), /identity changed/);
            await assert.rejects(env.store.arm('item', sha), /identity changed/);
            await assert.rejects(env.store.activate('item', sha), /missing or changed/);
            await assert.rejects(env.store.disable('item', sha), /missing or changed/);
            await assert.rejects(env.store.abandonPending('item', sha), /cannot be abandoned/);
            assert.deepEqual(env.medium.snapshot(LEGACY).item, record('item', 'active'));
            assert.deepEqual(env.medium.snapshot(NEXT).item, conflict);
          } finally { await env.store.close(); }
        }
      });

      await t.test('a broken new domain does not stop an old reader opening the legacy domain', async () => {
        const env = setup({ old: record('old', 'active') }, {
          bad: { ...record('bad', 'pending'), mode: 'unexpected' },
        });
        await assert.rejects(openAdmissionStore(env.facility), { code: 'invalid-record' });
        assert.deepEqual(env.medium.openUnits, []);
        const oldDomain = await env.facility.open(oldSpec);
        try { assert.deepEqual(oldDomain.table('sessions').get('old'), record('old', 'active')); }
        finally { await oldDomain.close(); }
      });

      await t.test('opening and closing failures release both domains where possible', async () => {
        const brokenOpen = setup();
        brokenOpen.medium.failOpen(NEXT, new Error('synthetic open failure'));
        await assert.rejects(openAdmissionStore(brokenOpen.facility), /synthetic open failure/);
        assert.deepEqual(brokenOpen.medium.openUnits, []);
        assert.ok(brokenOpen.medium.closeCalls.includes(LEGACY));
        const oldDomain = await brokenOpen.facility.open(oldSpec);
        await oldDomain.close();

        const brokenCleanup = setup();
        brokenCleanup.medium.failOpen(NEXT, new Error('synthetic open failure'));
        brokenCleanup.medium.failClose(LEGACY, new Error('synthetic cleanup failure'));
        await assert.rejects(openAdmissionStore(brokenCleanup.facility), /open and cleanup failed/);
        assert.ok(brokenCleanup.medium.closeCalls.includes(LEGACY));

        const env = await open();
        env.medium.failClose(LEGACY, new Error('synthetic close failure'));
        await assert.rejects(env.store.close(), /admission store close failed/);
        assert.deepEqual(new Set(env.medium.closeCalls), new Set([LEGACY, NEXT]));
        assert.throws(() => env.store.get('anything'), /closed/);
        await assert.rejects(env.store.close(), /admission store close failed/);
      });

      await t.test('legacy rows disable idempotently and survive close/reopen', async () => {
        const env = await open({ p: record('p', 'pending'), a: record('a', 'active'), s: record('s', 'skipped') });
        let store = env.store;
        try {
          for (const id of ['p', 'a', 's']) {
            assert.equal(store.get(id).state, { p: 'pending', a: 'active', s: 'skipped' }[id]);
            assert.deepEqual(await store.disable(id, sha), record(id, 'disabled'));
            const count = env.medium.writes;
            assert.deepEqual(await store.disable(id, sha), record(id, 'disabled'));
            assert.equal(env.medium.writes, count);
          }
          await store.close(); store = await openAdmissionStore(env.facility);
          for (const id of ['p', 'a', 's']) {
            assert.deepEqual(store.get(id), record(id, 'disabled'));
            await assert.rejects(store.arm(id, sha), /disabled/);
            await assert.rejects(store.activate(id, sha), /disabled/);
            await assert.rejects(store.skip(id, sha), /disabled/);
            await assert.rejects(store.abandonPending(id, sha), /cannot be abandoned/);
            assert.deepEqual(store.get(id), record(id, 'disabled'));
          }
        } finally { await store.close(); }
      });

      await t.test('identity checks and failed writes never report success', async () => {
        const env = await open({ active: record('active', 'active'), wrongOwner: record('other-owner', 'active') });
        const { store, medium } = env;
        try {
          assert.throws(() => store.disable('', sha), /invalid admission identity/);
          assert.throws(() => store.disable('active', 'bad'), /invalid admission identity/);
          await assert.rejects(store.disable('missing', sha), /missing or changed/);
          await assert.rejects(store.disable('active', other), /missing or changed/);
          await assert.rejects(store.disable('wrongOwner', sha), /missing or changed/);
          medium.failNext(new Error('synthetic write failure'));
          await assert.rejects(store.disable('active', sha), /synthetic write failure/);
          assert.deepEqual(store.get('active'), record('active', 'active'));
          assert.deepEqual(await store.disable('active', sha), record('active', 'disabled'));
        } finally { await store.close(); }
      });

      await t.test('unknown backend outcome requires reopen to inspect durable state', async () => {
        const env = await open({ active: record('active', 'active') });
        let store = env.store;
        try {
          env.medium.failNext(new StorageError('unknown-state', 'synthetic unknown outcome'), true);
          await assert.rejects(store.disable('active', sha), { code: 'unknown-state' });
          assert.throws(() => store.get('active'), { code: 'unknown-state' });
          await assert.rejects(store.activate('active', sha), { code: 'unknown-state' });
          await store.close(); store = await openAdmissionStore(env.facility);
          assert.deepEqual(store.get('active'), record('active', 'disabled'));
          await assert.rejects(store.arm('active', sha), /disabled/);
        } finally { await store.close(); }
      });

      await t.test('queued stale operations cannot undo an in-flight disable', async () => {
        const env = await open({ session: record('session', 'pending') });
        const { store, medium } = env;
        const gate = medium.pauseNext('disabled');
        try {
          const disabling = store.disable('session', sha);
          await gate.entered.promise;
          assert.equal(store.get('session').state, 'pending');
          const results = Promise.allSettled([
            disabling, store.arm('session', sha), store.activate('session', sha),
            store.skip('session', sha), store.abandonPending('session', sha),
          ]);
          gate.release.resolve();
          const settled = await results;
          assert.deepEqual(settled.map(item => item.status), ['fulfilled', 'rejected', 'rejected', 'rejected', 'rejected']);
          assert.deepEqual(settled[0].value, record('session', 'disabled'));
          assert.deepEqual(store.get('session'), record('session', 'disabled'));
          await store.close();
          const reopened = await openAdmissionStore(env.facility);
          try { assert.deepEqual(reopened.get('session'), record('session', 'disabled')); }
          finally { await reopened.close(); }
        } finally { gate.release.resolve(); await store.close(); }
      });

      await t.test('older activation finishes before disable; deletion winning first rejects disable', async () => {
        const env = await open({ session: record('session', 'pending'), abandoned: record('abandoned', 'pending') });
        const { store, medium } = env;
        const gate = medium.pauseNext('active');
        try {
          const activating = store.activate('session', sha);
          await gate.entered.promise;
          const results = Promise.allSettled([
            activating, store.disable('session', sha), store.activate('session', sha),
            store.abandonPending('abandoned', sha), store.disable('abandoned', sha),
          ]);
          gate.release.resolve();
          const settled = await results;
          assert.deepEqual(settled.map(item => item.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'rejected']);
          assert.equal(settled[0].value.state, 'active');
          assert.equal(settled[1].value.state, 'disabled');
          assert.equal(settled[3].value, true);
          assert.match(settled[4].reason.message, /missing or changed/);
          assert.deepEqual(store.get('session'), record('session', 'disabled'));
          assert.equal(store.get('abandoned'), undefined);
        } finally { gate.release.resolve(); await store.close(); }
      });
    } finally { hook.deregister(); }
  });
