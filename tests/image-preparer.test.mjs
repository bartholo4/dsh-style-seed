import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareImageVersions} from '../src/image-preparer.mjs';
import {bindImageVersions, imageVersionsFor} from '../src/base/image-context.js';
import {buildWireRequest} from '../src/base/wire.js';
import {DEFAULTS} from '../src/base/constants.js';

const ref=(id,overrides={})=>({attachmentId:id,mediaType:'image/png',width:80,height:40,bytes:4,...overrides});
const image=(id,extra={})=>({type:'image',attachment:ref(id),...extra});
const policy={maxPixels:4096,maxBytes:100,maxRequestImageBytes:32};
function fixture() {
  const calls=[];
  const helpers={
    attachments:{async readImageRequest(reference,target,signal){calls.push({reference,target,signal});return {data:Uint8Array.from([1,2,3,4]),bytes:4,mediaType:'image/png',width:80,height:40};}},
    dimensions:(width,height,maxPixels)=>({width,height,maxPixels}),
    handleText:(reference,version)=>`synthetic:${reference.attachmentId}:${version.width}`,
    requiredOffload:(messages,budget,bytes)=>{
      const total=messages.flatMap(m=>m.content).filter(b=>b.type==='image').reduce((sum,b)=>sum+Math.ceil(bytes(b)/3)*4,0);
      return total>budget.maxBytes?1:0;
    },
  };
  return {helpers,calls};
}

test('prepares and deduplicates user and tool attachment versions under route policy', async()=>{
  const {helpers,calls}=fixture(); const signal=new AbortController().signal;
  const versions=await prepareImageVersions([{role:'user',content:[image('a')]},{role:'tool',content:[image('a'),image('b')]}],helpers,policy,signal);
  assert.equal(calls.length,2);assert.deepEqual(calls[0].target,{width:80,height:40,maxPixels:4096,maxBytes:100});
  assert.equal(calls[0].signal,signal);assert.equal(versions.size,2);
  assert.deepEqual([...versions.get('a').data],[1,2,3,4]);
});

test('each repeated image occurrence keeps its own reference name', async()=>{
  const {helpers,calls}=fixture();
  helpers.handleText=reference=>`name:${reference.name}`;
  const first={type:'image',attachment:ref('a',{name:'first.png'})};
  const second={type:'image',attachment:ref('a',{name:'second.png'})};
  const messages=[{role:'user',content:[first,second]}];
  const versions=await prepareImageVersions(messages,helpers,policy);
  assert.equal(calls.length,1);
  const content=buildWireRequest({model:DEFAULTS.model,messages},{},versions).messages[0].content;
  assert.deepEqual(content.filter(block=>block.type==='text').map(block=>block.text),['name:first.png','name:second.png']);
});

test('stops loading additional images when the base64 request budget is exceeded',async()=>{
  const {helpers,calls}=fixture();
  const messages=[{role:'user',content:['a','b','c','d','e','f'].map(id=>image(id))}];
  await assert.rejects(prepareImageVersions(messages,helpers,policy),/size limit/);
  assert.equal(calls.length,5);
});

test('refuses missing, offloaded, inconsistent, or unsupported image content', async()=>{
  const cases=[
    [{role:'user',content:[{type:'image'}]}],
    [{role:'user',content:[image('a',{offloaded:true})]}],
    [{role:'assistant',content:[image('a')]}],
    [{role:'user',content:[image('a'),{type:'image',attachment:ref('a',{width:81})}]}],
    [{role:'user',content:[{type:'image',attachment:ref('a',{mediaType:'image/svg+xml'})}]}],
  ];
  for(const messages of cases){const {helpers}=fixture();await assert.rejects(prepareImageVersions(messages,helpers,policy));}
});

test('refuses missing attachment bytes, oversized request, and cancellation', async()=>{
  {const {helpers}=fixture();helpers.attachments.readImageRequest=async()=>{throw Error('private file path');};
    await assert.rejects(prepareImageVersions([{role:'user',content:[image('a')]}],helpers,policy),e=>e.message==='history switch could not prepare image attachments'&&!e.message.includes('private'));}
  {const {helpers}=fixture();await assert.rejects(prepareImageVersions([{role:'user',content:Array.from({length:5},()=>image('a'))}],helpers,policy),/size limit/);}
  {const {helpers}=fixture(),controller=new AbortController();controller.abort();
    await assert.rejects(prepareImageVersions([{role:'user',content:[image('a')]}],helpers,policy,controller.signal),/canceled/);}
});

test('request-local image data expires and concurrent requests remain separate',()=>{
  const first=new Map([['a',{data:Uint8Array.from([1])}]]),second=new Map([['a',{data:Uint8Array.from([2])}]]);
  const a=bindImageVersions({provider:'synthetic'},first),b=bindImageVersions({provider:'synthetic'},second);
  assert.equal(imageVersionsFor(a.options),first);assert.equal(imageVersionsFor(b.options),second);
  a.release();assert.throws(()=>imageVersionsFor(a.options),/expired/);assert.equal(imageVersionsFor(b.options),second);
  b.release();assert.throws(()=>imageVersionsFor(b.options),/expired/);
});
