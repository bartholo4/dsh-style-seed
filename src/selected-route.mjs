// Non-secret snapshots and transient message projection for the selected DSH route.
import { createUserMessage, createAssistantMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { isDeepStrictEqual } from 'node:util';

const text = value => ({ type: 'text', text: value });

// Only the revision and wire protocol leave this function. Base URLs, headers,
// credential references and the rest of the settings stay with the DSH adapter.
export function selectedRouteSnapshot(ctx, route) {
  try {
    const {provider,model} = route;
    const entries = ctx.llm.listConfigurableProviders().filter(item => item?.provider === provider);
    if (entries.length !== 1 || typeof entries[0].settingsNs !== 'string' || !Array.isArray(entries[0].settingsPath)) throw Error();
    const entry = entries[0], docs = ctx.settings.describe({redactSecrets:true}).filter(item => item?.ns === entry.settingsNs);
    if (docs.length !== 1 || !Number.isSafeInteger(docs[0].revision)) throw Error();
    let value = docs[0].value;
    for (const key of entry.settingsPath) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) throw Error();
      value = value[key];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const catalog=getBuiltinModels(provider);
    const base=Array.isArray(catalog) ? catalog.find(item=>item?.id===model) : undefined;
    const catalogApis=[...new Set((catalog ?? []).map(item=>item?.api).filter(api=>typeof api==='string'))];
    const catalogApi=base?.api ?? (catalogApis.length===1 ? catalogApis[0] : undefined);
    const modelCompat = Array.isArray(value.models) ? value.models.find(item => item?.id === model)?.compat : undefined;
    const overrideCompat = value.modelOverrides?.[model]?.compat;
    const compatibility = [base?.compat, value.compat, modelCompat, overrideCompat];
    const compatValue = key => compatibility.reduce((current,item) => typeof item?.[key] === 'boolean' ? item[key] : current, undefined);
    // Mirrors pi-ai alpha.2's documented provider/base-URL compatibility
    // detection without retaining or logging the address itself.
    const effectiveUrl=value.baseURL ?? base?.baseUrl;
    const deepseekDetected = provider === 'deepseek' ||
      (typeof effectiveUrl === 'string' && effectiveUrl.toLowerCase().includes('deepseek.com'));
    // The two official alpha.2 DeepSeek adapters register these fixed service
    // identities with a root settings document and use the Messages protocol.
    // This classifies their protocol; it does not choose a URL or model.
    const officialMessages = entry.settingsPath.length === 0 &&
      ((provider === 'deepseek-official' && entry.settingsNs.startsWith('llm-deepseek-api-key')) ||
       (provider === 'deepseek-account' && entry.settingsNs.startsWith('llm-deepseek-account')));
    return Object.freeze({provider, model, namespace:entry.settingsNs, path:Object.freeze([...entry.settingsPath]),
      revision:docs[0].revision, api:typeof value.api === 'string' ? value.api : officialMessages ? 'deepseek-messages' : catalogApi,
      // pi-ai otherwise embeds thinking into visible assistant text.
      thinkingAsText:compatValue('requiresThinkingAsText') === true,
      reasoningContent:compatValue('requiresReasoningContentOnAssistantMessages') ?? deepseekDetected});
  } catch { throw new Error('weneed开关无法确认所选模型的服务配置；请关闭开关后重试'); }
}

export function assertSameRouteSnapshot(ctx, held) {
  if (!isDeepStrictEqual(held, selectedRouteSnapshot(ctx, held)))
    throw new Error('模型服务配置在请求准备期间发生变化，请重试');
}

// Experimental.12 saved complete assistant blocks but no pi-ai field selector.
// Reconstruct only same-provider, same-model, unsigned, representable history;
// preserve all existing replay metadata and never change the durable message.
export function restoreLegacyReasoning(messages, route, reasoningField = 'reasoning') {
  return messages.map(message => {
    if (message.role !== 'assistant' || !message.content.some(block => block.type === 'reasoning') ||
        message.source?.provider !== route.provider || message.source?.model !== route.model ||
        message.source?.replayState !== undefined) return message;
    if (message.content.some(block => !['text','reasoning','tool-call'].includes(block.type)) ||
        !message.content.some(block => block.type === 'tool-call' || (block.type === 'text' && block.text?.trim()))) {
      throw new Error('weneed开关无法完整恢复之前的思考记录');
    }
    const replayState = {response:{kind:'pi-ai',version:2,api:'openai-completions',provider:route.provider,model:route.model,
      stopReason:message.content.some(block=>block.type === 'tool-call') ? 'toolUse' : 'stop'},
      blocks:message.content.map(block => block.type === 'reasoning' ? {type:'reasoning',thinkingSignature:reasoningField} : {type:block.type})};
    return freezeMessage({...message,source:{...message.source,replayState}});
  });
}

// The pi-ai field selector is adapter metadata, not a cryptographic signature.
// This exists only on temporary, user-authorized imported sample messages.
export function seedMessages(template, route, reasoningField = 'reasoning', protocol = 'openai-completions') {
  if (!['reasoning','reasoning_content','reasoning_text'].includes(reasoningField)) throw new Error('weneed开关无法映射所选接口的思考字段');
  if (!['openai-completions','deepseek-messages'].includes(protocol)) throw new Error('weneed开关无法映射所选接口格式');
  return template.messages.map(message => {
    if (message.role === 'user') return createUserMessage({source:{kind:'user'},content:[text(message.content)]});
    const content = [];
    if (message.reasoning !== undefined && message.reasoning !== '') content.push({type:'reasoning',text:message.reasoning});
    content.push(text(message.content));
    if (protocol === 'deepseek-messages') return createAssistantMessage({source:{provider:route.provider,model:route.model},content});
    const replayState = {response:{kind:'pi-ai',version:2,api:'openai-completions',provider:route.provider,model:route.model,stopReason:'stop'},
      blocks:content.map(block => block.type === 'reasoning' ? {type:'reasoning',thinkingSignature:reasoningField} : {type:'text'})};
    return createAssistantMessage({source:{provider:route.provider,model:route.model,replayState},content});
  });
}

// DSH's OpenAI-completions adapter collects tool images into one following user
// message. Group them explicitly first so each image retains its tool-call ID
// and the text/image order within that result, as in the previous trial build.
export function preserveToolImages(messages) {
  const output = [];
  for (let i=0;i<messages.length;i++) {
    if (messages[i].role !== 'tool') { output.push(messages[i]); continue; }
    const group=[];
    for (; i<messages.length && messages[i].role === 'tool'; i++) group.push(messages[i]);
    i--;
    const imageGroups=[];
    for (const message of group) {
      if (!message.content.some(block => block.type === 'image')) { output.push(message); continue; }
      if (typeof message.toolCallId !== 'string' || !message.toolCallId ||
          message.content.some(block => !['text','image'].includes(block.type))) throw new Error('weneed开关无法完整保留工具图片结果');
      const onlyText=message.content.filter(block => block.type === 'text');
      output.push(freezeMessage({...message,content:onlyText.length ? onlyText : [text('(see attached image)')]}));
      imageGroups.push(text(`Image(s) returned by tool call ${JSON.stringify(message.toolCallId)}:`),...message.content);
    }
    if (imageGroups.length) output.push(createUserMessage({source:{kind:'user'},content:[text('Attached image(s) from tool result:'),...imageGroups]}));
  }
  return output;
}
