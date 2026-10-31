// Decide from the durable host session log, never from visible seed text or
// from a model's intermediate tool-call step. Old template fingerprints keep
// their existing repeated-seed behavior.
export function hasCompletedReply(events, codec, sessionId, expectedSha256) {
  if (!Array.isArray(events) || !codec || typeof codec.read !== 'function' ||
      typeof sessionId !== 'string' || !sessionId ||
      typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new Error('history switch first-turn state unavailable');
  let referenceSeen = false, turn = null;
  for (const event of events) {
    const data = event?.data;
    if (event?.type === 'turn/start') {
      if (!Number.isSafeInteger(data?.turn) || data.turn < 1) throw new Error('history switch turn state invalid');
      turn = { number: data.turn, user: false, lastAssistant: undefined };
    } else if (event?.type === 'user/message') {
      if (data?.source?.kind === 'dsh-style-seed-reference') {
        const ref = codec.read(data, sessionId);
        if (!ref || ref.ownerSessionId !== sessionId || ref.sha256 !== expectedSha256)
          throw new Error('history switch first-turn reference invalid');
        referenceSeen = true;
      } else if (referenceSeen && turn && data?.role === 'user' && data.source?.kind === 'user') {
        turn.user = true;
      }
    } else if (event?.type === 'assistant/message' && turn && data?.turn === turn.number) {
      const message = data.message;
      if (message?.role === 'assistant' && message.source?.kind === 'model') turn.lastAssistant = message;
    } else if (event?.type === 'turn/end' && turn && data?.turn === turn.number) {
      const blocks = turn.lastAssistant?.content;
      if (referenceSeen && turn.user && data?.reason?.kind === 'completed' &&
          Array.isArray(blocks) && blocks.some(block => block?.type === 'text' &&
            typeof block.text === 'string' && block.text.trim()) &&
          !blocks.some(block => block?.type === 'tool-call')) return true;
      turn = null;
    }
  }
  if (!referenceSeen) throw new Error('history switch original reference unavailable');
  return false;
}

export function makeFirstTurnClassifier(ctx, codec, firstOnlySha256) {
  if (typeof firstOnlySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(firstOnlySha256))
    throw new Error('history switch first-turn fingerprint invalid');
  return Object.freeze({
    sha256: firstOnlySha256,
    completed(sessionId) {
      const agent = ctx.agents?.get(sessionId);
      if (!agent || agent.id !== sessionId || agent.session?.id !== sessionId ||
          typeof agent.session.snapshotEvents !== 'function')
        throw new Error('history switch first-turn session unavailable');
      return hasCompletedReply(agent.session.snapshotEvents(), codec, sessionId, firstOnlySha256);
    },
  });
}
