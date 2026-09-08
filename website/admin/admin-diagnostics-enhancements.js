// Operational admin enhancements: explicit DLQ inspection/redrive, clear polling
// semantics, and a direct Request Image action when an event already has the
// image-generation prerequisite metadata.

(function () {
    const DLQ_NAMES = ['scoutsRequestsDLQ', 'scoutsProcessingDLQ'];
    const DLQ_SOURCE_LABELS = {
        scoutsRequestsDLQ: 'scoutsRequests',
        scoutsProcessingDLQ: 'scoutsProcessing',
    };
    const dlqSamples = new Map();
    const dlqActionState = new Map();
    const pendingDirectImageHexes = new Set();
    let latestDlqActivity = null;
    let cardObserver = null;

    function text(value) {
        if (value === undefined || value === null) return '';
        return String(value).trim();
    }

    function formatDateTime(value) {
        const candidate = text(value);
        if (!candidate) return 'n/a';
        const parsed = new Date(candidate);
        return Number.isNaN(parsed.getTime()) ? candidate : parsed.toLocaleString('en-GB');
    }

    function makeHelp(textValue) {
        const help = document.createElement('p');
        help.className = 'diagnostics-help';
        help.textContent = textValue;
        return help;
    }

    function retireAutoLambdaHeartbeat() {
        // The modern workflow is event-driven. Status tracking does not require
        // periodically invoking the Scouts agenda Lambda, so disable the old
        // browser heartbeat and persist that preference before removing its UI.
        if (typeof setAutoLambdaInvocationEnabled === 'function') {
            setAutoLambdaInvocationEnabled(false, true);
        }
        document.querySelector('label[for="auto-lambda-toggle"]')?.remove();
        document.getElementById('auto-lambda-interval-seconds')?.remove();
    }

    function clarifyPollingControls() {
        const section = document.getElementById('diagnostics-polling');
        if (!section) return;

        const label = section.querySelector('label[for="status-polling-toggle"]');
        if (label) {
            const input = label.querySelector('#status-polling-toggle');
            label.replaceChildren();
            if (input) label.appendChild(input);
            label.append(document.createTextNode(' Status polling'));
            label.title = 'Refreshes admin status only. It does not start or process queue work.';
        }

        const interval = section.querySelector('#status-polling-interval-seconds');
        if (interval) {
            interval.title = 'How often this page refreshes canonical request lifecycle, queue counts and Step Functions status.';
            interval.setAttribute('aria-label', 'Status polling interval in seconds');
        }

        if (!section.querySelector('.diagnostics-polling-help')) {
            const help = makeHelp('Status polling refreshes the canonical request lifecycle, queue counts and Step Functions status. It does not invoke workers, create requests or process queues, so it is safe to leave enabled.');
            help.classList.add('diagnostics-polling-help');
            section.appendChild(help);

            const retired = makeHelp('Auto Lambda heartbeat has been retired from the admin page. SQS event-source mappings and the full-enrich Step Functions workflow now drive background work; periodic agenda Lambda invocation is not required for job tracking.');
            retired.classList.add('diagnostics-polling-help');
            section.appendChild(retired);
        }
    }

    function ensureDlqSection() {
        let section = document.getElementById('diagnostics-dlq');
        if (section) return section;

        const queueSection = document.getElementById('diagnostics-queue-health');
        if (!queueSection) return null;

        section = document.createElement('section');
        section.id = 'diagnostics-dlq';
        section.className = 'admin-diagnostics-section';
        section.innerHTML = `
            <h3>Dead-letter queues</h3>
            <p class="admin-diagnostics-section-description">Normal status polling reads DLQ counts only. Message content is sampled only when you choose Inspect.</p>
            <p class="diagnostics-help">Inspect is non-destructive and uses a zero-second visibility timeout, but SQS has no true peek API so a sampled message's receive count can increase. Redrive is always explicit and moves the current DLQ back to its configured source queue at 1 message/second.</p>
            <div class="dlq-toolbar"><button type="button" class="btn btn-secondary requires-api" id="dlq-refresh-overview">Refresh DLQ counts</button></div>
            <div id="diagnostics-dlq-content"><p>DLQ status not loaded yet.</p></div>
        `;
        queueSection.insertAdjacentElement('afterend', section);
        section.querySelector('#dlq-refresh-overview')?.addEventListener('click', () => refreshDlqOverview(true));
        return section;
    }

    function queueHealthFor(name) {
        return latestDlqActivity?.queueHealth?.[name] || null;
    }

    function renderDefinition(container, label, value) {
        const row = document.createElement('div');
        row.className = 'diagnostics-kv';
        const key = document.createElement('strong');
        key.textContent = label;
        const val = document.createElement('span');
        val.textContent = value === undefined || value === null || value === '' ? 'n/a' : String(value);
        row.append(key, val);
        container.appendChild(row);
    }

    function renderDlqMessage(message) {
        const summary = message?.summary || {};
        const card = document.createElement('article');
        card.className = 'dlq-message-card';

        const header = document.createElement('div');
        header.className = 'dlq-message-header';
        const title = document.createElement('strong');
        title.textContent = summary.subject || summary.hex || message?.messageId || 'DLQ message';
        const receive = document.createElement('span');
        receive.textContent = `receive count ${Number(message?.receiveCount || 0)}`;
        header.append(title, receive);
        card.appendChild(header);

        renderDefinition(card, 'Request ID', summary.requestId);
        renderDefinition(card, 'HEX', summary.hex);
        renderDefinition(card, 'Realm / action', [summary.realm, summary.action].filter(Boolean).join(' / '));
        renderDefinition(card, 'SQS message ID', message?.messageId);
        renderDefinition(card, 'Request timestamp', formatDateTime(summary.requestTimestamp));
        renderDefinition(card, 'Sent to SQS', formatDateTime(message?.sentAt));
        renderDefinition(card, 'First received', formatDateTime(message?.firstReceivedAt));

        const details = document.createElement('details');
        details.className = 'dlq-body-details';
        const detailsSummary = document.createElement('summary');
        detailsSummary.textContent = 'Raw message body';
        const pre = document.createElement('pre');
        pre.textContent = text(message?.bodyPreview) || 'No body available.';
        details.append(detailsSummary, pre);
        card.appendChild(details);
        return card;
    }

    function setDlqState(name, state) {
        if (state) dlqActionState.set(name, state);
        else dlqActionState.delete(name);
        renderDlqDiagnostics();
    }

    function renderDlqDiagnostics() {
        const target = document.getElementById('diagnostics-dlq-content');
        if (!target) return;
        target.replaceChildren();

        DLQ_NAMES.forEach((name) => {
            const health = queueHealthFor(name);
            const sample = dlqSamples.get(name);
            const state = dlqActionState.get(name);
            const visible = Number(health?.visible ?? sample?.visible ?? 0);
            const panel = document.createElement('div');
            panel.className = 'dlq-panel';

            const heading = document.createElement('div');
            heading.className = 'dlq-panel-header';
            const title = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = name;
            const source = document.createElement('span');
            source.textContent = ` → ${DLQ_SOURCE_LABELS[name]}`;
            title.append(strong, source);
            const count = document.createElement('span');
            count.className = 'dlq-count';
            count.textContent = health?.ok === false ? 'unavailable' : `${visible} visible`;
            heading.append(title, count);
            panel.appendChild(heading);

            if (health?.error) renderDefinition(panel, 'Queue error', health.error);
            if (sample?.sampledAt) renderDefinition(panel, 'Last inspected', formatDateTime(sample.sampledAt));
            if (sample?.note) renderDefinition(panel, 'Inspect note', sample.note);
            if (state?.message) {
                const status = document.createElement('p');
                status.className = `dlq-action-status ${state.tone || 'info'}`;
                status.textContent = state.message;
                panel.appendChild(status);
            }

            const actions = document.createElement('div');
            actions.className = 'dlq-actions';
            const inspect = document.createElement('button');
            inspect.type = 'button';
            inspect.className = 'btn btn-secondary requires-api';
            inspect.textContent = state?.busy === 'inspect' ? 'Inspecting…' : 'Inspect messages';
            inspect.disabled = Boolean(state?.busy) || !apiAuthReady;
            inspect.addEventListener('click', () => inspectDlq(name));
            actions.appendChild(inspect);

            const redrive = document.createElement('button');
            redrive.type = 'button';
            redrive.className = 'btn btn-secondary requires-api dlq-redrive-button';
            redrive.textContent = state?.busy === 'redrive' ? 'Starting redrive…' : `Redrive all${visible > 0 ? ` (${visible})` : ''}`;
            redrive.disabled = Boolean(state?.busy) || visible <= 0 || !apiAuthReady;
            redrive.title = visible > 0
                ? `Move all currently visible messages from ${name} back to ${DLQ_SOURCE_LABELS[name]} at 1 message/second.`
                : 'No visible messages to redrive.';
            redrive.addEventListener('click', () => redriveDlq(name, visible));
            actions.appendChild(redrive);
            panel.appendChild(actions);

            const messages = Array.isArray(sample?.messages) ? sample.messages : [];
            if (messages.length) {
                const messageList = document.createElement('div');
                messageList.className = 'dlq-message-list';
                messages.forEach((message) => messageList.appendChild(renderDlqMessage(message)));
                panel.appendChild(messageList);
            } else if (sample) {
                const empty = document.createElement('p');
                empty.className = 'diagnostics-help';
                empty.textContent = visible > 0
                    ? 'No messages were returned in this sample. SQS sampling is approximate; inspect again if needed.'
                    : 'No visible messages in this DLQ.';
                panel.appendChild(empty);
            }

            target.appendChild(panel);
        });
    }

    async function refreshDlqOverview(showStatus = false) {
        try {
            if (showStatus) {
                DLQ_NAMES.forEach((name) => setDlqState(name, { message: 'Refreshing queue counts…', tone: 'info', busy: 'refresh' }));
            }
            const result = await sendScoutsCommand({ realm: 'runtime', subject: 'activity', action: 'status' });
            if (!result?.activity) throw new Error('Activity payload missing');
            latestDlqActivity = result.activity;
            DLQ_NAMES.forEach((name) => dlqActionState.delete(name));
            renderDlqDiagnostics();
        } catch (error) {
            DLQ_NAMES.forEach((name) => dlqActionState.set(name, {
                message: `Failed to refresh DLQ counts: ${error?.message || error}`,
                tone: 'error',
            }));
            renderDlqDiagnostics();
        }
    }

    async function inspectDlq(name) {
        setDlqState(name, { message: 'Sampling up to 5 visible messages…', tone: 'info', busy: 'inspect' });
        try {
            const result = await sendScoutsCommand({
                realm: 'runtime',
                subject: 'dlq',
                action: 'inspect',
                queueName: name,
                maxMessages: 5,
            });
            if (!result?.dlq) throw new Error('DLQ inspection payload missing');
            dlqSamples.set(name, result.dlq);
            const health = queueHealthFor(name) || {};
            latestDlqActivity = {
                ...(latestDlqActivity || {}),
                queueHealth: {
                    ...(latestDlqActivity?.queueHealth || {}),
                    [name]: {
                        ...health,
                        name,
                        visible: result.dlq.visible,
                        inFlight: result.dlq.inFlight,
                        delayed: result.dlq.delayed,
                        ok: true,
                    },
                },
            };
            dlqActionState.delete(name);
            renderDlqDiagnostics();
        } catch (error) {
            setDlqState(name, { message: `Inspect failed: ${error?.message || error}`, tone: 'error' });
        }
    }

    async function redriveDlq(name, expectedVisible) {
        const count = Number(expectedVisible || 0);
        if (count <= 0) return;
        const source = DLQ_SOURCE_LABELS[name];
        const confirmed = window.confirm(
            `Redrive all ${count} currently visible message${count === 1 ? '' : 's'} from ${name} back to ${source}?\n\n`
            + 'Messages will be replayed at a maximum of 1 per second. If the DLQ count has changed since this view was loaded, the backend will refuse the redrive and require a fresh inspection.',
        );
        if (!confirmed) return;

        setDlqState(name, { message: `Starting redrive of ${count} message(s)…`, tone: 'info', busy: 'redrive' });
        try {
            const result = await sendScoutsCommand({
                realm: 'runtime',
                subject: 'dlq',
                action: 'redrive',
                queueName: name,
                expectedVisible: count,
            });
            const redrive = result?.redrive;
            if (!redrive) throw new Error('Redrive response missing');
            dlqSamples.delete(name);
            setDlqState(name, {
                message: redrive.status === 'empty'
                    ? 'DLQ is already empty.'
                    : `Redrive started for ${redrive.visibleAtStart} message(s) at ${redrive.maxMessagesPerSecond || 1}/second.`,
                tone: 'success',
            });
            setTimeout(() => refreshDlqOverview(false), 1500);
        } catch (error) {
            const detail = error?.message || String(error);
            setDlqState(name, {
                message: /changed from/i.test(detail)
                    ? `${detail} Refresh/inspect the DLQ before trying again.`
                    : `Redrive failed: ${detail}`,
                tone: 'error',
            });
        }
    }

    function directImagePrerequisites(event) {
        const hex = typeof getEventHex === 'function' ? text(getEventHex(event)).toLowerCase() : '';
        const imageUrl = typeof getImageUrl === 'function' ? text(getImageUrl(event)) : '';
        const imageThemeOrPrompt = typeof getImageThemeOrLegacyPrompt === 'function'
            ? text(getImageThemeOrLegacyPrompt(event))
            : '';
        return {
            hex,
            imageMissing: !imageUrl,
            imageThemeOrPrompt,
            ready: Boolean(hex && !imageUrl && imageThemeOrPrompt),
        };
    }

    async function requestDirectImage(index, button) {
        const entry = Array.isArray(visibleEventEntries) ? visibleEventEntries[index] : null;
        const event = entry?.event;
        if (!event) return;
        const prerequisites = directImagePrerequisites(event);
        if (!prerequisites.ready) {
            pinRuntimeDetails('Image request is not ready: the event needs a HEX and image theme/prompt, and must not already have an image URL.', 'error');
            enhanceEventCards();
            return;
        }
        if (!apiAuthReady) {
            pinRuntimeDetails('Admin API auth is not ready.', 'error');
            return;
        }
        if (uiCommandInFlight || pendingDirectImageHexes.has(prerequisites.hex)) return;

        const title = text(event.summary || event.title) || `Event ${index + 1}`;
        pendingDirectImageHexes.add(prerequisites.hex);
        uiCommandInFlight = true;
        if (button) {
            button.disabled = true;
            button.textContent = 'Requesting image…';
        }
        refreshApiActionButtons();
        pinRuntimeDetails(`Requesting image for "${title}"…`, 'loading');

        try {
            const result = await sendScoutsCommand({
                realm: 'scouts',
                subject: { hex: prerequisites.hex },
                action: 'generateImage',
            });
            const requestId = typeof extractBackendRequestId === 'function' ? extractBackendRequestId(result) : '';
            const message = `Image requested for "${title}"${requestId ? ` · request ${requestId}` : ''}.`;
            pinRuntimeDetails(message, 'success');
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'success', 5000);
            if (button) button.textContent = 'Image requested';
            await pollQueueDepthSnapshots();
            setTimeout(() => {
                loadEvents({ silent: true });
            }, 2000);
            // Keep the shortcut guarded while the orchestration gets established.
            setTimeout(() => {
                pendingDirectImageHexes.delete(prerequisites.hex);
                enhanceEventCards();
            }, 120000);
        } catch (error) {
            pendingDirectImageHexes.delete(prerequisites.hex);
            const message = `Failed to request image for "${title}": ${error?.message || error}`;
            pinRuntimeDetails(message, 'error');
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'error', 7000);
            enhanceEventCards();
        } finally {
            uiCommandInFlight = false;
            refreshApiActionButtons();
        }
    }

    function enhanceEventCards() {
        const cards = document.querySelectorAll('#events-container .event-card[data-event-card-index]');
        cards.forEach((card) => {
            const index = Number(card.dataset.eventCardIndex);
            if (!Number.isInteger(index) || index < 0) return;
            const entry = Array.isArray(visibleEventEntries) ? visibleEventEntries[index] : null;
            const event = entry?.event;
            const actions = card.querySelector('.event-actions');
            if (!event || !actions) return;

            const existing = actions.querySelector('.event-direct-image-request');
            const prerequisites = directImagePrerequisites(event);
            if (!prerequisites.ready) {
                existing?.remove();
                if (!prerequisites.imageMissing && prerequisites.hex) pendingDirectImageHexes.delete(prerequisites.hex);
                return;
            }
            if (existing) {
                existing.disabled = !apiAuthReady || uiCommandInFlight || pendingDirectImageHexes.has(prerequisites.hex);
                if (pendingDirectImageHexes.has(prerequisites.hex)) existing.textContent = 'Image requested';
                return;
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-secondary requires-api event-direct-image-request';
            button.textContent = pendingDirectImageHexes.has(prerequisites.hex) ? 'Image requested' : 'Request Image';
            button.title = 'Image theme/prompt is already available. Generate the missing image without opening View Details.';
            button.disabled = !apiAuthReady || uiCommandInFlight || pendingDirectImageHexes.has(prerequisites.hex);
            button.addEventListener('click', () => requestDirectImage(index, button));

            const detailsButton = actions.querySelector('button');
            if (detailsButton?.nextSibling) actions.insertBefore(button, detailsButton.nextSibling);
            else actions.appendChild(button);
        });
    }

    function observeEventCards() {
        const container = document.getElementById('events-container');
        if (!container || cardObserver) return;
        cardObserver = new MutationObserver(() => enhanceEventCards());
        cardObserver.observe(container, { childList: true, subtree: true });
        enhanceEventCards();
    }

    function initialize() {
        retireAutoLambdaHeartbeat();
        clarifyPollingControls();
        ensureDlqSection();
        observeEventCards();
        document.getElementById('diagnostics-open')?.addEventListener('click', () => refreshDlqOverview(false));
        refreshDlqOverview(false);
    }

    document.addEventListener('DOMContentLoaded', () => {
        // admin-simplify builds the Diagnostics drawer in its own DOMContentLoaded
        // handler. Deferring one task ensures those canonical controls exist first.
        setTimeout(initialize, 0);
    });
})();
