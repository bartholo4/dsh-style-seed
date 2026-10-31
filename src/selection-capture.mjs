// Synthetic POC: observe the public prompt-assembly result rather than
// reaching into the desktop controller's private selection object.
export function installSelectionCapture(agentCtx) {
  let selected, resolved;
  const dispose = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next();
    const provider = result?.variables?.provider, model = result?.variables?.model;
    selected = typeof provider === 'string' && provider && typeof model === 'string' && model
      ? Object.freeze({ provider, model }) : undefined;
    return result;
  }, { prepend: true });
  return Object.freeze({
    get assembled() { return selected; },
    current: () => selected,
    currentRoute: () => resolved,
    recordResolved(route) {
      resolved = structuredClone(route);
    },
    dispose,
  });
}
