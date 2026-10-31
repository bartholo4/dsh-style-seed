import { isDeepStrictEqual } from 'node:util';
// Synchronous identity/qualification checks over the official live registries.
// This is a POC seam; it does not import templates or call a model.
export function createSessionSwitch({ sessions, agents, defaultSelection, supportedRoute, currentRoute }) {
  const entries = new WeakMap();
  const active = new Set();
  let closing = false;
  function live(id) {
    if (closing || typeof id !== 'string' || !id.trim()) return;
    const session = sessions.get(id), agent = agents.get(id);
    if (!session || !agent || session.id !== id || agent.id !== id || agent.session !== session) return;
    const h = session.header;
    if (h.id !== id || h.isSeeded || h.parentSession || (h.delegationDepth ?? 0) > 0 || h.origin === 'subagent') return;
    return { session, agent };
  }
  function eventsEligible(session, atRequest = false, payload) {
    const events = session.snapshotEvents();
    if (events.some(e => ['user/message', 'assistant/message', 'request/header'].includes(e.type))) return false;
    const turns = events.filter(e => e.type === 'turn/start');
    if (!atRequest) return turns.length === 0;
    const steps = events.filter(e => e.type === 'step/start');
    return payload?.turn === 1 && payload?.step === 1 && turns.length === 1 && turns[0].data.turn === 1 &&
      steps.length === 1 && steps[0].data.turn === 1 && steps[0].data.step === 1;
  }
  function picked(session) {
    const model = session.snapshotEvents().findLast(e => e.type === 'model/selection')?.data;
    return model ?? defaultSelection();
  }
  function support(route) {
    if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') return 'unknown';
    if (route.provider !== supportedRoute.provider || route.model !== supportedRoute.model) return 'unsupported';
    if (route.reasoningEffort === undefined) return 'unknown';
    return route.reasoningEffort === supportedRoute.reasoningEffort ? 'supported' : 'unsupported';
  }
  function get(id) {
    const current = live(id);
    if (!current) return { editable: false, enabled: false, support: 'unknown' };
    const { agent, session } = current, entry = entries.get(session);
    const editable = agent.status === 'idle' && eventsEligible(session) && !entry?.locked && !entry?.closed && (!entry?.agent || entry.agent === agent);
    return { editable, enabled: entry?.enabled === true, support: support(picked(session)) };
  }
  function set(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const current = live(id);
    if (!current || !get(id).editable) throw new Error('not an eligible live blank session');
    const old = entries.get(current.session);
    entries.set(current.session, { ...old, enabled, agent: current.agent });
    return get(id);
  }
  // Only for a set initiated while idle whose async verification finished while
  // the first turn is waiting in pre-step. No step or input has been admitted.
  function setPendingBeforeStep(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const current = live(id);
    if (!current) throw new Error('not an eligible live blank session');
    const events = current.session.snapshotEvents(), old = entries.get(current.session);
    const turns = events.filter(event => event.type === 'turn/start');
    if (current.agent.status !== 'running' || old?.locked || old?.closed || (old?.agent && old.agent !== current.agent) ||
        turns.length !== 1 || turns[0].data.turn !== 1 ||
        events.some(event => ['step/start', 'user/message', 'assistant/message', 'request/header'].includes(event.type))) {
      throw new Error('not an eligible pending first step');
    }
    entries.set(current.session, { ...old, enabled, agent: current.agent });
    return get(id);
  }
  // The preparation step contains only local data cloning/comparison; no
  // externally supplied prepare or commit callback is executed.
  function waitWithSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  function watch(entry, set, promise) {
    set.add(promise); active.add(entry);
    promise.then(() => { set.delete(promise); retire(entry); }, () => { set.delete(promise); retire(entry); });
    return promise;
  }
  function retire(entry) {
    if (entry.settled && entry.routes.size === 0 && entry.calls.size === 0) active.delete(entry);
  }
  function pending(entry) {
    return [...(entry.routes ?? []), ...(entry.calls ?? []), ...(entry.promise ? [entry.promise] : [])];
  }
  function request(agent, payload, resolveRoute) {
    if (payload.signal?.aborted) return Promise.reject(payload.signal.reason);
    const session = agent.session;
    const current = live(agent.id);
    if (!current || current.agent !== agent || current.session !== session) return Promise.reject(new Error('agent is not live'));
    let entry = entries.get(session);
    if (entry?.agent && entry.agent !== agent) return Promise.reject(new Error('agent ownership changed'));
    if (entry?.closed) return Promise.reject(new Error('session is closed'));
    // A failed, uncommitted first route can be retried by a later user turn.
    // Do not reset a still-running shared decision or any committed session.
    if (entry?.failed && entry.settled && !session.snapshotEvents().some(event =>
        ['user/message', 'assistant/message', 'request/header'].includes(event.type))) {
      entry = { enabled: entry.enabled === true, agent };
      entries.set(session, entry);
    }
    const first = !entry?.locked;
    if (first) {
      const selected = entry?.enabled === true && eventsEligible(session, true, payload);
      entry = { ...entry, agent, selected, locked: true, abort: new AbortController(), routes: new Set(), calls: new Set(), settled: false };
      entries.set(session, entry);
    }
    const chosenEntry = entry;
    // First resolution belongs to the shared decision: cancellation of its
    // individual caller does not cancel work needed by another caller.
    const routeSignal = first || !payload.signal ? entry.abort.signal : AbortSignal.any([entry.abort.signal, payload.signal]);
    const routePromise = watch(entry, entry.routes, Promise.resolve().then(() => {
      routeSignal.throwIfAborted();
      return resolveRoute(routeSignal);
    }));
    if (first) {
      const decision = routePromise.then(async route => {
        const signal = chosenEntry.abort.signal;
        signal.throwIfAborted();
        if (closing || chosenEntry.closed) throw new Error('session is closed');
        if (!chosenEntry.selected || support(route) !== 'supported') return { ready: false };
        if (typeof currentRoute !== 'function') throw new Error('authoritative route revalidation unavailable');
        const original = structuredClone(route);
        // Local-only asynchronous boundary. No callback, I/O, write, or carrier.
        await Promise.resolve();
        signal.throwIfAborted();
        const now = live(agent.id);
        if (!now || now.agent !== agent || now.session !== session || chosenEntry.closed || !eventsEligible(session, true, payload)) throw new Error('session changed during preparation');
        if (!isDeepStrictEqual(original, currentRoute(agent))) throw new Error('route or configuration changed during preparation');
        return { ready: true };
      });
      entry.promise = decision;
      active.add(entry);
      decision.then(() => { chosenEntry.settled = true; retire(chosenEntry); }, () => { chosenEntry.failed = true; chosenEntry.settled = true; retire(chosenEntry); });
    }
    const signal = payload.signal ? AbortSignal.any([payload.signal, chosenEntry.abort.signal]) : chosenEntry.abort.signal;
    const combined = Promise.all([routePromise, chosenEntry.promise]).then(([route, decision]) => {
      signal.throwIfAborted();
      const now = live(agent.id);
      if (closing || chosenEntry.closed || !now || now.agent !== agent || now.session !== session) throw new Error('session or agent changed before return');
      return { route, imported: false, ready: first && decision.ready && support(route) === 'supported', support: support(route) };
    });
    return watch(entry, entry.calls, waitWithSignal(combined, signal));
  }
  async function closeAgent(agent) {
    const entry = entries.get(agent.session);
    if (!entry || entry.agent !== agent) return;
    entry.closed = true;
    entry.abort?.abort();
    // A resolver that ignores abort is still drained: disposal may wait forever.
    await Promise.allSettled(pending(entry));
  }
  async function close() {
    closing = true;
    const entriesToDrain = [...active];
    for (const entry of entriesToDrain) { entry.closed = true; entry.abort.abort(); }
    await Promise.allSettled(entriesToDrain.flatMap(pending));
  }
  return { get, set, setPendingBeforeStep, request, closeAgent, close };
}
