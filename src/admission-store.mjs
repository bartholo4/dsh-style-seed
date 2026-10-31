import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

// Independent, durable evidence that a session was deliberately armed. It
// contains no template, credential, key, source path or private reasoning.
// Keep the original domain readable by experimental.12; newer states never
// go into this domain. The identity fields contain no route or template data.
const identity = {
  owner: z.string().min(1).max(256),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
};
const admission = z.object({
  ...identity,
  state: z.enum(['pending', 'active', 'skipped']),
}).strict();
export const admissionSpec = defineDomain({ name: 'style_seed_admission', version: 1,
  tables: { sessions: domainTable(admission) } });
const nextAdmission = z.union([
  z.object({ ...identity, state: z.enum(['pending', 'active', 'disabled']), mode: z.literal('sidecar-only') }).strict(),
  // Legacy sessions keep their old record; only the disabling overlay is new.
  // Older readers ignore this overlay, so downgrade requires an explicit migration gate.
  z.object({ ...identity, state: z.literal('disabled') }).strict(),
]);
export const admissionV2Spec = defineDomain({ name: 'style_seed_admission_v2', version: 1,
  tables: { sessions: domainTable(nextAdmission) } });
class AdmissionIdentityError extends Error {}

export async function openAdmissionStore(facility) {
  const legacyDomain = await facility.open(admissionSpec);
  let nextDomain;
  try { nextDomain = await facility.open(admissionV2Spec); }
  catch (error) {
    try { await legacyDomain.close(); }
    catch (closeError) { throw new AggregateError([error, closeError], 'admission store open and cleanup failed'); }
    throw error;
  }
  const legacyTable = legacyDomain.table('sessions'), nextTable = nextDomain.table('sessions');
  const locks = new Map(); let closed = false, closePromise;
  const serial = (id, task) => {
    if (closed) return Promise.reject(new Error('admission store closed'));
    const previous = locks.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => { if (closed) throw new Error('admission store closed'); return task(); });
    locks.set(id, work);
    work.finally(() => { if (locks.get(id) === work) locks.delete(id); }).catch(() => {});
    return work;
  };
  const check = (id, sha) => {
    if (typeof id !== 'string' || !id || id.length > 256 || typeof sha !== 'string' || !/^[0-9a-f]{64}$/u.test(sha)) throw new Error('invalid admission identity');
  };
  const read = id => {
    const legacy = legacyTable.get(id), next = nextTable.get(id);
    if ((legacy && legacy.owner !== id) || (next && next.owner !== id) ||
        (legacy && next && (legacy.owner !== next.owner || legacy.sha256 !== next.sha256 ||
          next.mode !== undefined || next.state !== 'disabled'))) {
      throw new AdmissionIdentityError('admission identity changed');
    }
    return { legacy, next, record: next ?? legacy };
  };
  const readExisting = (id, message) => {
    try { return read(id); }
    catch (error) { if (error instanceof AdmissionIdentityError) throw new Error(message); throw error; }
  };
  return Object.freeze({
    get(id) { if (closed) throw new Error('admission store closed'); return read(id).record; },
    arm(id, sha, mode) {
      check(id, sha);
      if (mode !== undefined && mode !== 'sidecar-only') throw new Error('invalid admission mode');
      return serial(id, async () => {
        const old = read(id).record;
        if (old) {
          if (old.owner !== id || old.sha256 !== sha) throw new Error('admission identity changed');
          if (old.state === 'disabled') throw new Error('admission is disabled');
          if (old.mode !== mode) throw new Error('admission mode changed');
          return old;
        }
        const record = { owner: id, sha256: sha, state: 'pending', ...(mode === undefined ? {} : { mode }) };
        await (mode === 'sidecar-only' ? nextTable : legacyTable).put(id, record); return record;
      });
    },
    skip(id, sha) { check(id, sha); return serial(id, async () => {
      const old = read(id).record;
      if (old && (old.owner !== id || old.sha256 !== sha)) throw new Error('admission identity changed');
      if (old?.state === 'disabled') throw new Error('admission is disabled');
      if (old?.mode !== undefined) throw new Error('admission mode changed');
      if (old && old.state !== 'skipped') throw new Error('admission identity changed');
      if (old) return old;
      const record = { owner: id, sha256: sha, state: 'skipped' };
      await legacyTable.put(id, record); return record;
    }); },
    activate(id, sha) { check(id, sha); return serial(id, async () => {
      const old = readExisting(id, 'admission missing or changed').record;
      if (!old || old.owner !== id || old.sha256 !== sha) throw new Error('admission missing or changed');
      if (old.state === 'disabled') throw new Error('admission is disabled');
      if (old.state === 'active') return old;
      const record = { ...old, state: 'active' };
      await (old.mode === 'sidecar-only' ? nextTable : legacyTable).put(id, record); return record;
    }); },
    disable(id, sha) { check(id, sha); return serial(id, async () => {
      const old = readExisting(id, 'admission missing or changed').record;
      if (!old || old.owner !== id || old.sha256 !== sha) throw new Error('admission missing or changed');
      if (old.state === 'disabled') return old;
      const record = { ...old, state: 'disabled' }; await nextTable.put(id, record); return record;
    }); },
    // Call only when the host has established that no carrier was committed;
    // active records cannot be silently cleared by this operation.
    abandonPending(id, sha) { check(id, sha); return serial(id, async () => {
      const { legacy, next, record: old } = readExisting(id, 'pending admission cannot be abandoned');
      if (!old) return false;
      if (old.owner !== id || old.sha256 !== sha || !['pending', 'skipped'].includes(old.state) || (legacy && next)) {
        throw new Error('pending admission cannot be abandoned');
      }
      await (next ? nextTable : legacyTable).delete(id); return true;
    }); },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...locks.values()]);
        const results = await Promise.allSettled([
          Promise.resolve().then(() => legacyDomain.close()), Promise.resolve().then(() => nextDomain.close()),
        ]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'admission store close failed');
      })();
      return closePromise;
    },
  });
}
