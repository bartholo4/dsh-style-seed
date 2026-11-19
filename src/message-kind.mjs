// Message and session-event classifiers for DSH user-role contexts, task
// entries (user / goal / schedule), and compaction checkpoints. Read-only:
// never rewrites or reorders host messages.

export const CONTEXT_SOURCE_KINDS = new Set([
  'agent-instructions',
  'agent-message',
  'compact-checkpoint',
  'dsh-style-seed-reference',
  'model-selection',
  'ptc-mode',
  'repeat-tool-reminder',
  'runtime-context',
  'skill-catalog',
  'subagent-report',
  'subagent-settled',
  'team-message',
  'time-context',
  'tool-jobs',
  'user-approval',
  'user-question-reply',
  'working-directory',
]);

const TASK_SOURCE_KINDS = new Set(['user', 'goal', 'schedule', 'tool-goal']);

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if ((block?.type === 'text' || block?.type === undefined) && typeof block?.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

export function isCompactionCheckpointMessage(message) {
  if (!message || (message.role !== 'user' && message.role !== 'system')) return false;
  if (message.source?.kind === 'compact-checkpoint') return true;
  const text = textOf(message);
  return text.includes('<compacted-summary>') || text.includes('automatically generated checkpoint');
}

export function isCompactionBoundaryEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'compaction/summary') return true;
  return event.type === 'user/message' && isCompactionCheckpointMessage(event.data);
}

export function isContextUserMessage(message) {
  if (message?.role !== 'user') return false;
  if (isCompactionCheckpointMessage(message)) return true;
  const kind = message.source?.kind;
  return typeof kind === 'string' && CONTEXT_SOURCE_KINDS.has(kind);
}

// Deny-list based on known DSH context kinds so user, goal, schedule, and
// tool-goal task entries are all recognized without mistaking injected
// runtime/skill/team context blocks for the task entry.
export function isTaskUserMessage(message) {
  if (message?.role !== 'user') return false;
  if (isCompactionCheckpointMessage(message)) return false;
  const kind = message.source?.kind;
  if (typeof kind === 'string' && kind.length > 0) {
    if (TASK_SOURCE_KINDS.has(kind)) return true;
    if (CONTEXT_SOURCE_KINDS.has(kind)) return false;
  }
  return true;
}

export function lastCompactionCheckpointIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactionCheckpointMessage(messages[i])) return i;
  }
  return -1;
}

export function findSeedInsertionIndex(messages, { afterLastCompaction = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) return -1;
  if (afterLastCompaction) {
    const checkpointIndex = lastCompactionCheckpointIndex(messages);
    if (checkpointIndex >= 0) {
      for (let i = checkpointIndex + 1; i < messages.length; i++) {
        if (isTaskUserMessage(messages[i])) return i;
      }
      return -1;
    }
  }
  return messages.findIndex(isTaskUserMessage);
}

// Determine whether a sidecar-only session still needs D projected for the
// current cycle (either the initial turn or, when reseedAfterCompaction is
// enabled, the first completed task turn after the latest compaction boundary).
export function sidecarNeedsSeed(events, { reseedAfterCompaction = true } = {}) {
  if (!Array.isArray(events)) return { needed: true, afterCompaction: false };
  let lastCompaction = -1;
  if (reseedAfterCompaction) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (isCompactionBoundaryEvent(events[i])) { lastCompaction = i; break; }
    }
  }
  let turn;
  for (let i = lastCompaction + 1; i < events.length; i++) {
    const event = events[i];
    const data = event?.data;
    if (event?.type === 'turn/start') turn = { number: data?.turn, user: false, assistant: undefined };
    else if (event?.type === 'user/message' && turn && isTaskUserMessage(data)) turn.user = true;
    else if (event?.type === 'assistant/message' && turn && data?.turn === turn.number && data.message?.role === 'assistant') turn.assistant = data.message;
    else if (event?.type === 'turn/end' && turn && data?.turn === turn.number) {
      const blocks = turn.assistant?.content;
      if (turn.user && data?.reason?.kind === 'completed' && Array.isArray(blocks) &&
          blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim()) &&
          !blocks.some(block => block.type === 'tool-call')) {
        return { needed: false, afterCompaction: lastCompaction >= 0 };
      }
      turn = undefined;
    }
  }
  return { needed: true, afterCompaction: lastCompaction >= 0 };
}

// New enabled sessions are blank at admission, so the first completed real
// user/assistant turn establishes the point after which D is omitted.
export function sidecarFirstReplyCompleted(events) {
  return !sidecarNeedsSeed(events, { reseedAfterCompaction: false }).needed;
}
