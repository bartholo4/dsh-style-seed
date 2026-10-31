// Test-only binding authority. Requires injected official-service-compatible
// verifier and a non-sensitive revision reader; not a production entrypoint.
export function createSyntheticAuthority(verifier, target, getRevision) {
  let records = new WeakMap(), epochs = new WeakMap(), closed = false;
  const abortIfNeeded = signal => { if (signal?.aborted) throw new Error('history switch authority canceled'); };
  const epoch = session => epochs.get(session) ?? 0;
  const tick = session => epochs.set(session, epoch(session) + 1);
  function revision() {
    let value;
    try { value = getRevision(); } catch { throw new Error('history switch revision unavailable'); }
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('history switch revision unavailable');
    return value;
  }
  async function capture({ session, agent, route, signal }) {
    if (closed || !session || !agent || agent.session !== session) throw new Error('history switch authority unavailable');
    abortIfNeeded(signal);
    const before = epoch(session), beforeRevision = revision();
    let record = records.get(session);
    if (!record) {
      const ticket = await verifier.acquire(route ?? target, signal);
      abortIfNeeded(signal);
      if (closed || before !== epoch(session) || beforeRevision !== revision() || agent.session !== session) throw new Error('history switch authority changed');
      record = { agent, ticket, busy: false, revision: beforeRevision }; records.set(session, record);
    }
    if (record.agent !== agent || record.revision !== beforeRevision || record.busy) throw new Error('history switch authority owner or revision changed');
    // A canceled/failed verification consumes its ticket. Reacquire only for
    // the same session, same agent and unchanged original revision.
    if (!record.ticket) {
      record.busy = true;
      try {
        const ticket = await verifier.acquire(route ?? target, signal);
        abortIfNeeded(signal);
        if (closed || before !== epoch(session) || records.get(session) !== record || record.revision !== revision() || agent.session !== session) throw new Error('history switch authority changed');
        record.ticket = ticket;
      } finally { record.busy = false; }
    }
    return { provider: target.provider, model: target.model, baseURL: target.baseURL,
      credentialRef: target.apiKeyEnv, revision: String(record.revision), verified: true };
  }
  async function verifyRequest({ session, agent, request }, signal) {
    const record = records.get(session), before = epoch(session);
    if (closed || !record || record.agent !== agent || record.busy || !record.ticket || record.revision !== revision()) throw new Error('history switch ticket unavailable');
    record.busy = true;
    const ticket = record.ticket; record.ticket = undefined; // one-use, including abort.
    try {
      await verifier.verify(ticket, request, signal);
      abortIfNeeded(signal);
      if (record.revision !== revision()) throw new Error('history switch authority changed');
      // Acquire the next attempt while current configuration is still valid.
      const renewed = await verifier.acquire(request, signal);
      abortIfNeeded(signal);
      if (closed || before !== epoch(session) || records.get(session) !== record || record.revision !== revision() || agent.session !== session) throw new Error('history switch authority changed');
      record.ticket = renewed;
      return true;
    } catch (error) {
      if (signal?.aborted) throw new Error('history switch authority canceled');
      throw new Error('history switch authority verification failed');
    } finally { record.busy = false; }
  }
  function clear(session) { tick(session); records.delete(session); }
  function close() { closed = true; records = new WeakMap(); epochs = new WeakMap(); verifier.dispose(); }
  return Object.freeze({ capture, verifyRequest, clear, close });
}
