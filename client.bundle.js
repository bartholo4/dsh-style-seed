// Experimental candidate; not for production installation.
window.__ModuleLoader__.load({id:"dsh-style-seed",factory(require){
const React=require("react");
// UI uses the session-scoped projection; it never changes model selection.
function registerSessionSlot(ctx, React, bridge) {
  // The host's model picker shares this row; keep every status compact.
  const compactStyle = { display: 'inline-block', flex: '0 1 auto', minWidth: 0,
    maxWidth: 136, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 12, lineHeight: '20px', verticalAlign: 'middle' };
  const confirmed = (value, key) => value && typeof value.enabled === 'boolean' && typeof value.editable === 'boolean'
    ? { ...value, key, pending: false, error: false }
    : { key, pending: false, error: true };

  function Control({ sessionId, useSession, useProjection }) {
    const snap = useSession(s => s);
    const selection = useProjection('modelSelection')?.next;
    const visibleSession = Boolean(sessionId && snap && snap.subagent == null && !snap.removed);
    const blank = visibleSession && snap.blank === true;
    const running = Boolean(snap?.running);
    // Include every refresh trigger so a previous response cannot briefly make
    // an old state actionable while a new session, turn or route is loading.
    const key = JSON.stringify([sessionId, visibleSession, blank, snap?.openState ?? null, running,
      selection?.provider ?? null, selection?.model ?? null, selection?.reasoningEffort ?? null]);
    const [state, setState] = React.useState({ key: '', pending: true });
    const [refresh, setRefresh] = React.useState(0);
    const generation = React.useRef(0);
    const writing = React.useRef(new Set());
    const current = React.useRef(null);

    React.useEffect(() => {
      current.current = { key, sessionId };
      const version = ++generation.current;
      setState({ key, pending: true });
      if (visibleSession) bridge.get(sessionId).then(
        value => { if (generation.current === version) setState(confirmed(value, key)); },
        () => { if (generation.current === version) setState({ key, pending: false, error: true }); },
      );
      return () => { generation.current++; current.current = null; };
    }, [key, refresh]);

    if (!visibleSession) return null;
    const view = state.key === key ? state : { pending: true };
    const saving = writing.current.has(sessionId);
    const unknown = view.error || (!view.pending && typeof view.enabled !== 'boolean');
    const canToggle = !view.pending && !unknown && !saving && !view.savedOnly && !running &&
      view.editable === true && (blank || view.enabled === true);
    const renderedGeneration = generation.current;

    async function toggle() {
      // The ref also prevents a second click before React has rendered the
      // disabled state. A running or non-empty session must not be re-enabled.
      if (!canToggle || generation.current !== renderedGeneration || writing.current.has(sessionId)) return;
      writing.current.add(sessionId);
      const version = ++generation.current;
      setState({ key, pending: true });
      let result;
      try {
        result = confirmed(await bridge.set(sessionId, !view.enabled), key);
      } catch {
        // A failed RPC does not prove whether the save took effect.
        result = { key, pending: false, error: true };
      } finally {
        writing.current.delete(sessionId);
      }
      if (generation.current === version && current.current?.key === key) {
        setState(result);
      } else if (current.current?.sessionId === sessionId) {
        // The session/route changed while saving. Do not show a pre-save get.
        generation.current++;
        setState({ key: current.current.key, pending: true });
        setRefresh(value => value + 1);
      }
    }

    if (view.pending || saving || unknown || view.savedOnly) {
      const text = saving ? '保存中' : view.pending ? '检查中' : unknown ? '状态未确认' :
        `${view.enabled ? '开' : '关'}（未确认）`;
      const title = saving ? '正在保存，完成前不能再次操作。' : view.pending ? '正在检查当前会话的开关状态。' :
        unknown ? '开关状态未确认，请重新打开会话后再检查。' :
        `已保存为${view.enabled ? '开' : '关'}；当前状态尚未确认，发送时仍需校验。`;
      return React.createElement('span', { role: 'status', style: compactStyle, title }, `weneed开关：${text}`);
    }

    let detail = view.enabled ? '开启后将在发送时尝试使用；实际效果取决于所选模型和服务。' :
      '新会话默认关闭，可手动开启；实际效果取决于所选模型和服务。';
    if (view.admission === 'pending') detail += ' 当前会话的准备尚未完成。';
    else if (view.admission === 'skipped') detail += ' 当前会话此前未使用此功能。';
    else if (view.admission === 'disabled') detail += ' 当前会话已关闭。';
    if (running) detail += ' 会话运行中，空闲后才能修改。';
    else if (!blank && !view.enabled) detail += ' 已开始的会话不能重新开启，请新建会话。';
    else if (view.reason === 'new-session-required') detail += ' 当前无法修改；请新建会话后使用。';
    else if (!view.editable) detail += ' 当前暂时无法修改。';
    else if (!blank && view.enabled) detail += ' 空闲时可在当前会话关闭。';

    return React.createElement('button', { type: 'button', role: 'switch', disabled: !canToggle,
      'aria-checked': view.enabled, 'aria-busy': false, onClick: toggle,
      style: { ...compactStyle, padding: '2px 7px', borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.28)', color: 'inherit',
        background: view.enabled ? 'rgba(100,150,255,0.15)' : 'transparent',
        cursor: canToggle ? 'pointer' : 'default' }, title: detail },
      `weneed开关：${view.enabled ? '开' : '关'}`);
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'style-seed-session-switch', order: 100 }, Control));
  return Control;
}

const name="dsh-style-seed",inject=["slots","connection"];function apply(ctx){async function call(method,args){const r=await ctx.connection.rpc.call("/api","dsh-style-seed-switch/"+method,{args});if(!r.ok)throw new Error("weneed开关状态无法确认");return r.value;}registerSessionSlot(ctx,React,{get:id=>call("get",{sessionId:id}),set:(id,enabled)=>call("set",{sessionId:id,enabled})});}return {name,inject,apply};}});
