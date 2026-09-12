import crypto from 'node:crypto';

function clone(value) {
  return structuredClone(value);
}

function metadata(event) {
  if (!event.metadata || typeof event.metadata !== 'object') event.metadata = {};
  return event.metadata;
}

function imageMetadata(event) {
  const meta = metadata(event);
  if (!meta.image || typeof meta.image !== 'object') meta.image = {};
  return meta.image;
}

function statusMetadata(event) {
  const meta = metadata(event);
  if (!meta.status || typeof meta.status !== 'object') meta.status = {};
  return meta.status;
}

export function getSyntheticHex(event) {
  const candidate = String(event?.metadata?.hex ?? '').trim().toLowerCase();
  if (!candidate || !/^[0-9a-f]+$/.test(candidate)) throw new Error('synthetic event missing valid metadata.hex');
  return candidate;
}

export function determineSyntheticStage(event) {
  if (!String(event?.metadata?.tagline ?? '').trim()) return 'tagline';
  if (!String(event?.metadata?.image?.theme ?? '').trim()) return 'imageTheme';
  if (!String(event?.metadata?.image?.url ?? '').trim()) return 'image';
  return 'complete';
}

export function translateAdminGenerationRequest(payload) {
  if (payload?.realm !== 'scouts') throw new Error('admin boundary: unsupported realm');
  const hex = String(payload?.subject?.hex ?? '').trim().toLowerCase();
  if (!hex || !/^[0-9a-f]+$/.test(hex)) throw new Error('admin boundary: missing HEX');

  const actions = {
    generateTagline: 'tagline',
    generateImageTheme: 'imageTheme',
    generateImage: 'imageUrl',
    generateFull: 'all',
  };
  const field = actions[payload.action];
  if (!field) throw new Error(`admin boundary: unsupported generation action ${payload.action ?? '<missing>'}`);
  return {
    realm: 'scoutsRequest',
    action: field === 'all' ? 'fullEnrich' : 'request',
    subject: field,
    hex,
  };
}

export function translateQueueStage(queueMessage, event) {
  const hex = getSyntheticHex(event);
  if (queueMessage?.hex !== hex) throw new Error('queue boundary: HEX mismatch');
  const requested = queueMessage?.subject === 'all' ? determineSyntheticStage(event) : queueMessage?.subject;
  if (requested === 'imageUrl') return { realm: 'image', action: 'request', subject: hex, stage: 'image' };
  if (requested === 'tagline' || requested === 'imageTheme') {
    return { realm: requested, action: 'request', subject: hex, stage: requested };
  }
  if (queueMessage?.action === 'fullEnrich') {
    const stage = determineSyntheticStage(event);
    return stage === 'complete' ? null : {
      realm: stage === 'image' ? 'image' : stage,
      action: 'request',
      subject: hex,
      stage,
    };
  }
  throw new Error(`queue boundary: unsupported stage ${requested ?? '<missing>'}`);
}

function imageGenerationKey(event) {
  const hex = getSyntheticHex(event);
  const theme = String(event?.metadata?.image?.theme ?? '').trim();
  return crypto.createHash('sha256').update(`${hex}\n${theme}`).digest('hex').slice(0, 20);
}

export function persistSyntheticEvent(state, eventInput, stage = 'manual') {
  const event = clone(eventInput);
  const hex = getSyntheticHex(event);
  if (!(state.persisted instanceof Map)) state.persisted = new Map();
  state.persisted.set(hex, clone(event));
  return { stage, event: clone(event) };
}

export function removeSyntheticEvent(state, hex) {
  const normalizedHex = String(hex ?? '').trim().toLowerCase();
  if (!normalizedHex || !/^[0-9a-f]+$/.test(normalizedHex)) throw new Error('remove boundary: invalid HEX');
  if (!(state.persisted instanceof Map)) return false;
  return state.persisted.delete(normalizedHex);
}

export async function enrichSyntheticEvent(eventInput, provider, state = {}) {
  const event = clone(eventInput);
  const trace = [];
  const snapshots = [];
  const cache = state.imageCache ?? new Map();
  const persisted = state.persisted ?? new Map();
  const hex = getSyntheticHex(event);
  let imageArtifact = null;

  while (true) {
    const stage = determineSyntheticStage(event);
    if (stage === 'complete') break;
    trace.push({ boundary: 'orchestration', stage, status: 'started' });

    if (stage === 'tagline') {
      metadata(event).tagline = await provider.generateTagline(clone(event));
      trace.push({ boundary: 'provider', stage, status: 'generated' });
    } else if (stage === 'imageTheme') {
      imageMetadata(event).theme = await provider.generateImageTheme(clone(event));
      trace.push({ boundary: 'provider', stage, status: 'generated' });
    } else {
      const generationKey = imageGenerationKey(event);
      let generated = cache.get(generationKey);
      if (!generated) {
        generated = await provider.generateImage(clone(event));
        cache.set(generationKey, generated);
        trace.push({ boundary: 'provider', stage, status: 'generated', generationKey });
      } else {
        trace.push({ boundary: 'provider', stage, status: 'reused', generationKey });
      }
      imageMetadata(event).url = `website/eventImages/test/${hex}-${generationKey}.png`;
      imageArtifact = generated;
    }

    persisted.set(hex, clone(event));
    snapshots.push({ stage, event: clone(event) });
    trace.push({ boundary: 'persistence', stage, status: 'persisted' });
  }

  return {
    event,
    trace,
    snapshots,
    artifacts: { image: imageArtifact },
    state: { imageCache: cache, persisted },
  };
}

export function applySyntheticAdminAction(eventInput, payload) {
  const event = clone(eventInput);
  if (payload?.realm !== 'scouts') throw new Error('action boundary: unsupported realm');
  const eventHex = getSyntheticHex(event);
  const payloadHex = String(payload?.subject?.hex ?? '').trim().toLowerCase();
  if (payloadHex !== eventHex) throw new Error('action boundary: HEX mismatch');
  const status = statusMetadata(event);

  switch (payload.action) {
    case 'approve':
      if (payload.subject.isApproved !== true) throw new Error('action boundary: invalid approval value');
      status.isApproved = true;
      break;
    case 'hide':
      if (payload.subject.isHidden !== true) throw new Error('action boundary: invalid hide value');
      status.isHidden = true;
      break;
    case 'unhide':
      if (payload.subject.isHidden !== false) throw new Error('action boundary: invalid unhide value');
      status.isHidden = false;
      break;
    default:
      throw new Error(`action boundary: unsupported action ${payload?.action ?? '<missing>'}`);
  }
  return event;
}

export function isSyntheticPubliclyVisible(event) {
  return event?.metadata?.status?.isApproved === true && event?.metadata?.status?.isHidden !== true;
}
