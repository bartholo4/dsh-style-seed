import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = new URL('../src/client.mjs', import.meta.url);
const bundleUrl = new URL('../client.bundle.js', import.meta.url);
const raw = await readFile(sourceUrl, 'utf8');
const body = raw.replace('export function registerSessionSlot', 'function registerSessionSlot');
if (body === raw) throw new Error('client entry was not found');

// DSH resolves React from its own client runtime; it is not bundled here.
const bundle = `// Experimental candidate; not for production installation.\nwindow.__ModuleLoader__.load({id:"dsh-style-seed",factory(require){\nconst React=require("react");\n${body}\nconst name="dsh-style-seed",inject=["slots","connection"];function apply(ctx){async function call(method,args){const r=await ctx.connection.rpc.call("/api","dsh-style-seed-switch/"+method,{args});if(!r.ok)throw new Error("weneed开关状态无法确认");return r.value;}registerSessionSlot(ctx,React,{get:id=>call("get",{sessionId:id}),set:(id,enabled)=>call("set",{sessionId:id,enabled})});}return {name,inject,apply};}});\n`;

if (process.argv.includes('--check')) {
  if (await readFile(bundleUrl, 'utf8') !== bundle) {
    throw new Error('client.bundle.js differs from the generated bundle');
  }
  console.log('client.bundle.js matches src/client.mjs');
} else {
  await writeFile(bundleUrl, bundle, 'utf8');
  console.log('Built client.bundle.js');
}
