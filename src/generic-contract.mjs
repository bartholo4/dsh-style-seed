const canceled = () => new Error('history switch operation canceled');
const unavailable = () => new Error('history switch status unavailable');
const admissionStates = new Set(['pending', 'active', 'skipped', 'disabled']);
const inputEvents = new Set(['user/message', 'assistant/message', 'request/header']);
const startedEvents = new Set([...inputEvents, 'turn/start', 'step/start']);

function topLevel(session, id) {
  const h = session?.header;
  return Boolean(session?.id === id && h?.id === id && !h.isSeeded && !h.parentSession &&
    (h.delegationDepth ?? 0) === 0 && h.origin !== 'subagent');
}

function eventsOf(session) {
  const events = session.snapshotEvents();
  if (!Array.isArray(events)) throw unavailable();
  return events;
}

function checkSignal(signal) { if (signal?.aborted) throw canceled(); }

// Do not let an aborting caller leave an unobserved rejected resolver behind.
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(canceled()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** Session admission state only; bindingVerified does not verify a provider route. */
export function createGenericSwitchContract({ sessions, agents, store, defaultSelection, isManaged = () => false, canEdit = () => true }) {
  if (typeof sessions?.get !== 'function' || typeof agents?.get !== 'function' ||
      typeof store?.get !== 'function' || typeof store?.disable !== 'function' ||
      typeof store?.abandonPending !== 'function' || typeof isManaged !== 'function' || typeof canEdit !== 'function') {
    throw new TypeError('history switch dependencies unavailable');
  }
  // Support is deliberately unknown and no route/default selection is inferred.
  void defaultSelection;
  const entries = new WeakMap(), liveEntries = new Set();
  let closing = false, closePromise;

  function readAdmission(id) {
    let record;
    try { record = store.get(id); } catch { throw unavailable(); }
    if (record === undefined) return undefined;
    if (!record || record.owner !== id || typeof record.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(record.sha256) || !admissionStates.has(record.state)) throw unavailable();
    return record;
  }

  function managed(agent) {
    try { return isManaged(agent) === true; } catch { throw unavailable(); }
  }

  function entryFor(session, agent) {
    let entry = entries.get(session);
    if (entry && (entry.agent !== agent || entry.closed)) throw unavailable();
    if (!entry) {
      entry = { session, agent, enabled: false, closed: false, failed: false,
        pending: undefined, calls: 0, routes: new Set(), abort: new AbortController() };
      entries.set(session, entry); liveEntries.add(entry);
    }
    return entry;
  }

  function requireAgent(agent) {
    const session = agent?.session;
    if (closing || !agent || !session || sessions.get(agent.id) !== session || agents.get(agent.id) !== agent ||
        !topLevel(session, agent.id) || !managed(agent)) throw unavailable();
  }

  function requireOwner(entry) {
    requireAgent(entry.agent);
    if (entry.closed || entry.agent.session !== entry.session || entries.get(entry.session) !== entry) throw unavailable();
  }

  function enabledFor(entry, record, blank) {
    if (record?.state === 'disabled') return false;
    if (record?.state === 'active') return true;
    if (!blank && record?.state === 'pending') return true;
    if (!blank && record?.state === 'skipped') return false;
    return entry?.enabled === true;
  }

  function get(id) {
    if (closing || typeof id !== 'string' || !id.trim()) throw unavailable();
    const session = sessions.get(id), agent = agents.get(id);
    if (session && !topLevel(session, id)) return { editable: false, enabled: false, support: 'unknown', admission: null };
    if (!agent) {
      const record = readAdmission(id);
      return { editable: false, enabled: record?.state === 'active' || record?.state === 'pending',
        support: 'unknown', admission: record?.state ?? null, savedOnly: true };
    }
    if (!session || agent.id !== id || agent.session !== session || !topLevel(session, id)) throw unavailable();
    const entry = entries.get(session);
    if (entry && (entry.agent !== agent || entry.closed || entry.failed)) throw unavailable();
    if (entry?.pending) return { ...entry.pending.prior, editable: false };
    const record = readAdmission(id), events = eventsOf(session);
    const blank = !events.some(event => startedEvents.has(event?.type));
    if (!record && entry?.enabled && events.some(event => inputEvents.has(event?.type))) throw unavailable();
    const enabled = enabledFor(entry, record, blank);
    const editable = canEdit() === true && managed(agent) && agent.status === 'idle' && !(entry?.calls || entry?.routes.size) &&
      (blank ? record?.state !== 'disabled' : enabled);
    return { editable, enabled, support: 'unknown', admission: record?.state ?? null };
  }

  async function set(id, enabled) {
    if (closing) throw unavailable();
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    const prior = get(id), session = sessions.get(id), agent = agents.get(id);
    if (!prior.editable || !session || !agent) throw new Error('history switch is not editable');
    const blank = !eventsOf(session).some(event => startedEvents.has(event?.type));
    if (enabled && !blank) throw new Error('history switch cannot be enabled after the session starts');
    const record = readAdmission(id), entry = entryFor(session, agent);
    requireOwner(entry);
    if (entry.pending || entry.calls || entry.routes.size) throw new Error('history switch is busy');
    const done = Promise.withResolvers();
    const pending = { done, prior }; entry.pending = pending;
    try {
      if (record && blank && (record.state === 'pending' || record.state === 'skipped')) {
        const abandoned = await store.abandonPending(id, record.sha256);
        if (abandoned !== true || readAdmission(id) !== undefined) throw unavailable();
        requireOwner(entry);
        if (eventsOf(session).some(event => inputEvents.has(event?.type))) throw unavailable();
      } else if (!enabled && record) {
        const result = await store.disable(id, record.sha256);
        const saved = readAdmission(id);
        if (!result || result.owner !== id || result.sha256 !== record.sha256 || result.state !== 'disabled' ||
            !saved || saved.sha256 !== record.sha256 || saved.state !== 'disabled') throw unavailable();
      }
      requireOwner(entry);
      // A request may start while a durable change is waiting. Its pre-step
      // waits on this operation and must not observe the old enabled value.
      entry.enabled = enabled;
    } catch {
      entry.failed = true;
      throw unavailable();
    } finally {
      if (entry.pending === pending) entry.pending = undefined;
      done.resolve();
    }
    return get(id);
  }

  async function waitPending(agent, signal) {
    checkSignal(signal);
    if (!agent?.session) throw unavailable();
    requireAgent(agent);
    const entry = entryFor(agent.session, agent);
    requireOwner(entry);
    const combined = signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal;
    const pending = entry.pending;
    if (pending) await waitWithSignal(pending.done.promise, combined);
    checkSignal(combined);
    requireOwner(entry);
    if (entry.failed) throw unavailable();
  }

  async function request(agent, payload, resolveRoute, admitCandidate = false) {
    if (typeof resolveRoute !== 'function' || !agent?.session) throw unavailable();
    const signal = payload?.signal;
    checkSignal(signal);
    requireAgent(agent);
    const entry = entryFor(agent.session, agent);
    requireOwner(entry);
    const combined = signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal;
    entry.calls++;
    try {
      await waitPending(agent, combined);
      checkSignal(combined); requireOwner(entry);
      const routePromise = Promise.resolve().then(() => { checkSignal(combined); return resolveRoute(combined); });
      entry.routes.add(routePromise);
      routePromise.then(() => entry.routes.delete(routePromise), () => entry.routes.delete(routePromise));
      const route = await waitWithSignal(routePromise, combined);
      checkSignal(combined); requireOwner(entry);
      if (entry.failed) throw unavailable();
      const events = eventsOf(entry.session), blank = !events.some(event => startedEvents.has(event?.type));
      const record = readAdmission(agent.id);
      if (!record && entry.enabled && events.some(event => inputEvents.has(event?.type))) throw unavailable();
      const ready = admitCandidate === true && enabledFor(entry, record, blank);
      return { route, ready, bindingVerified: ready, imported: false, support: 'unknown' };
    } finally { entry.calls--; }
  }

  async function closeAgent(agent) {
    const session = agent?.session, entry = session && entries.get(session);
    if (!entry || entry.agent !== agent) return;
    entry.closed = true; entry.abort.abort();
    await Promise.allSettled([...(entry.pending ? [entry.pending.done.promise] : []), ...entry.routes]);
    if (entries.get(session) === entry) entries.delete(session);
    liveEntries.delete(entry);
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    const all = [...liveEntries];
    for (const entry of all) { entry.closed = true; entry.abort.abort(); }
    closePromise = Promise.allSettled(all.flatMap(entry => [
      ...(entry.pending ? [entry.pending.done.promise] : []), ...entry.routes,
    ])).then(() => { liveEntries.clear(); });
    return closePromise;
  }

  return Object.freeze({ get, set, waitPending, request, closeAgent, close });
}
