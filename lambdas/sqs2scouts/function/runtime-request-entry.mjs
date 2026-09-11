function text(value) { return value == null ? '' : String(value).trim(); }

function getHexHint(messageBody) {
    const subject = messageBody?.subject;
    const value = typeof subject === 'string' ? subject : subject?.hexId ?? subject?.hex ?? messageBody?.hex;
    return text(value) || null;
}

function getTitleHint(messageBody) {
    const subject = messageBody?.subject;
    return text(messageBody?.title ?? (typeof subject === 'object' ? subject?.title : null)) || null;
}

function getSubjectHint(messageBody) {
    const subject = messageBody?.subject;
    if (typeof subject === 'string') return text(subject) || null;
    return text(messageBody?.requestedField ?? messageBody?.realm ?? subject?.hexId) || null;
}

function normaliseAction(value) { return text(value) || null; }

function getRequestTime(record, messageBody) {
    const timestamp = record?.attributes?.SentTimestamp ?? messageBody?.requestTime;
    return timestamp ? new Date(Number(timestamp)).toISOString() : new Date().toISOString();
}

export function buildRuntimeRequestEntry(record, messageBody, status) {
    const requestId = messageBody?.requestId ?? record?.messageId ?? null;
    const messageId = messageBody?.messageId ?? record?.messageId ?? null;
    const hex = getHexHint(messageBody);
    return {
        requestTime: getRequestTime(record, messageBody),
        requestId: requestId ? String(requestId) : null,
        messageId: messageId ? String(messageId) : null,
        hex,
        hexId: hex,
        title: getTitleHint(messageBody),
        subject: getSubjectHint(messageBody),
        realm: text(messageBody?.realm) || null,
        action: normaliseAction(messageBody?.action),
        taskToken: text(messageBody?.taskToken) || null,
        orchestrationType: text(messageBody?.orchestrationType) || null,
        orchestrationStep: text(messageBody?.orchestrationStep) || null,
        status,
    };
}
