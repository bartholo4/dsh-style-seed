import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm';
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials';
import { PROVIDER, DEFAULTS } from './base/constants.js';
import { createSeedRegistry } from './seed-registry.mjs';
import { loadOrCreateReferenceCodec } from './reference-key.mjs';
import { createBoundComponents } from './reference-adapter.mjs';
import { makeFirstTurnClassifier } from './first-turn.mjs';
import { createSyntheticAuthority } from './authority.mjs';
import SwitchContractService from './host.mjs';
import { installSelectionCapture } from './selection-capture.mjs';
import { installSyntheticAgent, installSyntheticStream } from './integration.mjs';
import { openAdmissionStore } from './admission-store.mjs';
import { isBlankAgent, isEligibleTopLevel } from './eligibility.mjs';
import { installRecovery } from './recovery.mjs';
import { installOverflowRecovery } from './overflow-recovery.mjs';
import { applySelectedRuntime } from './selected-runtime.mjs';

// EXPERIMENTAL candidate. The package is not approved for desktop use until
// the production limitations documented in README have been resolved.
export const name = 'dsh-style-seed';
export const inject = ['llm', 'settings', 'credentials', 'typert', 'remoteAccess', 'sessions', 'agents', 'agentDefaultModel', 'storageDomain'];
export const Config = z.object({
  enabled: z.boolean().default(false),
  sourceProvider: z.string().default(''),
  model: z.string().default('deepseek-v4.1-flash'),
  baseURL: z.string().default(''),
  apiKeyEnv: z.string().role('credential-ref').default(''),
  seedPath: z.string().default(''),
  legacySeedPaths: z.array(z.string()).max(16).default([]),
  firstTurnOnly: z.boolean().default(false),
  followSelected: z.boolean().default(true),
  reasoningEffort: z.union(['max']).default('max'),
  maxOutputTokens: z.number().step(1).min(1).default(8192),
});

// Read only the non-sensitive namespace revision; never log the descriptor,
// which can contain user-supplied headers despite redactSecrets.
function getTargetRevision(ctx, provider) {
  const entries = ctx.llm.listConfigurableProviders().filter(item => item.provider === provider);
  if (entries.length !== 1) throw new Error('model configuration unavailable');
  const docs = ctx.settings.describe({ redactSecrets: true }).filter(item => item.ns === entries[0].settingsNs);
  if (docs.length !== 1 || !Number.isSafeInteger(docs[0].revision)) throw new Error('model configuration unavailable');
  return docs[0].revision;
}

