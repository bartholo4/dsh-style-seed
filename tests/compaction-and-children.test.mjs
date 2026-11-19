import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_SOURCE_KINDS,
  isCompactionCheckpointMessage,
  isCompactionBoundaryEvent,
  isContextUserMessage,
  isTaskUserMessage,
  findSeedInsertionIndex,
  sidecarNeedsSeed,
  sidecarFirstReplyCompleted,
} from '../src/message-kind.mjs';
import { isEligibleTopLevel, isInheritableChild, findInheritedParentAdmission } from '../src/eligibility.mjs';
import { createAuditLogger, resolveAuditPath, AUDIT_FILENAME } from '../src/audit.mjs';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

test('message-kind distinguishes DSH context kinds, goal/schedule tasks, and compaction checkpoints', () => {
  const mk = (kind, text = 'hello', role = 'user') => ({
    role,
    source: kind === undefined ? undefined : { kind },
    content: [{ type: 'text', text }],
  });

  assert.equal(isTaskUserMessage(mk('user')), true);
  assert.equal(isTaskUserMessage(mk('goal')), true);
  assert.equal(isTaskUserMessage(mk('schedule')), true);
  assert.equal(isTaskUserMessage(mk('tool-goal')), true);
  assert.equal(isTaskUserMessage(mk(undefined, 'legacy plain task')), true);

  for (const kind of CONTEXT_SOURCE_KINDS) {
    assert.equal(isTaskUserMessage(mk(kind)), false, `${kind} must not be classified as task`);
    assert.equal(isContextUserMessage(mk(kind)), true, `${kind} must be classified as context`);
  }

  const checkpointByKind = mk('compact-checkpoint', 'summary body');
  const checkpointByTag = mk(undefined, '<compacted-summary>prior span</compacted-summary>');
  assert.equal(isCompactionCheckpointMessage(checkpointByKind), true);
  assert.equal(isCompactionCheckpointMessage(checkpointByTag), true);
  assert.equal(isTaskUserMessage(checkpointByKind), false);
  assert.equal(isTaskUserMessage(checkpointByTag), false);

  assert.equal(isCompactionBoundaryEvent({ type: 'compaction/summary', data: {} }), true);
  assert.equal(isCompactionBoundaryEvent({ type: 'user/message', data: checkpointByKind }), true);
  assert.equal(isCompactionBoundaryEvent({ type: 'user/message', data: mk('user') }), false);
});

test('findSeedInsertionIndex handles goal first turn and post-compaction placement', () => {
  const ctxMsg = kind => ({ role: 'user', source: { kind }, content: [{ type: 'text', text: kind }] });
  const taskMsg = (kind, text) => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] });

  const goalMessages = [ctxMsg('runtime-context'), ctxMsg('skill-catalog'), taskMsg('goal', 'finish milestone')];
  assert.equal(findSeedInsertionIndex(goalMessages), 2);

  const postCompactMessages = [
    ctxMsg('runtime-context'),
    ctxMsg('compact-checkpoint'),
    ctxMsg('time-context'),
    taskMsg('user', 'continue after compact'),
  ];
  assert.equal(findSeedInsertionIndex(postCompactMessages, { afterLastCompaction: true }), 3);

  const checkpointOnly = [ctxMsg('runtime-context'), ctxMsg('compact-checkpoint'), ctxMsg('time-context')];
  assert.equal(findSeedInsertionIndex(checkpointOnly, { afterLastCompaction: true }), -1);
});

test('sidecarNeedsSeed resets after compaction boundary and respects reseedAfterCompaction flag', () => {
  const completedTurn = (turn, kind = 'user') => [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { role: 'user', source: { kind }, content: [{ type: 'text', text: `q-${turn}` }] } },
    { type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: `a-${turn}` }] } } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ];

  // Empty or in-progress tool step still needs seed
  assert.deepEqual(sidecarNeedsSeed([]), { needed: true, afterCompaction: false });
  const toolOnly = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'g1' }] } },
    { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } } },
  ];
  assert.deepEqual(sidecarNeedsSeed(toolOnly), { needed: true, afterCompaction: false });

  // Completed goal turn marks initial cycle complete
  const afterGoal = completedTurn(1, 'goal');
  assert.deepEqual(sidecarNeedsSeed(afterGoal), { needed: false, afterCompaction: false });
  assert.equal(sidecarFirstReplyCompleted(afterGoal), true);

  // Compaction boundary resets seed requirement for the next cycle
  const afterCompaction = [
    ...afterGoal,
    { type: 'compaction/summary', data: { compactionId: 'cmp-1' } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '<compacted-summary>s</compacted-summary>' }] } },
  ];
  assert.deepEqual(sidecarNeedsSeed(afterCompaction, { reseedAfterCompaction: true }), { needed: true, afterCompaction: true });
  assert.deepEqual(sidecarNeedsSeed(afterCompaction, { reseedAfterCompaction: false }), { needed: false, afterCompaction: false });
  assert.equal(sidecarFirstReplyCompleted(afterCompaction), true);

  // Completing the first post-compaction turn stops re-seeding again
  const afterPostCompactReply = [...afterCompaction, ...completedTurn(2, 'user')];
  assert.deepEqual(sidecarNeedsSeed(afterPostCompactReply, { reseedAfterCompaction: true }), { needed: false, afterCompaction: true });
});

