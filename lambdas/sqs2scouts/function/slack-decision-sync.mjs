function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function clone(value) {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(JSON.stringify(value));
}

function getCanonicalStatus(event) {
  const metadataStatus = event?.metadata?.status;
  if (metadataStatus && typeof metadataStatus === 'object') {
    return {
      isApproved: metadataStatus.isApproved === true,
      isHidden: metadataStatus.isHidden === true,
    };
  }
  return {
    isApproved: event?.isApproved === true || event?.approved === true,
    isHidden: event?.isHidden === true || event?.hidden === true,
  };
}

export function canonicalSlackDecision(event) {
  const status = getCanonicalStatus(event);
  if (status.isHidden) {
    return { status: 'HIDDEN', label: 'Hidden', emoji: '🙈' };
  }
  if (status.isApproved) {
    return { status: 'APPROVED', label: 'Approved', emoji: '✅' };
  }
  return { status: 'VISIBLE', label: 'Visible', emoji: '👁️' };
}

export function buildTerminalSlackPayload(event, { hexValue = null, resolveImageUrl = (value) => value } = {}) {
  const decision = canonicalSlackDecision(event);
  const title = text(event?.title || event?.summary || event?.name) || 'Scouts event';
  const hex = text(hexValue || event?.metadata?.hex || event?.hex);
  const context = hex ? `\n*HEX:* \`${hex}\`` : '';
  const payload = {
    text: `${decision.emoji} ${decision.label}: ${title}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${decision.emoji} Event ${decision.label}: ${title}`.slice(0, 150),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${title}* is now *${decision.label.toLowerCase()}* in the canonical Scouts event state.${context}`,
        },
      },
    ],
  };

  if (decision.status !== 'HIDDEN') {
    const imageUrl = text(event?.metadata?.image?.url || event?.image?.url);
    if (imageUrl) {
      const resolved = resolveImageUrl(imageUrl);
      if (resolved) {
        payload.blocks.push({
          type: 'image',
          image_url: resolved,
          alt_text: `Image for ${title}`,
        });
      }
    }
  }

  return { decision, payload };
}

export async function reconcileSlackDecision({
  event,
  messageBody = {},
  identifiers = [],
  loadMetadata,
  persistMetadata,
  updateMessage,
  postResponseUrl,
  resolveImageUrl,
  logger = console,
  now = () => new Date(),
} = {}) {
  const hexValue = text(event?.metadata?.hex || event?.hex).toLowerCase() || null;
  const { decision, payload } = buildTerminalSlackPayload(event, { hexValue, resolveImageUrl });
  const direct = messageBody?.slackMetadata && typeof messageBody.slackMetadata === 'object'
    ? messageBody.slackMetadata
    : {};

  let stored = null;
  if (typeof loadMetadata === 'function' && Array.isArray(identifiers) && identifiers.length > 0) {
    try {
      stored = await loadMetadata(identifiers, 'approval');
    } catch (error) {
      logger.warn?.('[SlackSync] Failed to load stored approval metadata', error?.message || error);
    }
  }

  const channel = text(direct.channel || stored?.channel) || null;
  const ts = text(direct.ts || stored?.ts) || null;
  const responseUrl = text(
    direct.responseUrl || direct.response_url || messageBody?.responseUrl || messageBody?.response_url,
  ) || null;
  const decisionSource = text(messageBody?.decisionSource) || (Object.keys(direct).length > 0 ? 'slack' : 'admin');
  let deliveredVia = null;

  if (channel && ts && typeof updateMessage === 'function') {
    try {
      await updateMessage(channel, ts, payload.text, payload.blocks);
      deliveredVia = 'chat.update';
    } catch (error) {
      logger.warn?.('[SlackSync] chat.update failed; persistence remains authoritative', {
        channel,
        ts,
        error: error?.message || String(error),
      });
    }
  }

  if (!deliveredVia && responseUrl && typeof postResponseUrl === 'function') {
    try {
      await postResponseUrl(responseUrl, { replace_original: true, ...payload });
      deliveredVia = 'response_url';
    } catch (error) {
      logger.warn?.('[SlackSync] response_url replacement failed; persistence remains authoritative', {
        error: error?.message || String(error),
      });
    }
  }

  const metadataBase = stored || ((channel && ts) ? {
    realm: 'approval',
    channel,
    ts,
    identifiers: Array.isArray(identifiers) ? identifiers : [],
    hex: hexValue,
    event: clone(event),
  } : null);

  if (metadataBase && typeof persistMetadata === 'function') {
    try {
      await persistMetadata(metadataBase, {
        status: decision.status,
        decisionSource,
        decidedAt: now().toISOString(),
        event: clone(event),
      });
    } catch (error) {
      logger.warn?.('[SlackSync] Failed to record terminal Slack approval metadata', error?.message || error);
    }
  }

  if (!deliveredVia) {
    logger.warn?.('[SlackSync] No Slack review message could be reconciled', {
      hex: hexValue,
      metadataFound: Boolean(stored),
      hasChannelAndTs: Boolean(channel && ts),
      hasResponseUrl: Boolean(responseUrl),
      terminalStatus: decision.status,
    });
  }

  return {
    decision,
    payload,
    deliveredVia,
    metadataFound: Boolean(stored),
    channel,
    ts,
    responseUrlPresent: Boolean(responseUrl),
  };
}
