// Prepare DSH durable attachment references for one transient provider request.
// No image bytes or attachment identifiers are written to logs or sessions.
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const cancel = signal => { if (signal?.aborted) throw new Error('history switch image preparation canceled'); };

export async function prepareImageVersions(messages, helpers, policy, signal) {
  if (!Array.isArray(messages) || !helpers || typeof helpers.attachments?.readImageRequest !== 'function' ||
      typeof helpers.dimensions !== 'function' || typeof helpers.requiredOffload !== 'function' ||
      typeof helpers.handleText !== 'function' || !positive(policy?.maxPixels) || !positive(policy?.maxBytes) ||
      !positive(policy?.maxRequestImageBytes)) throw new Error('history switch image preparation unavailable');
  cancel(signal);
  const refs = new Map();
  for (const message of messages) {
    if (!Array.isArray(message?.content)) throw new Error('history switch image content invalid');
    for (const block of message.content) {
      if (block?.type !== 'image') continue;
      if (!['user', 'tool'].includes(message.role) || block.offloaded === true) throw new Error('history switch cannot send an unavailable image');
      const ref = block.attachment;
      if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId || !positive(ref.width) ||
          !positive(ref.height) || !positive(ref.bytes) || !imageTypes.has(ref.mediaType)) throw new Error('history switch image reference invalid');
      const prior = refs.get(ref.attachmentId);
      if (prior && ['width', 'height', 'bytes', 'mediaType'].some(key => prior.ref[key] !== ref[key])) throw new Error('history switch image reference inconsistent');
      if (prior) prior.blocks.push(block);
      else refs.set(ref.attachmentId, {ref, blocks: [block]});
    }
  }
  if (!refs.size) throw new Error('history switch image reference unavailable');
  const versions = new Map();
  try {
    let encodedBytes = 0;
    for (const {ref, blocks} of refs.values()) {
      cancel(signal);
      const target = {...helpers.dimensions(ref.width, ref.height, policy.maxPixels), maxBytes: policy.maxBytes};
      if (!positive(target.width) || !positive(target.height)) throw new Error('invalid image target');
      const version = await helpers.attachments.readImageRequest(ref, target, signal);
      cancel(signal);
      if (!(version?.data instanceof Uint8Array) || !positive(version.data.byteLength) ||
          version.bytes !== version.data.byteLength || !imageTypes.has(version.mediaType) ||
          !positive(version.width) || !positive(version.height)) throw new Error('invalid image request version');
      // Count every occurrence before retaining a copy. The DSH limit applies
      // to the base64 request, including repeated references to the same image.
      const occurrenceBytes = Math.ceil(version.bytes / 3) * 4 * blocks.length;
      if (!Number.isSafeInteger(occurrenceBytes) || !Number.isSafeInteger(encodedBytes + occurrenceBytes) ||
          encodedBytes + occurrenceBytes > policy.maxRequestImageBytes) {
        throw new Error('history switch image request exceeds the configured size limit');
      }
      encodedBytes += occurrenceBytes;
      const handleTextByBlock = new WeakMap();
      for (const block of blocks) {
        const access = typeof helpers.resolveAccess === 'function' ? helpers.resolveAccess(block.attachment) : undefined;
        const handle = helpers.handleText(block.attachment, version, access);
        if (typeof handle !== 'string') throw new Error('invalid image handle');
        handleTextByBlock.set(block, handle);
      }
      // Copy provider bytes into request-local memory; no mutable alias escapes.
      versions.set(ref.attachmentId, {data: Uint8Array.from(version.data), mediaType: version.mediaType,
        bytes: version.bytes, handleTextByBlock});
    }
    const excess = helpers.requiredOffload(messages, {representation: 'base64', maxBytes: policy.maxRequestImageBytes},
      block => versions.get(block.attachment.attachmentId)?.bytes);
    if (!Number.isSafeInteger(excess) || excess < 0) throw new Error('invalid image budget');
    if (excess > 0) throw new Error('history switch image request exceeds the configured size limit');
  } catch (error) {
    cancel(signal);
    if (error?.message === 'history switch image request exceeds the configured size limit') throw error;
    throw new Error('history switch could not prepare image attachments');
  }
  cancel(signal);
  return versions;
}
