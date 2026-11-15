import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRuntime } from '../scripts/run-tests.mjs';

test('full gate rejects absent and relative host paths', async () => {
  await assert.rejects(validateRuntime(undefined), /requires DSH_RUNTIME_NODE_MODULES/);
  await assert.rejects(validateRuntime('node_modules'), /absolute installed DSH/);
});

test('full gate rejects missing, unsupported and mixed host installations before tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-gate-'));
  try {
    await assert.rejects(validateRuntime(root), /requires installed @deepseek-ai\/dsh@/);
    const dir = join(root, '@deepseek-ai/dsh');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-alpha.1' }));
    await assert.rejects(validateRuntime(root), /Unsupported host.*found @deepseek-ai\/dsh@0.2.2-alpha.1/);
    for (const version of ['0.2.2-alpha.2', '0.2.2-rc.3']) {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
      await assert.rejects(validateRuntime(root), /requires installed @deepseek-ai\/dsh-attachment/);
    }
    const attDir = join(root, '@deepseek-ai/dsh-attachment');
    await mkdir(attDir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.3' }));
    await writeFile(join(attDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-attachment', version: '0.2.2-alpha.2' }));
    await assert.rejects(validateRuntime(root), /Mixed host versions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
