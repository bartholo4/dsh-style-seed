import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';

const packageUrl = new URL('../package.json', import.meta.url);

// Validate before collecting tests: a green portable suite is not host validation.
export async function validateRuntime(runtime) {
  if (!runtime || !isAbsolute(runtime)) {
    throw new Error('Full validation requires DSH_RUNTIME_NODE_MODULES set to an absolute installed DSH node_modules path. Use npm run test:portable for explicitly limited portable coverage.');
  }
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'));
  const expected = manifest.engines.dsh;
  const packages = ['@deepseek-ai/dsh', ...Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))];
  for (const name of packages) {
    let installed;
    try {
      installed = JSON.parse(await readFile(join(runtime, name, 'package.json'), 'utf8'));
    } catch (cause) {
      throw new Error(`Full validation requires installed ${name}@${expected} in ${runtime}`, { cause });
    }
    if (installed.name !== name || installed.version !== expected) {
      throw new Error(`Unsupported host: ${name} must be ${expected}; found ${installed.name}@${installed.version}`);
    }
  }
  return expected;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--portable') || args.length > 1) throw new Error('Usage: node scripts/run-tests.mjs [--portable]');
  const portable = args.includes('--portable');
  const env = { ...process.env };
  if (portable) {
    delete env.DSH_RUNTIME_NODE_MODULES;
    console.log('PORTABLE ONLY: host integration checks are intentionally skipped; this is not full validation.');
  } else {
    const version = await validateRuntime(env.DSH_RUNTIME_NODE_MODULES);
    console.log(`FULL VALIDATION: installed DSH ${version}; skipped tests are failures.`);
  }
  const directory = fileURLToPath(new URL('../tests/', import.meta.url));
  const tests = (await readdir(directory))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join(directory, name));
  if (tests.length === 0) throw new Error('No regression tests found');
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
    env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const skipped = result.stdout.match(/^# skipped (\d+)$/m);
  if (!portable && (!skipped || Number(skipped[1]) !== 0)) {
    throw new Error('Full validation requires a complete test summary with zero skipped tests.');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
