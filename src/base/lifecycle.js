import { DEFAULTS, PROVIDER, SEED_SOURCE, SeedError } from './constants.js';
import { loadSeed, seedCarrierSource } from './seed.js';

export function eligibleNewSession(agent, source) {
  const header = agent.session.header;
  if (source !== 'startup' || header.isSeeded || header.parentSession || (header.delegationDepth ?? 0) > 0) return false;
  return !agent.session.snapshotEvents().some((event) => ['user/message', 'assistant/message', 'request/header', 'turn/start'].includes(event.type));
}

/** Capture the resolved first route, not stale AgentOptions overridden by the UI selection hook. */
export function createFirstRequestHook(agent, config, helpers) {
  let decided = false, pending;
  return async (payload, next) => {
    const signal = helpers.lifecycleSignal && payload.signal
      ? AbortSignal.any([helpers.lifecycleSignal, payload.signal])
      : helpers.lifecycleSignal ?? payload.signal;
    const resolved = await next();
    signal?.throwIfAborted();
    if (decided) return resolved;
    if (resolved.provider !== PROVIDER || resolved.model !== config.model || !config.seedPath) { decided = true; return resolved; }
    if (pending) { await pending; return resolved; }
    pending = (async () => {
      const session = agent.session;
      const events = session.snapshotEvents();
      // A retry after import is idempotent; a later switch or old conversation never imports.
      if (events.some((event) => event.type === 'user/message' && event.data.source?.kind === SEED_SOURCE)) { decided = true; return; }
      if (events.some((event) => ['user/message', 'assistant/message', 'request/header'].includes(event.type))) { decided = true; return; }
      const loaded = await (helpers.loadSeed ?? loadSeed)(config.seedPath, config.maxSeedBytes ?? DEFAULTS.maxSeedBytes, signal);
      signal?.throwIfAborted();
      // The core will replace this reserved empty head with its actual assembled prompt.
      // Keeping node 0 protected is mandatory before any user surface node is appended.
      if (session.surface.nodes.length === 0) session.append('system/message', {
        turn: payload.turn, step: payload.step, message: helpers.createSystemMessage(''),
      }, { surfaceOp: 'append' });
      signal?.throwIfAborted();
      const message = helpers.createUserMessage({
        source: seedCarrierSource(loaded, session.id),
        content: [{ type: 'text', text: `[Imported conversation template: ${loaded.template.id}. Display marker; expanded only by the History template provider.]` }],
      });
      session.append('user/message', message, { surfaceOp: 'append' });
      decided = true;
    })();
    try { await pending; }
    catch (error) {
      if (error instanceof SeedError || signal?.aborted) throw error;
      throw new SeedError('History template could not be attached to the new session', 'SEED_IMPORT_FAILED');
    } finally { pending = undefined; }
    return resolved;
  };
}
