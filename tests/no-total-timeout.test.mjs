import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {streamCompletion} from '../src/base/stream.js';

const encoder = new TextEncoder();
const settle = () => new Promise(resolve => setImmediate(resolve));

function source() {
  let writer, signal;
  const body = new ReadableStream({start(controller) {writer = controller;}});
  const fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(body, {headers: {'content-type': 'text/event-stream'}});
  };
  return {fetch, send: text => writer.enqueue(encoder.encode(text)), end: () => writer.close(),
    get signal() {return signal;}};
}

test('continuous data can run beyond the old 120-second total deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const stream = source();
  const iterator = streamCompletion({model: 'synthetic', messages: []}, {}, {fetch: stream.fetch});
  const first = iterator.next();
  await settle();
  assert.ok(stream.signal);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(45_000);
    assert.equal(stream.signal.aborted, false, `unexpected abort at ${(i + 1) * 45} seconds`);
    stream.send(': keep-alive\n\n');
    await settle();
  }
  stream.send('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  stream.end();
  const chunks = [await first];
  for await (const chunk of iterator) chunks.push({value: chunk, done: false});
  assert.ok(chunks.some(chunk => chunk.value?.type === 'finish'));
  assert.ok(chunks.some(chunk => chunk.value?.type === 'text-delta' && chunk.value.text === 'ok'));
});

test('an actually silent stream still gets the separate idle timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const stream = source();
  const iterator = streamCompletion({model: 'synthetic', messages: []}, {}, {fetch: stream.fetch});
  const next = iterator.next();
  await settle();
  t.mock.timers.tick(60_001);
  assert.equal(stream.signal.aborted, true);
  stream.send('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n');
  await assert.rejects(next, {message: 'History provider idle timeout', code: 'TIMEOUT'});
});

test('explicit user cancellation still aborts a running stream', async () => {
  const stream = source(), controller = new AbortController();
  const iterator = streamCompletion({model: 'synthetic', messages: []}, {}, {fetch: stream.fetch, signal: controller.signal});
  const next = iterator.next();
  await settle();
  controller.abort();
  assert.equal(stream.signal.aborted, true);
  stream.send('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\n\n');
  await assert.rejects(next, {message: 'History provider request was cancelled', code: 'ABORTED'});
});
