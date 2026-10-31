import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSeed } from '../src/base/seed.js';

test('the published example is a valid seed containing assistant reasoning', async () => {
  const bytes = await readFile(new URL('../examples/we-need-seed.json', import.meta.url), 'utf8');
  const seed = validateSeed(JSON.parse(bytes));
  assert.ok(seed.messages.some(message => message.role === 'assistant' && message.reasoning?.trim()));
});
