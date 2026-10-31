import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';

const sameRoute=(a,b)=>a?.provider===b?.provider && a?.model===b?.model && a?.reasoningEffort===b?.reasoningEffort;

// Restore only a verified existing reference if compaction removed it. Disabled
// sessions never restore a reference; neither history nor templates are edited.
export function installSelectedRecovery(ctx,agent,selection,readSeed,codec,store) {
  let recovering;
  const stopPre=ctx.on('agent/pre-step',async(payload,next)=>{
    recovering=undefined;
    const decision=await next();
    if (decision.kind==='reject') return decision;
    payload.signal.throwIfAborted();
    const active=store.get(agent.id);
    if (!active || active.state!=='active' || active.mode==='sidecar-only') return decision;
    const route=selection.assembled;
    if (!route?.provider || !route?.model || active.owner!==agent.id) throw new Error('history recovery: route or owner unavailable');
    const visible=[...agent.session.deriveMessages(),...decision.messages].map(message=>codec.read(message,agent.id)).filter(Boolean);
    if (visible.length>1 || (visible.length && visible[0].sha256!==active.sha256)) throw new Error('history recovery: invalid reference');
    if (visible.length) return decision;
    const loaded=await readSeed(payload.signal,active.sha256);
    if (loaded.sha256!==active.sha256) throw new Error('history recovery: template changed');
    const now=store.get(agent.id), selected=selection.assembled;
    if (now?.state!=='active' || now.owner!==active.owner || now.sha256!==active.sha256 ||
        selected?.provider!==route.provider || selected?.model!==route.model) throw new Error('history recovery: route or admission changed');
    const prior=agent.session.snapshotEvents().filter(event=>event.type==='user/message').map(event=>event.data)
      .filter(message=>codec.read(message,agent.id)?.sha256===active.sha256);
    if (!prior.length) throw new Error('history recovery: original reference unavailable');
    payload.signal.throwIfAborted(); recovering=route;
    return {...decision,messages:[prior[0],...decision.messages]};
  },{prepend:true});
  const stopRequest=ctx.on('agent/request',async(_payload,next)=>{
    const route=await next();
    if (recovering && (route?.provider!==recovering.provider || route?.model!==recovering.model)) throw new Error('history recovery: model changed');
    return route;
  },{prepend:true});
  return ()=>{stopPre();stopRequest();};
}

export function installSelectedOverflowRecovery(ctx,agent,readSeed,codec,store) {
  let pin;
  const stopError=ctx.on('agent/request-error',async(payload,next)=>{
    const action=await next();
    if (action?.kind!=='retry' || payload.failure?.code!==CONTEXT_WINDOW_EXCEEDED_CODE) return action;
    payload.signal.throwIfAborted();
    const admission=store.get(agent.id), route=agent.session.requestHeader()?.config;
    if (!admission || admission.state!=='active' || admission.mode==='sidecar-only') return action;
    if (admission.owner!==agent.id || !route?.provider || !route?.model) throw new Error('overflow recovery: owner or route unavailable');
    const checkVisible=()=>{
      const visible=agent.session.deriveMessages().map(message=>codec.read(message,agent.id)).filter(Boolean);
      if (visible.length>1 || (visible.length===1 && visible[0].sha256!==admission.sha256)) throw new Error('overflow recovery: invalid reference');
      return visible.length;
    };
    if (checkVisible()) return action;
    const loaded=await readSeed(payload.signal,admission.sha256);
    if (loaded.sha256!==admission.sha256) throw new Error('overflow recovery: template changed');
    const current=store.get(agent.id);
    if (current?.state!=='active' || current.owner!==agent.id || current.sha256!==admission.sha256 ||
        !sameRoute(agent.session.requestHeader()?.config,route)) throw new Error('overflow recovery: route or admission changed');
    if (checkVisible()) return action;
    const prior=agent.session.snapshotEvents().filter(event=>event.type==='user/message').map(event=>event.data)
      .filter(message=>codec.read(message,agent.id)?.sha256===admission.sha256);
    if (!prior.length) throw new Error('overflow recovery: original reference unavailable');
    payload.signal.throwIfAborted();
    agent.session.append('user/message',prior[0],{surfaceOp:'append'});
    pin={turn:payload.turn,step:payload.step,route};
    return action;
  },{prepend:true});
  const stopRequest=ctx.on('agent/request',async(payload,next)=>{
    const route=await next();
    if (pin && payload.turn===pin.turn && payload.step===pin.step) {
      const previous=pin; pin=undefined;
      if (!sameRoute(route,previous.route)) throw new Error('overflow recovery: retry route changed');
    }
    return route;
  },{prepend:true});
  const stopPre=ctx.on('agent/pre-step',async(_payload,next)=>{pin=undefined;return next();},{prepend:true});
  return ()=>{stopError();stopRequest();stopPre();};
}
