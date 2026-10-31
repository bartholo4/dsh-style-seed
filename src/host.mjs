import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createSwitchContract } from './contract.mjs';
import { isEligibleTopLevel } from './eligibility.mjs';
import { createGenericSwitchContract } from './generic-contract.mjs';

const initializers = [];
// This service exposes the experimental switch to authorized session peers.
export default class SwitchContractService extends TypertRemoteService {
  static inject = ['typert', 'remoteAccess', 'sessions', 'agents'];
  constructor(ctx, config = {}) {
    super(ctx, 'switchContract', { namespace: 'dsh-style-seed-switch' });
    this.isManaged = config.isManaged ?? (() => false);
    this.admissionStore = config.admissionStore;
    this.followSelected = config.followSelected === true;
    this.contract = this.followSelected
      ? createGenericSwitchContract({sessions:ctx.sessions,agents:ctx.agents,store:this.admissionStore,
          defaultSelection:config.defaultSelection, isManaged:this.isManaged})
      : createSwitchContract({ sessions: ctx.sessions, agents: ctx.agents,
          expected: config.expected ?? {}, authority: config.authority,
          defaultSelection: config.defaultSelection ?? (() => undefined), currentRoute: config.currentRoute });
    for (const init of initializers) init.call(this);
    ctx.on('agent/disposed', ({ agent }) => this.contract.closeAgent(agent));
    ctx.effect(() => () => this.contract.close(), 'history switch contract cleanup');
  }
  get(sessionId) {
    if (this.followSelected) return this.contract.get(sessionId);
    const agent = this.ctx.agents.get(sessionId), view = this.contract.get(sessionId);
    if (!agent) {
      const record = this.admissionStore?.get(sessionId);
      if (record && record.owner !== sessionId) throw new Error('history switch status unavailable');
      const attached = this.ctx.sessions.get(sessionId);
      if (!record || (attached && !isEligibleTopLevel({ session: attached })))
        return { ...view, editable: false, enabled: false, admission: null };
      // A saved record is not proof that the restored request has been verified.
      // Read the already-open store only; status must not activate an Agent.
      return { ...view, editable: false, enabled: true, admission: record.state, savedOnly: true };
    }
    if (!isEligibleTopLevel(agent)) return { ...view, editable: false, enabled: false, admission: null };
    const record = this.admissionStore?.get(sessionId);
    if (record && record.owner !== sessionId) throw new Error('history switch status unavailable');
    const managed = this.isManaged(agent);
    // A canceled first attempt can leave pending/skipped metadata even though
    // the blank switch was subsequently turned off or the process restarted.
    const visibleRecord = view.editable && !view.enabled && record?.state !== 'active' ? undefined : record;
    return { ...view, editable: view.editable && managed, enabled: view.enabled || Boolean(visibleRecord),
      admission: visibleRecord?.state ?? null,
      ...(view.editable && !managed ? { reason: 'new-session-required' } : {}) };
  }
  async set(sessionId, enabled) {
    if (this.followSelected) return this.contract.set(sessionId, enabled);
    const agent = this.ctx.agents.get(sessionId);
    if (!isEligibleTopLevel(agent) || !this.isManaged(agent)) throw new Error('open a new session to use history switch');
    return this.contract.set(sessionId, enabled);
  }
}
for (const method of ['get', 'set']) {
  Remote({ resources: { session: sessionId => sessionId } })(SwitchContractService.prototype[method], {
    name: method, private: false, static: false, addInitializer: fn => initializers.push(fn),
  });
}
