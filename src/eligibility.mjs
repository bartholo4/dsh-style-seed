// Only top-level, non-seeded sessions can opt in to a new history template.
export function isEligibleTopLevel(agent) {
  const header = agent?.session?.header;
  return Boolean(header && !header.isSeeded && !header.parentSession &&
    (header.delegationDepth ?? 0) === 0 && header.origin !== 'subagent');
}

export function isBlankAgent(agent) {
  if (!isEligibleTopLevel(agent) || agent.status !== 'idle') return false;
  return !agent.session.snapshotEvents().some(event =>
    ['turn/start', 'user/message', 'assistant/message', 'request/header'].includes(event.type));
}