async function applyRuntime(ctx, config, gate) {
  if (!config.enabled) return;
  if (config.followSelected !== false) return applySelectedRuntime(ctx,config,gate);
  if (!config.sourceProvider || !config.model || !config.baseURL || !config.apiKeyEnv || !config.seedPath ||
      !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) throw new Error('history switch configuration incomplete');
  let endpoint;
  try { endpoint = new URL(config.baseURL); } catch { throw new Error('history switch endpoint invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'd1api.xin' || endpoint.pathname !== '/v1' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.port ||
      config.model !== 'deepseek-v4.1-flash' || config.sourceProvider === PROVIDER) {
    throw new Error('history switch route is not supported');
  }
  // Load and validate before creating an internal signing record. The full
  // template is not retained by this setup closure or persisted in sessions.
  const registry = await createSeedRegistry(config.seedPath, config.legacySeedPaths ?? [], DEFAULTS.maxSeedBytes);
  const seedIdentity = registry.defaultIdentity;
  const codec = await loadOrCreateReferenceCodec(ctx.credentials, credentialKey);
  const admissionStore = await openAdmissionStore(ctx.storageDomain);
  const target = Object.freeze({ provider: config.sourceProvider, model: config.model, baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv, reasoningEffort: config.reasoningEffort, maxTokens: config.maxOutputTokens });
  const selectionByAgent = new WeakMap();
  const expected = Object.freeze({ provider: target.provider, model: target.model, baseURL: target.baseURL,
    credentialRef: target.apiKeyEnv, reasoningEffort: target.reasoningEffort });
  let hostFiber, registration, authority;
  const listeners = new Map();
  try {
    const components = createBoundComponents(ctx, target, credentialRef, {
      resolveCredential: async ref => {
        const hit = await ctx.credentials.resolve(credentialRef(ref));
        return assertUsableApiKey(hit?.value, name, ref);
      },
    }, registry.read, codec, config.firstTurnOnly ? makeFirstTurnClassifier(ctx, codec, seedIdentity.sha256) : undefined);
    authority = createSyntheticAuthority(components.verifier, target, () => getTargetRevision(ctx, target.provider));
    registration = ctx.llm.registerAdapter([PROVIDER], components.adapter);
    hostFiber = await ctx.plugin(SwitchContractService, {
      expected, authority,
      defaultSelection: () => ctx.agentDefaultModel.currentSelection(),
      currentRoute: agent => selectionByAgent.get(agent)?.currentRoute(),
      canEdit: () => !gate.closing,
      isManaged: agent => listeners.get(agent?.id)?.agent === agent,
      admissionStore,
    });
    const contract = ctx.get('switchContract')?.contract;
    if (!contract) throw new Error('history switch service unavailable');
    const stopStream = installSyntheticStream(ctx, contract, target, codec, admissionStore, components.verifier);
    const attachAgent = agent => {
      if (!isEligibleTopLevel(agent)) return;
      const old = listeners.get(agent.id);
      if (old) return; // Do not replace a different live owner with the same id.
      let selection;
      try {
        selection = installSelectionCapture(agent.ctx);
        const stopAgent = isBlankAgent(agent) ? installSyntheticAgent(agent.ctx, agent, selection, contract, target, seedIdentity, codec, admissionStore) : () => {};
        let stopRecovery, stopOverflow;
        const readSeed = registry.read;
        try {
          stopRecovery = installRecovery(agent.ctx, agent, selection, target, readSeed, codec, admissionStore);
          stopOverflow = installOverflowRecovery(agent.ctx, agent, target, readSeed, codec, admissionStore);
        } catch (error) { stopOverflow?.(); stopRecovery?.(); stopAgent(); throw error; }
        selectionByAgent.set(agent, selection);
        listeners.set(agent.id, { agent, dispose: () => { stopOverflow(); stopRecovery(); stopAgent(); selection.dispose(); selectionByAgent.delete(agent); } });
      } catch {
        selection?.dispose();
        // Do not prevent ordinary agent creation; its switch remains disabled.
        ctx.logger.warn('History switch is unavailable for this session.');
      }
    };
    const stopEvents = ctx.on('session/event', () => { if (gate.closing) gate.revision++; });
    const stopCreated = ctx.on('agent/created', ({ agent }) => { if (gate.closing) gate.revision++; attachAgent(agent); });
    // Subscribe first, then attach already-open top-level agents. The map
    // de-duplicates a creation event racing with enumeration.
    for (const agent of ctx.agents.list()) attachAgent(agent);
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
      if (gate.closing) gate.revision++;
      const entry = listeners.get(agent.id);
      if (entry?.agent === agent) { entry.dispose(); listeners.delete(agent.id); }
    });
    // A scoped effect cleanup runs on plugin fiber disposal. This addresses
    // resource cleanup only; concurrent Cordis teardown still leaves the
    // in-flight dispatch race documented as an installation blocker.
    ctx.effect(() => () => {
      stopEvents(); stopCreated(); stopDisposed(); stopStream();
      for (const entry of listeners.values()) entry.dispose();
      listeners.clear(); registration();
      return admissionStore.close();
    }, 'history switch cleanup');
  } catch (error) {
    await hostFiber?.dispose();
    registration?.();
    authority?.close();
    await admissionStore.close();
    // Do not relay errors that may contain endpoint, header or credential data.
    throw new Error('history switch initialization failed');
  }
}

// Keep all runtime effects in one child fiber. Cordis tears down unrelated
// effects concurrently, so the synchronous generator makes draining finish
// before the child and its interceptors are disposed.
export async function apply(ctx, config) {
  if (!config.enabled) return;
  const gate = { closing: false, revision: 0 };
  const runtimePlugin = { name: 'dsh-style-seed-runtime', inject,
    apply: child => applyRuntime(child, config, gate) };
  const ready = Promise.withResolvers();
  ctx.effect(function* () {
    const child = ctx.plugin(runtimePlugin);
    yield child.dispose;
    yield async () => {
      gate.closing = true;
      // Freeze switch edits, not ownership: accepted requests and queued
      // input retain their interceptors and seed while the host drains.
      // This is NOT an atomic host admission barrier. Stop all submissions
      // and shut down the service before maintenance.
      // Drain queued input rather than throwing after the AgentLoop has
      // already claimed it. A final multi-agent admission race remains open;
      // this development candidate must not be installed into daily use.
      for (;;) {
        const revision = gate.revision, agents = ctx.agents.list();
        await Promise.allSettled(agents.map(agent => agent.whenIdle()));
        const current = ctx.agents.list();
        if (revision === gate.revision && agents.length === current.length &&
            agents.every(agent => current.includes(agent)) && current.every(agent => agent.status === 'idle')) break;
      }
    };
    ready.resolve(child.await());
  }, 'history switch runtime and drain');
  await ready.promise;
}
