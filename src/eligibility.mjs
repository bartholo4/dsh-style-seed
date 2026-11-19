// Only top-level, non-seeded sessions can opt in to a new history template.
export function isEligibleTopLevel(agent) {
  const header = agent?.session?.header;
  return Boolean(header && !header.isSeeded && !header.parentSession &&
    (header.delegationDepth ?? 0) === 0 && header.origin !== 'subagent');
}

// Child sessions (subagents / team members) never expose the interactive UI
// switch, but can optionally inherit sidecar-only seeding when their ancestor
// top-level session explicitly enabled the switch.
export function isInheritableChild(agent) {
  const header = agent?.session?.header;
  return Boolean(header && !header.isSeeded && typeof header.parentSession === 'string' &&
    header.parentSession.length > 0 && ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent'));
}

export function findInheritedParentAdmission(ctx, agent, store, maxDepth = 8) {
  if (!isInheritableChild(agent) || !store || typeof store.get !== 'function') return undefined;
  const visited = new Set([agent.id, agent.session?.id].filter(Boolean));
  let parentId = agent.session.header.parentSession;
  for (let depth = 0; depth < maxDepth && typeof parentId === 'string' && parentId.length > 0; depth++) {
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    let record;
    try { record = store.get(parentId); } catch { return undefined; }
    if (record) {
      if (record.mode === 'sidecar-only' && (record.state === 'active' || record.state === 'pending')) {
        return { parentSessionId: parentId, admission: record };
      }
      // An explicitly disabled or non-sidecar ancestor stops inheritance.
      return undefined;
    }
    const ancestor = ctx?.agents?.get?.(parentId);
    parentId = ancestor?.session?.header?.parentSession;
  }
  return undefined;
}

export function isBlankAgent(agent) {
  if (!isEligibleTopLevel(agent) || agent.status !== 'idle') return false;
  return !agent.session.snapshotEvents().some(event =>
    ['turn/start', 'user/message', 'assistant/message', 'request/header'].includes(event.type));
}
