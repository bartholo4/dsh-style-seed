import { isDeepStrictEqual } from 'node:util';
import { createSessionSwitch } from './session-switch.mjs';
const abortIfNeeded = signal => { if (signal?.aborted) throw new Error('history switch operation canceled'); };

// Route verification is supplied by the host; admission is committed by the
// AgentLoop after this preflight completes.
export function createSwitchContract({ sessions, agents, expected, authority, defaultSelection, currentRoute }) {
  const sw = createSessionSwitch({ sessions, agents, defaultSelection, supportedRoute: expected, currentRoute });
  let pins = new WeakMap(), revisions = new WeakMap(), failures = new WeakSet(), pending = new WeakMap();
  let closed = false;
  const nextRevision = session => { const n = (revisions.get(session) ?? 0) + 1; revisions.set(session, n); return n; };
  const view = id => sw.get(id);
  function validate(snapshot) {
    if (!snapshot || snapshot.verified !== true || typeof snapshot.revision !== 'string' || !snapshot.revision ||
      snapshot.provider !== expected.provider || snapshot.model !== expected.model ||
      snapshot.baseURL !== expected.baseURL || snapshot.credentialRef !== expected.credentialRef) {
      throw new Error('target binding has not been verified');
    }
    return structuredClone(snapshot);
  }
  async function set(id, enabled) {
    if (closed) throw new Error('switch service is closed');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const session = sessions.get(id), agent = agents.get(id);
    if (!session || !agent || agent.session !== session || !sw.get(id).editable) throw new Error('session is not editable');
    const revision = nextRevision(session);
    if (!enabled) { pins.delete(session); authority?.clear?.(session); sw.set(id, false); return view(id); }
    if (!authority || typeof authority.capture !== 'function') throw new Error('target binding verification is unavailable');
    const done = Promise.withResolvers(), entry = { done, error: false }; pending.set(session, entry);
    try {
      const pin = validate(await authority.capture({ session, agent }));
      if (closed || revisions.get(session) !== revision || sessions.get(id) !== session || agents.get(id) !== agent || agent.session !== session)
        throw new Error('session or switch changed during verification');
      if (sw.get(id).editable) sw.set(id, true);
      else sw.setPendingBeforeStep(id, true);
      pins.set(session, { session, agent, pin });
      return view(id);
    } catch (error) { entry.error = true; throw error; }
    finally { if (pending.get(session) === entry) pending.delete(session); done.resolve(); }
  }
  async function waitPending(agent, signal) {
    const session = agent?.session, entry = session && pending.get(session);
    if (!entry) return;
    abortIfNeeded(signal);
    if (!signal) await entry.done.promise;
    else await new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('history switch operation canceled')); };
      signal.addEventListener('abort', abort, { once: true });
      entry.done.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); }, reject);
    });
    abortIfNeeded(signal);
    if (entry.error || closed || sessions.get(agent.id) !== session || agents.get(agent.id) !== agent || agent.session !== session) {
      throw new Error('history switch pending switch failed');
    }
  }
  async function request(agent, payload, resolveRoute, admitCandidate = false) {
    const session = agent.session;
    if (failures.has(session)) throw new Error('prior binding verification failed');
    let routeResolved = false;
    try {
      const result = await sw.request(agent, payload, resolveRoute);
      routeResolved = true;
      // Allow a deliberate re-admission after a failed
      // attempt only if the session still has no committed conversation.
      const noInput = !session.snapshotEvents().some(event => ['user/message', 'assistant/message', 'request/header'].includes(event.type));
      const candidate = admitCandidate && noInput && sw.get(agent.id).enabled &&
        result.route?.provider === expected.provider && result.route?.model === expected.model;
      if (!result.ready && !candidate) return result;
      const record = pins.get(session);
      if (!record || record.agent !== agent || record.session !== session || !authority) throw new Error('verified binding is unavailable');
      abortIfNeeded(payload.signal);
      const current = validate(await authority.capture({ session, agent, route: result.route, signal: payload.signal }));
      abortIfNeeded(payload.signal);
      if (closed || sessions.get(agent.id) !== record.session || agents.get(agent.id) !== agent || agent.session !== session ||
        pins.get(session) !== record || !isDeepStrictEqual(record.pin, current)) throw new Error('binding or session changed');
      // The caller supplies the admission message to the normal AgentLoop.
      // The normal AgentLoop commits the reference after this check.
      return { ...result, ready: candidate, imported: false, bindingVerified: true };
    } catch (error) {
      // A pre-commit failure must not permanently strand an otherwise empty
      // conversation. A retry still revalidates the pinned binding and fails
      // if configuration has changed. Once any conversation was committed,
      // keep the fail-closed lock until the agent is disposed.
      const committed = session.snapshotEvents().some(event =>
        ['user/message', 'assistant/message', 'request/header'].includes(event.type));
      if (routeResolved && pins.has(session) && committed && !payload.signal?.aborted && !closed) failures.add(session);
      throw error;
    }
  }
  async function verifyStream(agent, route, signal, allowRestored = false) {
    const session = agent?.session;
    let record = session && pins.get(session);
    if (!record && allowRestored && !closed && session && sessions.get(agent.id) === session && agents.get(agent.id) === agent &&
        route?.provider === expected.provider && route?.model === expected.model && authority) {
      const pin = validate(await authority.capture({ session, agent, route, signal }));
      abortIfNeeded(signal);
      if (closed || sessions.get(agent.id) !== session || agents.get(agent.id) !== agent || agent.session !== session) throw new Error('restored session changed');
      record = { session, agent, pin }; pins.set(session, record);
    }
    if (closed || !record || record.agent !== agent || record.session !== session ||
        sessions.get(agent.id) !== session || agents.get(agent.id) !== agent ||
        route?.provider !== expected.provider || route?.model !== expected.model) throw new Error('stream binding unavailable');
    abortIfNeeded(signal);
    const current = validate(await authority.capture({ session, agent, route, signal }));
    abortIfNeeded(signal);
    if (closed || pins.get(session) !== record || sessions.get(agent.id) !== session || agents.get(agent.id) !== agent ||
        !isDeepStrictEqual(record.pin, current)) throw new Error('stream binding changed');
    if (typeof authority.verifyRequest !== 'function') throw new Error('stream verifier unavailable');
    await authority.verifyRequest({ session, agent, request: route }, signal);
    abortIfNeeded(signal);
    const final = validate(await authority.capture({ session, agent, route, signal }));
    abortIfNeeded(signal);
    if (closed || pins.get(session) !== record || sessions.get(agent.id) !== session || agents.get(agent.id) !== agent ||
        !isDeepStrictEqual(record.pin, final)) throw new Error('stream binding changed');
    return true;
  }
  async function closeAgent(agent) { nextRevision(agent.session); pins.delete(agent.session); failures.delete(agent.session); authority?.clear?.(agent.session); await sw.closeAgent(agent); }
  async function close() { closed = true; pins = new WeakMap(); revisions = new WeakMap(); failures = new WeakSet(); authority?.close?.(); await sw.close(); }
  return { get: view, set, waitPending, request, verifyStream, closeAgent, close };
}
