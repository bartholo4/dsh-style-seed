import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
test('cold status is saved-only, validates ownership, and never relaxes set',
  { skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to DSH 0.2.2-alpha.2 node_modules' }, async () => {
    const require = createRequire(join(runtime, '__candidate_host_state_test.cjs'));
    const protocol = pathToFileURL(require.resolve('@deepseek-ai/dsh-typert-protocol')).href;
    const hook = registerHooks({ resolve(name, context, next) {
      return next(name === '@deepseek-ai/dsh-typert-protocol' ? protocol : name, context);
    } });
    try {
      const { default: Host } = await import('../src/host.mjs');
      const id = 'synthetic-restored';
      let agent, attached, record = { owner: id, state: 'active', sha256: 'a'.repeat(64) };
      let managed = false, setCalls = 0;
      let view = { editable: false, enabled: false, support: 'unknown' };
      const host = Object.create(Host.prototype);
      host.ctx = { agents: { get: () => agent }, sessions: { get: () => attached } };
      host.contract = { get: () => ({ ...view }), set: () => { setCalls++; return { ...view }; } };
      host.admissionStore = { get: () => record };
      host.isManaged = () => managed;

      let result = host.get(id);
      assert.equal(result.savedOnly, true); assert.equal(result.admission, 'active');
      assert.equal(result.editable, false);
      await assert.rejects(host.set(id, true), /open a new session/);
      await assert.rejects(host.set(id, false), /open a new session/);
      assert.equal(setCalls, 0);
      record = { ...record, owner: 'synthetic-other' };
      assert.throws(() => host.get(id), /status unavailable/);
      record = { ...record, owner: id };
      for (const marker of [{ isSeeded: true }, { parentSession: 'synthetic-parent' }, { delegationDepth: 1 }, { origin: 'subagent' }]) {
        attached = { header: { id, ...marker } };
        assert.equal(host.get(id).admission, null);
        assert.equal(host.get(id).savedOnly, undefined);
      }
      attached = { header: { id } };
      assert.equal(host.get(id).savedOnly, true);
      for (const state of ['pending', 'skipped']) {
        record = { ...record, state };
        result = host.get(id); assert.equal(result.savedOnly, true); assert.equal(result.admission, state);
      }
      record = undefined;
      assert.equal(host.get(id).admission, null); assert.equal(host.get(id).savedOnly, undefined);

      record = { owner: id, state: 'active', sha256: 'a'.repeat(64) };
      agent = { session: attached }; managed = true;
      view = { editable: false, enabled: false, support: 'supported' };
      result = host.get(id);
      assert.equal(result.savedOnly, undefined); assert.equal(result.admission, 'active');
      assert.equal(result.enabled, true); assert.equal(result.support, 'supported');
      managed = false;
      await assert.rejects(host.set(id, true), /open a new session/);
      assert.equal(setCalls, 0);
      // Ordinary live editable state continues to delegate to the existing contract.
      record = undefined; managed = true; view = { ...view, editable: true };
      await host.set(id, true); assert.equal(setCalls, 1);
    } finally { hook.deregister(); }
  });
