import './_no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const runtime=process.env.DSH_RUNTIME_NODE_MODULES;
test('selected route projection keeps model-specific data transient and preserves tool images',
  {skip:!runtime && 'Set DSH_RUNTIME_NODE_MODULES'},async t=>{
    const require=createRequire(join(runtime,'synthetic-selected-route.cjs'));
    const entry=pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href;
    const catalog=pathToFileURL(join(runtime,'@earendil-works/pi-ai/dist/providers/all.js')).href;
    const hook=registerHooks({resolve(name,context,next){return next(name==='@deepseek-ai/dsh-llm'?entry:name==='@earendil-works/pi-ai/providers/all'?catalog:name,context);}});
    try {
      const {selectedRouteSnapshot,assertSameRouteSnapshot,seedMessages,restoreLegacyReasoning,preserveToolImages}=await import('../src/selected-route.mjs');
      const route={provider:'synthetic',model:'model-a'};
      let revision=1, profile={api:'openai-completions',baseURL:'https://secret.invalid/v1',apiKeyEnv:'PRIVATE_REF',
        headers:{authorization:'secret'},models:[{id:'model-a',compat:{requiresReasoningContentOnAssistantMessages:true}}]};
      const ctx={llm:{listConfigurableProviders:()=>[{provider:'synthetic',settingsNs:'synthetic',settingsPath:['providers','synthetic']}]},
        settings:{describe:()=>[{ns:'synthetic',revision,value:{providers:{synthetic:profile}}}]}};
      await t.test('snapshot retains only revision and supported wire facts',()=>{
        const held=selectedRouteSnapshot(ctx,route);
        assert.equal(held.api,'openai-completions');assert.equal(held.reasoningContent,true);
        assert.doesNotMatch(JSON.stringify(held),/secret|PRIVATE_REF/);
        assert.doesNotThrow(()=>assertSameRouteSnapshot(ctx,held));revision++;
        assert.throws(()=>assertSameRouteSnapshot(ctx,held),/发生变化/);revision--;
        profile={api:'openai-completions',baseURL:'https://deepseek.com.synthetic.invalid/v1',models:[{id:'model-a'}]};
        assert.equal(selectedRouteSnapshot(ctx,route).reasoningContent,true);
        profile.compat={requiresReasoningContentOnAssistantMessages:false};
        assert.equal(selectedRouteSnapshot(ctx,route).reasoningContent,false);
      });
      await t.test('sample is provider-bound only in temporary messages',()=>{
        const template={messages:[{role:'user',content:'sample question'},
          {role:'assistant',content:'sample answer',reasoning:'sample reasoning',source:{provider:'original',model:'original'}}]};
        const before=structuredClone(template), messages=seedMessages(template,route,'reasoning_content');
        assert.deepEqual(template,before);assert.equal(messages[0].content[0].text,'sample question');
        assert.equal(messages[1].source.provider,route.provider);
        assert.equal(messages[1].source.replayState.blocks[0].thinkingSignature,'reasoning_content');
        assert.equal(messages[1].content[0].text,'sample reasoning');
        const native=seedMessages(template,{provider:'deepseek-official',model:'synthetic'},'reasoning','deepseek-messages');
        assert.equal(native[1].content[0].text,'sample reasoning');
        assert.equal(native[1].source.replayState,undefined);
      });
      await t.test('official Messages service is identified by its registered service type',()=>{
        const direct={llm:{listConfigurableProviders:()=>[{provider:'deepseek-official',settingsNs:'llm-deepseek-api-key',settingsPath:[]}]},
          settings:{describe:()=>[{ns:'llm-deepseek-api-key',revision:1,value:{baseURL:'https://private.invalid'}}]}};
        assert.equal(selectedRouteSnapshot(direct,{provider:'deepseek-official',model:'synthetic'}).api,'deepseek-messages');
        direct.llm.listConfigurableProviders=()=>[{provider:'deepseek-official',settingsNs:'other',settingsPath:[]}];
        direct.settings.describe=()=>[{ns:'other',revision:1,value:{}}];
        assert.equal(selectedRouteSnapshot(direct,{provider:'deepseek-official',model:'synthetic'}).api,undefined);
      });
      await t.test('builtin model protocol and reasoning field come from the host catalog',()=>{
        const builtin={llm:{listConfigurableProviders:()=>[{provider:'xiaomi',settingsNs:'llm-pi-ai',settingsPath:['providers','xiaomi']}]},
          settings:{describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers:{xiaomi:{apiKeyEnv:'SYNTHETIC_REF'}}}}]}};
        const snap=selectedRouteSnapshot(builtin,{provider:'xiaomi',model:'mimo-v2.6-flash'});
        assert.equal(snap.api,'openai-completions');assert.equal(snap.reasoningContent,true);
      });
      await t.test('only same-model unsigned legacy thinking receives a temporary selector',()=>{
        const source={kind:'model',...route};
        const old={id:'one',role:'assistant',source,content:[{type:'reasoning',text:'synthetic thought'},
          {type:'text',text:'synthetic answer'},{type:'tool-call',id:'call',name:'read',arguments:'{}'}]};
        const existing={...old,id:'two',source:{...source,replayState:{synthetic:true}}};
        const foreign={...old,id:'three',source:{...source,provider:'other'}};
        const before=structuredClone(old), [a,b,c]=restoreLegacyReasoning([old,existing,foreign],route);
        assert.deepEqual(old,before);assert.equal(a.id,old.id);assert.equal(a.source.replayState.blocks[0].thinkingSignature,'reasoning');
        assert.equal(a.source.replayState.response.stopReason,'toolUse');assert.equal(b,existing);assert.equal(c,foreign);
        assert.throws(()=>restoreLegacyReasoning([{...old,content:[{type:'reasoning',text:'only'}]}],route),/无法完整恢复/);
      });
      await t.test('consecutive tool images keep their call and interleaved descriptions',()=>{
        const image=id=>({type:'image',attachment:{attachmentId:id}});
        const tool=(id,content)=>({id:`message-${id}`,role:'tool',toolCallId:id,content,source:{kind:'tool'}});
        const messages=[tool('one',[{type:'text',text:'cat'},image('a'),{type:'text',text:'dog'},image('b')]),
          tool('two',[{type:'text',text:'second'},image('c')])];
        const before=structuredClone(messages), result=preserveToolImages(messages);
        assert.deepEqual(messages,before);assert.deepEqual(result.slice(0,2).map(x=>x.toolCallId),['one','two']);
        assert.deepEqual(result[2].content.map(x=>x.type),['text','text','text','image','text','image','text','text','image']);
        assert.match(result[2].content[1].text,/one/);assert.match(result[2].content[6].text,/two/);
      });
    } finally {hook.deregister();}
  });
