// Restore a verified, previously admitted reference after DSH compaction.
// All writes go through the AgentLoop's normal pre-step message admission.
export function installRecovery(ctx, agent, selection, target, readSeed, codec, store) {
  let recovering = false;
  const stopPre = ctx.on('agent/pre-step', async (payload, next) => {
    recovering = false;
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    payload.signal.throwIfAborted();
    const active = store.get(agent.id);
    if (!active || active.state !== 'active') return decision;
    const route = selection.assembled;
    if (route?.provider !== target.provider || route?.model !== target.model) return decision;
    if (active.owner !== agent.id) throw new Error('history recovery: owner mismatch');
    const current = agent.session.deriveMessages();
    const present = current.filter(message => codec.read(message, agent.id));
    const queued = decision.messages.filter(message => codec.read(message, agent.id));
    const existing = [...present, ...queued];
    if (existing.length > 1 || (existing[0] && codec.read(existing[0], agent.id).sha256 !== active.sha256)) {
      throw new Error('history recovery: invalid live reference');
    }
    if (existing.length) return decision;
    const loaded = await readSeed(payload.signal, active.sha256);
    if (loaded.sha256 !== active.sha256) throw new Error('history recovery: template changed');
    const currentRoute = selection.assembled, currentAdmission = store.get(agent.id);
    if (currentRoute?.provider !== route.provider || currentRoute?.model !== route.model ||
        currentAdmission?.state !== 'active' || currentAdmission.owner !== active.owner ||
        currentAdmission.sha256 !== active.sha256) throw new Error('history recovery: route or admission changed');
    const history = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      .map(event => event.data).filter(message => codec.read(message, agent.id)?.sha256 === active.sha256);
    if (!history.length) throw new Error('history recovery: no verified original reference');
    payload.signal.throwIfAborted();
    recovering = true;
    return { ...decision, messages: [history[0], ...decision.messages] };
  }, { prepend: true });
  const stopRequest = ctx.on('agent/request', async (_payload, next) => {
    const route = await next();
    if (recovering && (route?.provider !== target.provider || route?.model !== target.model ||
        route?.reasoningEffort !== target.reasoningEffort)) throw new Error('history recovery: model or effort changed');
    return route;
  }, { prepend: true });
  return () => { stopPre(); stopRequest(); };
}
