import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWireRequest } from '../src/base/wire.js';
import { DEFAULTS } from '../src/base/constants.js';
import { fingerprintSeed, seedCarrierSource, validateSeed } from '../src/base/seed.js';

const image = (id, extra = {}) => ({ type: 'image', attachment: { attachmentId: id }, ...extra });
const text = value => ({ type: 'text', text: value });
const source = (mime, bytes, handleText) => ({ data: new Uint8Array(bytes), mediaType: mime,
  ...(handleText === undefined ? {} : { handleText }) });
const input = messages => ({ model: DEFAULTS.model, messages });
const url = (mime, base64) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
const header = { type: 'text', text: 'Attached image(s) from tool result:' };

// Text requests retain their exact historical fields and grouping whether or
// not a caller passes an empty version map.
test('text-only request remains field-for-field compatible', () => {
  const options = {
    model: DEFAULTS.model, system: 'system', reasoningEffort: 'high', maxTokens: 240,
    temperature: 0.25, stop: ['end'],
    tools: [
      { name: 'read', description: 'read text', parameters: { type: 'object' } },
      { name: 'deferred', deferLoading: true, parameters: {} },
    ],
    messages: [
      { role: 'developer', content: [text('dev'), text(' instructions')] },
      { role: 'user', content: [text('question'), text('?')] },
      { role: 'assistant', content: [text('reply'), { type: 'reasoning', text: 'reason' },
        { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: [text('tool'), text(' result')] },
      { role: 'tool', toolCallId: 'b', content: [] },
      { role: 'user', content: [text('')] },
    ],
  };
  const expected = {
    model: DEFAULTS.model,
    messages: [
      { role: 'system', content: 'system' },
      { role: 'system', content: 'dev instructions' },
      { role: 'user', content: 'question?' },
      { role: 'assistant', content: 'reply', reasoning_content: 'reason',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'tool result' },
      { role: 'tool', tool_call_id: 'b', content: '' },
    ],
    stream: true, stream_options: { include_usage: true }, store: false,
    tools: [{ type: 'function', function: { name: 'read', description: 'read text', parameters: { type: 'object' } } }],
    reasoning_effort: 'high', temperature: 0.25, max_completion_tokens: 240, stop: ['end'],
  };
  assert.deepEqual(buildWireRequest(options), expected);
  assert.deepEqual(buildWireRequest(options, {}, new Map()), expected);
});

test('mixed user text and multiple images retain order and per-image handles', () => {
  const versions = new Map([
    ['one', source('image/png', [1, 2], 'PNG handle')],
    ['two', { data: Buffer.from([3, 4]), mediaType: 'image/jpeg' }],
  ]);
  const options = input([{ role: 'user', content: [text('before'), image('one'), text('between'), image('two'), text('after')] }]);
  const before = structuredClone(options);
  const request = buildWireRequest(options, {}, versions);
  assert.deepEqual(request.messages, [{ role: 'user', content: [
    text('before'), text('PNG handle'), url('image/png', 'AQI='), text('between'),
    url('image/jpeg', 'AwQ='), text('after'),
  ] }]);
  assert.deepEqual(options, before);
  assert.deepEqual([...versions.get('one').data], [1, 2]);
});

test('consecutive tool results retain call IDs and text before their combined images', () => {
  const versions = new Map([
    ['a', source('image/png', [1], 'A handle')],
    ['b', source('image/gif', [2])],
    ['c', source('image/webp', [3], 'C handle')],
  ]);
  const messages = [
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'call-a', name: 'read_image', arguments: '{}' },
      { type: 'tool-call', id: 'call-b', name: 'read_image', arguments: '{}' },
      { type: 'tool-call', id: 'call-c', name: 'read', arguments: '{}' },
    ] },
    { role: 'tool', toolCallId: 'call-a', content: [text('first'), image('a'), text(' tail')] },
    { role: 'tool', toolCallId: 'call-b', content: [text('second'), image('b')] },
    { role: 'tool', toolCallId: 'call-c', content: [text('third')] },
    { role: 'assistant', content: [text('next'), { type: 'tool-call', id: 'call-d', name: 'read_image', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call-d', content: [image('c')] },
    { role: 'user', content: [text('continue')] },
  ];
  const actual = buildWireRequest(input(messages), {}, versions).messages;
  assert.deepEqual(actual.slice(1, 5), [
    { role: 'tool', tool_call_id: 'call-a', content: 'first tail' },
    { role: 'tool', tool_call_id: 'call-b', content: 'second' },
    { role: 'tool', tool_call_id: 'call-c', content: 'third' },
    { role: 'user', content: [header, text('Image(s) returned by tool call "call-a":'), text('first'), text('A handle'), url('image/png', 'AQ=='), text(' tail'),
      text('Image(s) returned by tool call "call-b":'), text('second'), url('image/gif', 'Ag==')] },
  ]);
  assert.equal(actual[5].role, 'assistant');
  assert.deepEqual(actual.slice(6), [
    { role: 'tool', tool_call_id: 'call-d', content: '(see attached image)' },
    { role: 'user', content: [header, text('Image(s) returned by tool call "call-d":'), text('C handle'), url('image/webp', 'Aw==')] },
    { role: 'user', content: 'continue' },
  ]);
});

test('tool images at the end of history are flushed after the tool message', () => {
  const messages = [{ role: 'tool', toolCallId: 'last', content: [text('last result'), image('x')] }];
  assert.deepEqual(buildWireRequest(input(messages), {}, new Map([['x', source('image/png', [1])]])).messages, [
    { role: 'tool', tool_call_id: 'last', content: 'last result' },
    { role: 'user', content: [header, text('Image(s) returned by tool call "last":'), text('last result'), url('image/png', 'AQ==')] },
  ]);
});

test('tool-result text stays interleaved with its images for interpretation', () => {
  const versions = new Map([['a',source('image/png',[1])],['b',source('image/png',[2])]]);
  const messages = [{role:'tool',toolCallId:'call',content:[text('cat:'),image('a'),text('dog:'),image('b')]}];
  assert.deepEqual(buildWireRequest(input(messages),{},versions).messages.at(-1).content, [
    header,text('Image(s) returned by tool call "call":'),text('cat:'),url('image/png','AQ=='),text('dog:'),url('image/png','Ag=='),
  ]);
});

test('parallel tool images remain attributable to the producing call', () => {
  const make = owner => [
    {role:'tool',toolCallId:'call-a',content:[text('done'),...(owner === 'a' ? [image('x')] : [])]},
    {role:'tool',toolCallId:'call-b',content:[text('done'),...(owner === 'b' ? [image('x')] : [])]},
  ];
  const versions = new Map([['x', source('image/png', [1])]]);
  const a=buildWireRequest(input(make('a')),{},versions).messages;
  const b=buildWireRequest(input(make('b')),{},versions).messages;
  assert.notDeepEqual(a,b);
  assert.ok(a.at(-1).content.some(block=>block.text==='Image(s) returned by tool call "call-a":'));
  assert.ok(b.at(-1).content.some(block=>block.text==='Image(s) returned by tool call "call-b":'));
});

test('historical and repeated image occurrences are retained', () => {
  const data = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
  const versions = new Map([['old', { data, mediaType: 'image/png' }]]);
  const messages = [
    { role: 'user', content: [text('earlier'), image('old')] },
    { role: 'assistant', content: [text('acknowledged')] },
    { role: 'user', content: [image('old'), text('now')] },
  ];
  assert.deepEqual(buildWireRequest(input(messages), {}, versions).messages, [
    { role: 'user', content: [text('earlier'), url('image/png', 'AQI=')] },
    { role: 'assistant', content: 'acknowledged' },
    { role: 'user', content: [url('image/png', 'AQI='), text('now')] },
  ]);
});

const png = new Map([['x', source('image/png', [1])]]);
const rejectionCases = [
  ['missing version map', { role: 'user', content: [image('x')] }, undefined],
  ['missing version entry', { role: 'user', content: [image('x')] }, new Map()],
  ['missing attachment reference', { role: 'user', content: [{ type: 'image' }] }, png],
  ['offloaded image despite available version', { role: 'tool', toolCallId: 'a', content: [image('x', { offloaded: true })] }, png],
  ['unsupported image MIME', { role: 'user', content: [image('x')] }, new Map([['x', source('image/svg+xml', [1])]])],
  ['missing image bytes', { role: 'user', content: [image('x')] }, new Map([['x', { mediaType: 'image/png' }]])],
  ['empty image bytes', { role: 'user', content: [image('x')] }, new Map([['x', source('image/png', [])]])],
  ['invalid handle text', { role: 'user', content: [image('x')] }, new Map([['x', { ...source('image/png', [1]), handleText: 5 }]])],
  ['assistant image', { role: 'assistant', content: [image('x')] }, png],
  ['system image', { role: 'system', content: [image('x')] }, png],
  ['developer image', { role: 'developer', content: [image('x')] }, png],
  ['unknown role image', { role: 'other', content: [image('x')] }, png],
  ['user file next to image', { role: 'user', content: [image('x'), { type: 'file' }] }, png],
  ['tool file next to image', { role: 'tool', toolCallId: 'a', content: [{ type: 'file' }, image('x')] }, png],
];
for (const [label, message, versions] of rejectionCases) {
  test(`rejects ${label}`, () => {
    assert.throws(() => buildWireRequest(input([message]), {}, versions),
      error => error.name === 'SeedError' && error.code === 'UNSUPPORTED_CONTENT');
  });
}

test('carrier expansion never silently discards an image on its display marker', () => {
  const template = validateSeed({ schemaVersion: 1, id: 'synthetic', provenance: {}, messages: [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer', source: { provider: 'synthetic', model: 'synthetic' } },
  ] });
  const carrier = seedCarrierSource({ template, sha256: fingerprintSeed(template) }, 'session', '2026-01-01T00:00:00Z');
  const message = { role: 'user', source: carrier, content: [text('marker'), image('x')] };
  assert.throws(() => buildWireRequest(input([message]), {}, png),
    error => error.name === 'SeedError' && error.code === 'UNSUPPORTED_CONTENT');
});
