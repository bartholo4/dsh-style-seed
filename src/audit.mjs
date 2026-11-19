// Opt-in privacy-safe diagnostic audit logger (default off). Writes metadata
// decisions only (no prompt text, no reasoning text, no seed text, no secrets)
// under the active DSH_HOME storages directory. Best-effort: never throws.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const AUDIT_FILENAME = 'dsh-style-seed-audit.jsonl';

export function resolveAuditPath(env = process.env, home = homedir()) {
  const rawHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim()
    ? env.DSH_HOME.trim()
    : join(home, '.dsh');
  return join(rawHome, 'storages', AUDIT_FILENAME);
}

const ALLOWED_FIELDS = [
  'event', 'reason', 'sessionId', 'inheritedFrom', 'provider', 'model', 'api',
  'field', 'placement', 'keepPrefix', 'includeSeed', 'afterCompaction',
  'messageCount', 'estimatedTokens', 'contextWindow', 'errorCode',
];

export function createAuditLogger({ enabled = false, version = '0.2.0-experimental.17', filePath } = {}) {
  if (!enabled) return Object.freeze({ enabled: false, record() {} });
  const target = typeof filePath === 'string' && filePath.trim() ? filePath.trim() : resolveAuditPath();
  let dirReady = false;
  return Object.freeze({
    enabled: true,
    path: target,
    record(entry) {
      try {
        if (!dirReady) {
          mkdirSync(dirname(target), { recursive: true });
          dirReady = true;
        }
        const safe = { at: new Date().toISOString(), v: version };
        if (entry && typeof entry === 'object') {
          for (const key of ALLOWED_FIELDS) {
            const value = entry[key];
            if (value !== undefined && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) {
              safe[key] = value;
            }
          }
        }
        appendFileSync(target, `${JSON.stringify(safe)}\n`, 'utf8');
      } catch {
        // Best-effort diagnostics must never interfere with model requests.
      }
    },
  });
}
