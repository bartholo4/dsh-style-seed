import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';

// The host retries overflow inside the same step without another pre-step.
// Re-admit a verified reference to the normal session surface after the host
// has finished compaction and before that retry is prepared.
export function installOverflowRecovery(ctx, agent, target, readSeed, codec, store) {
  const sameRoute = route => route?.provider === target.provider && route?.model === target.model && route?.reasoningEffort === target.reasoningEffort;
  let pin;
  const stopError = ctx.on('agent/request-error', async (payload, next) => {
    const action = await next();
    if (action?.kind !== 'retry' || payload.failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return action;
    payload.signal.throwIfAborted();
    const admission = store.get(agent.id), route = agent.session.requestHeader()?.config;
    if (!admission || admission.state !== 'active' || !sameRoute(route)) return action;
    if (admission.owner !== agent.id) throw new Error('overflow recovery: owner mismatch');
    const checkVisible = () => {
      const visible = agent.session.deriveMessages().map(message => codec.read(message, agent.id)).filter(Boolean);
      if (visible.length > 1 || (visible.length === 1 && visible[0].sha256 !== admission.sha256)) throw new Error('overflow recovery: bad live reference');
      return visible.length;
    };
    if (checkVisible()) return action;
    const loaded = await readSeed(payload.signal, admission.sha256);
    if (loaded.sha256 !== admission.sha256) throw new Error('overflow recovery: template changed');
    const current = store.get(agent.id);
    if (current?.state !== 'active' || current.owner !== agent.id || current.sha256 !== admission.sha256 || !sameRoute(agent.session.requestHeader()?.config)) {
      throw new Error('overflow recovery: route or admission changed');
    }
    if (checkVisible()) return action;
    const prior = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data)
      .filter(message => codec.read(message, agent.id)?.sha256 === admission.sha256);
    if (!prior.length) throw new Error('overflow recovery: no verified original');
    payload.signal.throwIfAborted();
    agent.session.append('user/message', prior[0], { surfaceOp: 'append' });
    pin = { turn: payload.turn, step: payload.step };
    return action;
  }, { prepend: true });
  const stopRequest = ctx.on('agent/request', async (payload, next) => {
    const route = await next();
    if (pin && payload.turn === pin.turn && payload.step === pin.step) {
      pin = undefined;
      if (!sameRoute(route)) throw new Error('overflow recovery: retry route changed');
    }
    return route;
  }, { prepend: true });
  const stopPre = ctx.on('agent/pre-step', async (_payload, next) => { pin = undefined; return next(); }, { prepend: true });
  return () => { stopError(); stopRequest(); stopPre(); };
}
