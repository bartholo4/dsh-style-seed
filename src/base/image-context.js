// One-use transient side table: image bytes are not added to durable messages.
const imageRequest = Symbol('history-switch-image-request');
const pending = new WeakMap();

export function bindImageVersions(options, versions, dispatchGuard = undefined) {
  if (versions !== undefined && (!(versions instanceof Map) || versions.size === 0)) throw new Error('image request data unavailable');
  if (dispatchGuard !== undefined && typeof dispatchGuard !== 'function') throw new Error('request guard unavailable');
  if (versions === undefined && dispatchGuard === undefined) throw new Error('request context unavailable');
  const marker = Object.freeze({});
  pending.set(marker, {versions, dispatchGuard});
  return {
    options: {...options, [imageRequest]: marker},
    release() { pending.delete(marker); },
  };
}

export function imageVersionsFor(options) {
  return requestContextFor(options)?.versions;
}

export function dispatchGuardFor(options) {
  return requestContextFor(options)?.dispatchGuard;
}

function requestContextFor(options) {
  const marker = options?.[imageRequest];
  if (marker === undefined) return undefined;
  const context = pending.get(marker);
  if (!context) throw new Error('image request data expired');
  return context;
}
