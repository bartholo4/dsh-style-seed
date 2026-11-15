import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withinEstimatedBudget } from '../src/budget.mjs';

test('budget preflight rejects invalid parameters and malformed message structures', () => {
  const valid = { maxTokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
  assert.equal(withinEstimatedBudget(undefined, 65536, 4096), false);
  assert.equal(withinEstimatedBudget(valid, 0, 4096), false);
  assert.equal(withinEstimatedBudget(valid, -1, 4096), false);
  assert.equal(withinEstimatedBudget(valid, 65536, -1), false);
  assert.equal(withinEstimatedBudget({ ...valid, maxTokens: 0 }, 65536, 4096), false);
  assert.equal(withinEstimatedBudget({ ...valid, maxTokens: undefined }, 65536, 4096), false);
  assert.equal(withinEstimatedBudget({ ...valid, tools: 'not-array' }, 65536, 4096), false);
  assert.equal(withinEstimatedBudget({ ...valid, messages: [{ role: 'user', content: 'not-array' }] }, 65536, 4096), false);
});

test('multi-step tool turn with large reasoning history, binary/base64 screenshots, and high maxTokens stays within 1M budget', () => {
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the dashboard and verify all filters.' }] }];
  const screenshotBytes = new Uint8Array(220_000);
  const screenshotBase64 = Buffer.alloc(180_000, 7).toString('base64');
  for (let step = 0; step < 25; step++) {
    messages.push({
      role: 'assistant',
      source: { provider: 'synthetic', model: 'synthetic-model', replayState: { raw: 'x'.repeat(8_000) } },
      content: [
        { type: 'reasoning', text: 'We need to inspect step details carefully. '.repeat(390) },
        { type: 'tool-call', id: `call_${step}`, name: 'browser_step', input: { step, selector: '#app .panel-row' } },
      ],
    });
    const hasShot = step === 17 || step === 21 || step === 23;
    messages.push({
      role: 'tool',
      toolCallId: `call_${step}`,
      content: hasShot
        ? [
            { type: 'text', text: `Captured viewport screenshot for step ${step}.` },
            { type: 'image', data: screenshotBytes, url: `data:image/png;base64,${screenshotBase64}` },
          ]
        : [{ type: 'text', text: 'DOM snapshot row summary '.repeat(60) }],
    });
  }
  const tools = Array.from({ length: 30 }, (_, index) => ({
    name: `synthetic_tool_${index}`,
    description: 'Synthetic tool schema description for preflight budget testing. '.repeat(12),
    parameters: { type: 'object', properties: { target: { type: 'string' }, limit: { type: 'number' } } },
  }));
  const options = {
    maxTokens: 256_000,
    system: 'Synthetic system instructions. '.repeat(300),
    tools,
    messages,
  };
  assert.equal(withinEstimatedBudget(options, 1_000_000, 12_000), true);
});

test('models configured with maxTokens equal to contextWindow allow normal seeded turns while rejecting genuinely full contexts', () => {
  const normal = {
    maxTokens: 131_072,
    system: 'System prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize the design constraints.' }] }],
  };
  assert.equal(withinEstimatedBudget(normal, 131_072, 12_000), true);
  assert.equal(withinEstimatedBudget({ ...normal, maxTokens: 65_536 }, 65_536, 12_000), true);

  const overfull = {
    maxTokens: 32_768,
    system: 'System prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(350_000) }] }],
  };
  assert.equal(withinEstimatedBudget(overfull, 131_072, 12_000), false);
});
