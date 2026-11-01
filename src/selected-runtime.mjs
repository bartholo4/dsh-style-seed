import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { DEFAULTS } from './base/constants.js';
import { createSeedRegistry } from './seed-registry.mjs';
import { loadOrCreateReferenceCodec } from './reference-key.mjs';
import { makeFirstTurnClassifier } from './first-turn.mjs';
import { openAdmissionStore } from './admission-store.mjs';
import { installSelectionCapture } from './selection-capture.mjs';
import { installSelectedAgent, installSelectedStream } from './selected-stream.mjs';
import { installSelectedRecovery, installSelectedOverflowRecovery } from './selected-recovery.mjs';
import { isEligibleTopLevel } from './eligibility.mjs';
import SwitchContractService from './host.mjs';

export async function applySelectedRuntime(ctx,config,gate) {
  if (!config.seedPath) throw new Error('history switch configuration incomplete');
  const registry=await createSeedRegistry(config.seedPath,config.legacySeedPaths ?? [],DEFAULTS.maxSeedBytes);
  const codec=await loadOrCreateReferenceCodec(ctx.credentials,credentialKey);
  const store=await openAdmissionStore(ctx.storageDomain);
  const firstOnly=config.firstTurnOnly ? makeFirstTurnClassifier(ctx,codec,registry.defaultIdentity.sha256) : undefined;
  const listeners=new Map(), routeByAgent=new WeakMap();
  const topology={revision:0,settingsRevision:0};
  let hostFiber,stopTopology,stopSettings;
  try {
    stopTopology=ctx.on('llm/adapters-updated',()=>{topology.revision++;});
    stopSettings=ctx.on('settings/document-updated',()=>{topology.settingsRevision++;});
    hostFiber=await ctx.plugin(SwitchContractService,{followSelected:true,admissionStore:store,
      defaultSelection:()=>ctx.agentDefaultModel.currentSelection(),
      canEdit:()=>!gate.closing,
      isManaged:agent=>listeners.get(agent?.id)?.agent===agent});
    const contract=ctx.get('switchContract')?.contract;
    if (!contract) throw new Error('history switch service unavailable');
    const stopStream=installSelectedStream(ctx,{codec,store,registry,firstOnly,routeByAgent,topology});
    const attach=agent=>{
      if (!isEligibleTopLevel(agent) || listeners.has(agent.id)) return;
      let selection,stopAgent,stopRecovery,stopOverflow;
      try {
        selection=installSelectionCapture(agent.ctx);
        stopAgent=installSelectedAgent(agent.ctx,agent,selection,contract,codec,store,registry.defaultIdentity,routeByAgent,topology,ctx);
        stopRecovery=installSelectedRecovery(agent.ctx,agent,selection,registry.read,codec,store);
        stopOverflow=installSelectedOverflowRecovery(agent.ctx,agent,registry.read,codec,store);
        listeners.set(agent.id,{agent,dispose:()=>{stopOverflow();stopRecovery();stopAgent();selection.dispose();}});
      } catch {
        stopOverflow?.();stopRecovery?.();stopAgent?.();selection?.dispose();
        ctx.logger.warn('History switch is unavailable for this session.');
      }
    };
    const stopEvents=ctx.on('session/event',()=>{if(gate.closing)gate.revision++;});
    const stopCreated=ctx.on('agent/created',({agent})=>{if(gate.closing)gate.revision++;attach(agent);});
    for (const agent of ctx.agents.list()) attach(agent);
    const stopDisposed=ctx.on('agent/disposed',({agent})=>{
      if(gate.closing)gate.revision++;
      const entry=listeners.get(agent.id);
      if(entry?.agent===agent){entry.dispose();listeners.delete(agent.id);}
    });
    ctx.effect(()=>()=>{
      stopEvents();stopCreated();stopDisposed();stopStream();stopTopology();stopSettings();
      for(const entry of listeners.values())entry.dispose();
      listeners.clear();return store.close();
    },'selected model history switch cleanup');
  } catch {
    stopTopology?.();
    stopSettings?.();
    await hostFiber?.dispose();
    await store.close();
    throw new Error('history switch initialization failed');
  }
}
