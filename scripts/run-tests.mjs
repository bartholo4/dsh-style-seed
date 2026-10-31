import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = fileURLToPath(new URL('../tests/', import.meta.url));
const tests = (await readdir(directory))
  .filter(name => name.endsWith('.test.mjs') && name !== 'lifecycle-disposal.test.mjs')
  .sort()
  .map(name => join(directory, name));
if (tests.length === 0) throw new Error('No regression tests found');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
