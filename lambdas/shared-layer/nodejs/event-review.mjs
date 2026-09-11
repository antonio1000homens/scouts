import crypto from 'node:crypto';

function text(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function bool(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function metadataOf(event) {
  return event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
}

function imageOf(event) {
  const metadata = metadataOf(event);
  if (metadata.image && typeof metadata.image === 'object') return metadata.image;
  return event?.image && typeof event.image === 'object' ? event.image : {};
}

function statusOf(event) {
  const metadata = metadataOf(event);
  return metadata.status && typeof metadata.status === 'object' ? metadata.status : {};
}

function normaliseHex(value) {
  const candidate = text(value)?.toLowerCase() || null;
  return candidate && /^[0-9a-f]+$/i.test(candidate) ? candidate : null;
}

function canonicalReviewValues(event) {
  const metadata = metadataOf(event);
  const image = imageOf(event);
  const status = statusOf(event);
  const hex = normaliseHex(metadata.hex ?? event?.hex ?? event?.requestHex ?? null);
  if (!hex) throw new Error('Event review snapshot requires a canonical HEX');

  return {
    hex,
    tagline: text(metadata.tagline ?? event?.tagline ?? null),
    imageTheme: text(image.theme ?? event?.imageTheme ?? null),
    imageUrl: text(image.url ?? event?.imageUrl ?? null),
    isHidden: bool(status.isHidden ?? event?.isHidden ?? event?.hidden ?? false),
  };
}

export function eventReviewRevision(input) {
  const values = input?.hex && Object.prototype.hasOwnProperty.call(input, 'isHidden')
    ? {
        hex: normaliseHex(input.hex),
        tagline: text(input.tagline),
        imageTheme: text(input.imageTheme),
        imageUrl: text(input.imageUrl),
        isHidden: bool(input.isHidden),
      }
    : canonicalReviewValues(input);
  if (!values.hex) throw new Error('Event review revision requires a canonical HEX');
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
}

export function buildEventReviewSnapshot(event) {
  const values = canonicalReviewValues(event);
  const metadata = metadataOf(event);
  return {
    ...values,
    revision: eventReviewRevision(values),
    title: text(event?.title ?? event?.summary ?? event?.name ?? null),
    uid: text(event?.uid ?? event?.originalUid ?? metadata.uid ?? null),
  };
}

export function compareEventReviewRevision(event, submittedRevision) {
  const current = buildEventReviewSnapshot(event);
  const submitted = text(submittedRevision);
  return {
    ok: Boolean(submitted) && submitted === current.revision,
    submittedRevision: submitted,
    currentRevision: current.revision,
    current,
  };
}

export function buildApprovedSnapshotPatch(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('Approval requires a review snapshot');
  const hex = normaliseHex(snapshot.hex);
  if (!hex) throw new Error('Approval snapshot requires a canonical HEX');
  const expectedRevision = eventReviewRevision(snapshot);
  if (text(snapshot.revision) !== expectedRevision) {
    throw new Error('Approval snapshot revision does not match its reviewable values');
  }

  const imageUrl = text(snapshot.imageUrl);
  const imageTheme = text(snapshot.imageTheme);
  return {
    metadata: {
      hex,
      tagline: text(snapshot.tagline),
      image: {
        theme: imageTheme,
        url: imageUrl,
      },
      status: {
        isHidden: bool(snapshot.isHidden),
        isApproved: Boolean(imageUrl),
      },
    },
    approval: {
      revision: expectedRevision,
      nextState: imageUrl ? 'approved' : 'awaiting_image',
      requiresGeneratedImage: !imageUrl,
      requiresFinalImageReview: !imageUrl,
    },
  };
}

export function approvalOperationId({ hex, revision, action = 'approve' } = {}) {
  const eventHex = normaliseHex(hex);
  const reviewRevision = text(revision);
  const approvalAction = text(action)?.toLowerCase();
  if (!eventHex || !reviewRevision || !approvalAction) {
    throw new Error('Approval operation identity requires hex, revision and action');
  }
  const digest = crypto.createHash('sha256')
    .update(`${eventHex}\n${reviewRevision}\n${approvalAction}`)
    .digest('hex')
    .slice(0, 32);
  return `approval-${digest}`;
}

export function approvalIdempotencyKey({ rootRequestId, revision, action = 'approve' } = {}) {
  const root = text(rootRequestId);
  const reviewRevision = text(revision);
  const approvalAction = text(action)?.toLowerCase();
  if (!root || !reviewRevision || !approvalAction) {
    throw new Error('Approval idempotency requires rootRequestId, revision and action');
  }
  return crypto.createHash('sha256')
    .update(`${root}\n${reviewRevision}\n${approvalAction}`)
    .digest('hex');
}
