import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runtime = process.env.DSH_RUNTIME_NODE_MODULES;
const host = fileURLToPath(new URL('./selected-restart-host.mjs', import.meta.url));
const sample = { schemaVersion: 1, id: 'synthetic', provenance: {}, messages: [
  { role: 'user', content: 'synthetic-seed-user' },
  { role: 'assistant', content: 'synthetic-seed-answer', reasoning: 'synthetic-seed-reasoning', source: { provider: 'synthetic-origin', model: 'synthetic-origin' } },
] };

async function runModes(modes) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-selected-restart-'));
  try {
    await writeFile(join(directory, 'synthetic-seed.json'), JSON.stringify(sample), 'utf8');
    // Explicit profile/temporary roots and a minimal environment prevent use of
    // the real user's configuration, account, and sessions in child processes.
    const env = { DSH_RUNTIME_NODE_MODULES: runtime, SYSTEMROOT: process.env.SYSTEMROOT ?? '', PATH: process.env.PATH ?? '',
      HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, DSH_HOME: directory, TEMP: directory, TMP: directory };
    const results = [];
    for (const mode of modes) {
      const run = spawnSync(process.execPath, [host, mode, directory], { cwd: directory, env, encoding: 'utf8', timeout: 12000 });
      assert.equal(run.status, 0, `synthetic ${mode} failed: ${run.stderr || run.error?.message || 'unknown'}`);
      const result = JSON.parse(run.stdout);
      assert.equal(result.mode, mode);
      assert.equal(result.status, 'ok');
      assert.equal(result.carrierCount, 0);
      assert.equal(result.calls, 1);
      assert.equal(result.networkAttempts, 0);
      results.push(result);
    }
    return results;
  } finally {
    // Only remove the fresh fixture after verifying its resolved absolute path.
    const target = await realpath(directory), parent = await realpath(tmpdir());
    if (dirname(resolve(target)).toLowerCase() !== resolve(parent).toLowerCase() || !basename(target).startsWith('dsh-selected-restart-')) {
      throw new Error('Refusing to remove unexpected synthetic fixture path');
    }
    await rm(target, { recursive: true, force: true });
  }
}

test('sidecar-only first turn, close, and other-provider continuation survive three process restarts', { timeout: 45000, skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to the DSH 0.2.2-alpha.2 node_modules directory' }, async () => {
  assert.equal((await runModes(['create', 'resume-disable', 'resume-other'])).length, 3);
});

test('unsupported first request can be disabled and the disabled state survives restart', { timeout: 30000, skip: !runtime && 'Set DSH_RUNTIME_NODE_MODULES to the DSH 0.2.2-alpha.2 node_modules directory' }, async () => {
  assert.equal((await runModes(['failed-create', 'failed-resume'])).length, 2);
});


