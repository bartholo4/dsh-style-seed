import { isAgentLoopRequest, callConfigEquals } from '@deepseek-ai/dsh-llm';
import { fingerprintSeed, validateSeed } from './base/seed.js';
import { DEFAULTS } from './base/constants.js';
import { withinEstimatedBudget } from './integration.mjs';
import { isEligibleTopLevel } from './eligibility.mjs';
import { selectedRouteSnapshot, assertSameRouteSnapshot, seedMessages, restoreLegacyReasoning, preserveToolImages } from './selected-route.mjs';

const cancel = signal => { if (signal?.aborted) throw new Error('weneed开关请求已取消'); };
const routeConfig = options => Object.fromEntries(['provider','model','reasoningEffort','temperature','maxTokens','stop']
  .filter(key => options[key] !== undefined).map(key => [key,options[key]]));

// New enabled sessions are blank at admission, so the first completed real
// user/assistant turn establishes the point after which D is omitted.
export function sidecarFirstReplyCompleted(events) {
  let turn;
  for (const event of events) {
    const data=event?.data;
    if (event?.type==='turn/start') turn={number:data?.turn,user:false,assistant:undefined};
    else if (event?.type==='user/message' && turn && data?.role==='user' && data.source?.kind==='user') turn.user=true;
    else if (event?.type==='assistant/message' && turn && data?.turn===turn.number && data.message?.role==='assistant') turn.assistant=data.message;
    else if (event?.type==='turn/end' && turn && data?.turn===turn.number) {
      const blocks=turn.assistant?.content;
      if (turn.user && data?.reason?.kind==='completed' && Array.isArray(blocks) &&
          blocks.some(block=>block.type==='text' && typeof block.text==='string' && block.text.trim()) &&
          !blocks.some(block=>block.type==='tool-call')) return true;
      turn=undefined;
    }
  }
  return false;
}

// The carrier is the only durable addition. Each request is projected to a
// bound, one-use native DSH prepared call; no base URL or API key is copied.
export function installSelectedStream(ctx, {codec,store,registry,firstOnly,routeByAgent,topology}) {
  return ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || options.purpose !== undefined) return next();
    const agent=ctx.agents.get(options.sessionId);
    if (!isEligibleTopLevel(agent)) return next();
    const carriers=options.messages.map(message=>codec.read(message,options.sessionId)).filter(Boolean);
    const admission=store.get(options.sessionId);
    const sidecarOnly=admission?.mode==='sidecar-only';
    if (sidecarOnly) {
      if (admission.owner!==options.sessionId || carriers.length || !['pending','active','disabled'].includes(admission.state))
        throw new Error('weneed开关的会话记录不匹配');
      // No hidden message was ever added to this session. Off or a completed
      // first answer can use the original DSH prepared route directly.
      if (admission.state==='disabled' || sidecarFirstReplyCompleted(agent.session.snapshotEvents())) return next();
    }
    const disabledWithoutCarrier=!carriers.length && admission?.state==='disabled';
    // If no carrier remains and the route has no inspectable settings, a
    // disabled session can use the original prepared request untouched.
    if (disabledWithoutCarrier && !routeByAgent.get(agent)?.snapshot) return next();
    if (!carriers.length && !disabledWithoutCarrier && !sidecarOnly) {
      if (admission && ['pending','active'].includes(admission.state)) throw new Error('weneed开关历史引用不在当前上下文');
      return next();
    }
    if (!admission || admission.owner!==options.sessionId ||
        (!sidecarOnly && !disabledWithoutCarrier && (carriers.length!==1 || admission.sha256!==carriers[0].sha256)) ||
        !['pending','active','disabled'].includes(admission.state)) {
      throw new Error('weneed开关的会话记录不匹配');
    }
    if (!Object.isFrozen(options) || !Object.isFrozen(options.messages)) throw new Error('weneed开关的请求状态未固定');
    const originalMessages=options.messages;
    return (async function* () {
      cancel(options.signal);
      const includeSeed=sidecarOnly || (admission.state!=='disabled' &&
        !(firstOnly?.sha256===admission.sha256 && firstOnly.completed(options.sessionId)));
      const entry=routeByAgent.get(agent);
      if (entry && (entry.route?.provider!==options.provider || entry.route?.model!==options.model)) throw new Error('所选模型在请求准备期间发生变化，请重试');
      const checkTopology=()=>{if (!entry || entry.topologyRevision!==topology?.revision ||
          entry.settingsRevision!==topology?.settingsRevision) throw new Error('模型服务在请求准备期间发生变化，请重试');};
      checkTopology();
      const held=entry?.snapshot;
      if (!held || held.provider!==options.provider || held.model!==options.model) throw new Error('weneed开关无法确认所选模型的服务配置；请新建会话并保持开关关闭');
      assertSameRouteSnapshot(ctx,held);
      if (includeSeed) {
        if (!['openai-completions','deepseek-messages'].includes(held.api) || held.thinkingAsText) throw new Error('weneed开关暂不支持所选服务的接口格式；请关闭开关后继续');
      }
      const prepared=await ctx.llm.prepareCall(routeConfig(options),options.signal);
      cancel(options.signal);
      checkTopology();
      if (!callConfigEquals(prepared.config,options)) throw new Error('所选模型的请求参数在准备期间发生变化，请重试');
      assertSameRouteSnapshot(ctx,held);
      const images=originalMessages.flatMap(message=>message.content.filter(block=>block.type==='image'));
      if (admission.state!=='disabled' && (images.some(block=>block.offloaded===true) || (images.length && !prepared.inputModalities?.includes('image')))) {
        throw new Error('所选模型无法完整接收图片；请检查图片或关闭weneed开关');
      }
      let template;
      if (includeSeed) {
        const loaded=await registry.read(options.signal,admission.sha256);
        cancel(options.signal);
        template=validateSeed(loaded?.template,DEFAULTS.maxSeedBytes);
        if (loaded?.sha256!==admission.sha256 || fingerprintSeed(template)!==admission.sha256) throw new Error('weneed开关历史样例不可用');
        const context=prepared.context?.contextWindow;
        if (context !== undefined && !withinEstimatedBudget(options,context,Buffer.byteLength(JSON.stringify(template),'utf8'))) {
          throw new Error('weneed开关的会话上下文已满');
        }
        assertSameRouteSnapshot(ctx,held);
        checkTopology();
        await store.activate(options.sessionId,admission.sha256);
        cancel(options.signal);
        assertSameRouteSnapshot(ctx,held);
        checkTopology();
      }
      const current=store.get(options.sessionId);
      if (!current || current.owner!==admission.owner || current.sha256!==admission.sha256 ||
          (includeSeed && current.state!=='active') || (!includeSeed && current.state!==admission.state)) {
        throw new Error('weneed开关在请求准备期间发生变化，请重试');
      }
      const route={provider:options.provider,model:options.model};
      const field=held?.reasoningContent?'reasoning_content':'reasoning';
      let projected;
      if (sidecarOnly) {
        const position=originalMessages.findIndex(message=>message.role==='user' && message.source?.kind==='user');
        if (position<0) throw new Error('weneed开关找不到当前用户消息');
        projected=[...originalMessages.slice(0,position),...seedMessages(template,route,field,held.api),...originalMessages.slice(position)];
      } else projected=originalMessages.flatMap(message => {
        const reference=codec.read(message,options.sessionId);
        if (!reference) return [message];
        return includeSeed ? seedMessages(template,route,field,held.api) : [];
      });
      if (held?.api==='openai-completions') {
        projected=restoreLegacyReasoning(projected,route,field);
        if (admission.state!=='disabled') projected=preserveToolImages(projected);
      }
      cancel(options.signal);
      if (options.messages!==originalMessages || !Object.isFrozen(originalMessages)) throw new Error('请求消息在准备期间发生变化');
      assertSameRouteSnapshot(ctx,held);
      checkTopology();
      const nested=Object.freeze({...options,messages:Object.freeze(projected)});
      yield* prepared.stream(nested);
    })();
  });
}

