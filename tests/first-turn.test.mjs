import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCompletedReply, makeFirstTurnClassifier } from '../src/first-turn.mjs';

const id = 'test-session', digest = 'a'.repeat(64), other = 'b'.repeat(64);
const reference = { role: 'user', source: { kind: 'dsh-style-seed-reference', ownerSessionId: id, sha256: digest } };
const codec = { read(m, session) {
  if (m?.source?.kind !== 'dsh-style-seed-reference') return undefined;
  if (m.source.ownerSessionId !== session) throw Error('owner');
  return m.source;
} };
const start = n => ({type:'turn/start', data:{turn:n}});
const seed = {type:'user/message',data:reference};
const user = {type:'user/message',data:{role:'user',source:{kind:'user'}}};
const assistant = (turn, content) => ({type:'assistant/message',data:{turn,message:{role:'assistant',source:{kind:'model'},content}}});
const end = (turn,kind) => ({type:'turn/end',data:{turn,reason:{kind}}});
const call = {type:'tool-call',id:'x',name:'test',arguments:'{}'};
const answer = {type:'text',text:'synthetic answer'};
const think = {type:'reasoning',text:'synthetic reasoning'};
const check = events => hasCompletedReply(events,codec,id,digest);

test('includes the seed through the first tool call and its continuation',()=>{
 const progress=[start(1),seed,user,assistant(1,[think,call]),{type:'tool/result',data:{turn:1}}];
 assert.equal(check(progress),false);
 assert.equal(check([...progress,assistant(1,[think,answer])]),false);
 assert.equal(check([...progress,assistant(1,[think,answer]),end(1,'completed')]),true);
});
test('never completes on errors, empty output, tool-only responses or unrelated events',()=>{
 assert.equal(check([start(1),seed,user,assistant(1,[answer]),end(1,'error')]),false);
 assert.equal(check([start(1),seed,user,assistant(1,[think]),end(1,'completed')]),false);
 assert.equal(check([start(1),seed,user,assistant(1,[answer,call]),end(1,'completed')]),false);
 assert.equal(check([start(1),seed,assistant(1,[answer]),end(1,'completed')]),false);
});
test('failed first turn keeps the seed until a later successful user turn',()=>{
 const events=[start(1),seed,user,assistant(1,[answer]),end(1,'error'),start(2),user,assistant(2,[answer]),end(2,'completed')];
 assert.equal(check(events),true);
});
test('requires authenticated owner and durable original reference',()=>{
 assert.throws(()=>check([start(1),user]));
 assert.throws(()=>check([start(1),{type:'user/message',data:{...reference,source:{...reference.source,ownerSessionId:'other'}}},user]));
 assert.throws(()=>hasCompletedReply([start(1),seed,user],codec,id,other));
});
test('classifier is session-bound and reads current immutable event history',()=>{
 let events=[start(1),seed,user];const session={id,snapshotEvents:()=>events};
 const policy=makeFirstTurnClassifier({agents:{get:()=>({id,session})}},codec,digest);
 assert.equal(policy.completed(id),false);
 events=[...events,assistant(1,[answer]),end(1,'completed')];
 assert.equal(policy.completed(id),true);
 assert.throws(()=>policy.completed('another-session'));
});