test('eligibility distinguishes top-level vs inheritable child and walks ancestor admission safely', () => {
  const sha = 'a'.repeat(64);
  const top = { id: 'root-1', session: { id: 'root-1', header: { isSeeded: false, delegationDepth: 0 } } };
  const child = { id: 'sub-1', session: { id: 'sub-1', header: { isSeeded: false, parentSession: 'root-1', delegationDepth: 1, origin: 'subagent' } } };
  const grandChild = { id: 'sub-2', session: { id: 'sub-2', header: { isSeeded: false, parentSession: 'sub-1', delegationDepth: 2, origin: 'subagent' } } };
  const seededChild = { id: 'sub-seeded', session: { id: 'sub-seeded', header: { isSeeded: true, parentSession: 'root-1', delegationDepth: 1, origin: 'subagent' } } };
  const cyclicA = { id: 'cyc-a', session: { id: 'cyc-a', header: { isSeeded: false, parentSession: 'cyc-b', delegationDepth: 1, origin: 'subagent' } } };
  const cyclicB = { id: 'cyc-b', session: { id: 'cyc-b', header: { isSeeded: false, parentSession: 'cyc-a', delegationDepth: 1, origin: 'subagent' } } };

  assert.equal(isEligibleTopLevel(top), true);
  assert.equal(isInheritableChild(top), false);
  assert.equal(isEligibleTopLevel(child), false);
  assert.equal(isInheritableChild(child), true);
  assert.equal(isInheritableChild(seededChild), false);

  const agents = new Map([top, child, grandChild, cyclicA, cyclicB].map(a => [a.id, a]));
  const ctx = { agents };
  const records = new Map([['root-1', { owner: 'root-1', sha256: sha, state: 'active', mode: 'sidecar-only' }]]);
  const store = { get: id => records.get(id) };

  const direct = findInheritedParentAdmission(ctx, child, store);
  assert.equal(direct?.parentSessionId, 'root-1');
  assert.equal(direct?.admission?.sha256, sha);

  const nested = findInheritedParentAdmission(ctx, grandChild, store);
  assert.equal(nested?.parentSessionId, 'root-1');

  // Cycle terminates cleanly without throwing
  assert.equal(findInheritedParentAdmission(ctx, cyclicA, store), undefined);

  // Disabled parent blocks inheritance
  records.set('root-1', { owner: 'root-1', sha256: sha, state: 'disabled', mode: 'sidecar-only' });
  assert.equal(findInheritedParentAdmission(ctx, child, store), undefined);

  // Unarmed parent blocks inheritance
  records.clear();
  assert.equal(findInheritedParentAdmission(ctx, child, store), undefined);
});

test('audit logger respects DSH_HOME, defaults off, strips disallowed fields, and never throws', () => {
  assert.equal(resolveAuditPath({ DSH_HOME: '/custom/dsh-data' }, '/ignored-home'), join('/custom/dsh-data', 'storages', AUDIT_FILENAME));
  assert.equal(resolveAuditPath({}, '/fallback-home'), join('/fallback-home', '.dsh', 'storages', AUDIT_FILENAME));

  const noop = createAuditLogger({ enabled: false });
  assert.equal(noop.enabled, false);
  noop.record({ event: 'inject' });

  const dir = mkdtempSync(join(tmpdir(), 'dsh-style-seed-audit-'));
  try {
    const filePath = join(dir, 'nested', AUDIT_FILENAME);
    const logger = createAuditLogger({ enabled: true, filePath, version: '0.2.0-experimental.16' });
    logger.record({
      event: 'inject',
      reason: 'first-turn',
      sessionId: 'session-test',
      provider: 'synthetic-a',
      model: 'model-a',
      includeSeed: true,
      afterCompaction: false,
      estimatedTokens: 1234,
      contextWindow: 1000000,
      // Disallowed sensitive fields must be silently dropped
      prompt: 'SECRET_PROMPT',
      reasoning: 'SECRET_REASONING',
      seed: 'SECRET_SEED',
      apiKey: 'sk-secret-value',
    });
    const raw = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(raw);
    assert.equal(parsed.v, '0.2.0-experimental.16');
    assert.equal(parsed.event, 'inject');
    assert.equal(parsed.estimatedTokens, 1234);
    assert.equal(parsed.prompt, undefined);
    assert.equal(parsed.reasoning, undefined);
    assert.equal(parsed.seed, undefined);
    assert.equal(parsed.apiKey, undefined);
    assert.doesNotMatch(raw, /SECRET_PROMPT|SECRET_REASONING|SECRET_SEED|sk-secret/);

    // Invalid file path (writing onto existing directory) must never throw
    const badLogger = createAuditLogger({ enabled: true, filePath: dir });
    assert.doesNotThrow(() => badLogger.record({ event: 'skip', reason: 'test' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('package exports valid DSH desktop icon and zh/en locale metadata', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok(pkg.files.includes('icon.svg'));
  assert.ok(pkg.files.includes('locale'));

  const svg = readFileSync(join(pkgRoot, 'icon.svg'), 'utf8');
  assert.match(svg, /^<svg\b[\s\S]*<\/svg>\s*$/u);

  for (const [lang, expectedDetail] of [['zh', 'README.md'], ['en', 'README.en.md']]) {
    const loc = JSON.parse(readFileSync(join(pkgRoot, 'locale', `${lang}.json`), 'utf8'));
    assert.equal(typeof loc.meta?.title, 'string');
    assert.ok(loc.meta.title.length > 0);
    assert.equal(typeof loc.meta?.description, 'string');
    assert.ok(loc.meta.description.length > 0);
    assert.equal(loc.meta?.detail, expectedDetail);
  }
});