export function installSelectedAgent(ctx, agent, selection, contract, codec, store, seedIdentity, routeByAgent, topology, runtimeCtx = ctx) {
  let candidate=false;
  const stopPre=ctx.on('agent/pre-step',async (payload,next)=>{
    const decision=await next();
    if (decision.kind==='reject') return decision;
    await contract.waitPending(agent,payload.signal); cancel(payload.signal);
    const prior=agent.session.snapshotEvents().some(event=>['user/message','assistant/message','request/header'].includes(event.type));
    candidate=!prior && contract.get(agent.id).enabled;
    if (!candidate) return decision;
    if (!selection.assembled?.provider || !selection.assembled?.model) throw new Error('weneed开关无法确认所选模型');
    await store.arm(agent.id,seedIdentity.sha256,'sidecar-only'); cancel(payload.signal);
    return decision;
  },{prepend:true});
  const stopRequest=ctx.on('agent/request',async(payload,next)=>{
    const result=await contract.request(agent,payload,async()=>{
      const route=await next(); selection.recordResolved(route); return route;
    },candidate);
    if (candidate && (!result.ready || result.route?.provider!==selection.assembled?.provider || result.route?.model!==selection.assembled?.model))
      throw new Error('weneed开关的模型选择发生变化，请重试');
    const admission=store.get(agent.id);
    let snapshot;
    if (admission && ['pending','active','disabled'].includes(admission.state)) {
      // Some non-configurable routes can still continue normally once the
      // first-turn sample is no longer needed, or after the switch is off.
      // Only seed injection requires a verified compatible route snapshot.
      try { snapshot=selectedRouteSnapshot(runtimeCtx,result.route); } catch { snapshot=undefined; }
    }
    routeByAgent.set(agent,{route:result.route,snapshot,topologyRevision:topology.revision,settingsRevision:topology.settingsRevision});
    return result.route;
  },{prepend:true});
  return ()=>{stopPre();stopRequest();routeByAgent.delete(agent);};
}
