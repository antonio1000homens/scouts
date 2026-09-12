// Operational admin enhancements: explicit DLQ inspection/redrive, clear polling
// semantics, scheduled calendar refresh controls, and a direct Request Image action
// when an event already has the image-generation prerequisite metadata.

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
    let scheduledRefreshSettings = null;
    let scheduledRefreshBusy = false;

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

    function replaceAutoLambdaHeartbeat() {
        // The browser-based heartbeat is no longer responsible for periodic
        // refresh. Disable its persisted timer and replace the header control
        // with the durable AWS scheduled-refresh switch.
        if (typeof setAutoLambdaInvocationEnabled === 'function') {
            setAutoLambdaInvocationEnabled(false, true);
        }

        const oldLabel = document.querySelector('label[for="auto-lambda-toggle"]');
        const oldInterval = document.getElementById('auto-lambda-interval-seconds');
        oldInterval?.remove();

        if (oldLabel && !document.getElementById('scheduled-refresh-toggle')) {
            const label = document.createElement('label');
            label.className = oldLabel.className;
            label.htmlFor = 'scheduled-refresh-toggle';
            label.title = 'Enable or disable automatic EventBridge calendar/agenda refresh.';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'scheduled-refresh-toggle';
            input.disabled = true;
            input.addEventListener('change', () => setScheduledRefreshEnabled(input.checked));

            label.append(input, document.createTextNode(' Scheduled refresh'));
            oldLabel.replaceWith(label);
        } else {
            oldLabel?.remove();
        }
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

        if (!section.querySelector('#browser-notifications-toggle')) {
            const label = document.createElement('label');
            label.className = 'auto-invoke-header-label';
            label.htmlFor = 'browser-notifications-toggle';
            label.title = 'Show a native browser notification when the agenda changes.';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'browser-notifications-toggle';
            input.checked = typeof readBrowserNotificationsPreference === 'function'
                ? readBrowserNotificationsPreference()
                : false;
            input.addEventListener('change', () => {
                if (typeof setBrowserNotificationsEnabled === 'function') {
                    setBrowserNotificationsEnabled(input.checked);
                }
            });
            label.append(input, document.createTextNode(' Browser notifications'));
            interval?.insertAdjacentElement('afterend', label);
        }
        if (typeof updateBrowserNotificationsUi === 'function') updateBrowserNotificationsUi();

        if (!section.querySelector('.diagnostics-polling-help')) {
            const help = makeHelp('Status polling refreshes the canonical request lifecycle, queue counts and Step Functions status. It does not invoke workers, create requests or process queues, so it is safe to leave enabled.');
            help.classList.add('diagnostics-polling-help');
            section.appendChild(help);

            const retired = makeHelp('The old browser Auto Lambda heartbeat has been replaced by an AWS EventBridge scheduled calendar refresh. SQS event-source mappings and full-enrich Step Functions continue to process queued jobs independently.');
            retired.classList.add('diagnostics-polling-help');
            section.appendChild(retired);
        }
    }

    function ensureScheduledRefreshSection() {
        let section = document.getElementById('diagnostics-scheduled-refresh');
        if (section) return section;

        const pollingSection = document.getElementById('diagnostics-polling');
        if (!pollingSection) return null;

        section = document.createElement('section');
        section.id = 'diagnostics-scheduled-refresh';
        section.className = 'admin-diagnostics-section';
        section.innerHTML = `
            <h3>Scheduled calendar refresh</h3>
            <p class="admin-diagnostics-section-description">EventBridge refreshes all configured calendars and rebuilds agenda state on an AWS-owned schedule.</p>
            <div id="diagnostics-scheduled-refresh-content"><p>Waiting for admin API authentication…</p></div>
            <div class="dlq-actions">
                <button type="button" class="btn btn-secondary requires-api" id="scheduled-refresh-run-now">Run refresh now</button>
                <button type="button" class="btn btn-secondary requires-api" id="scheduled-refresh-status-refresh">Refresh schedule status</button>
            </div>
            <p class="diagnostics-help">Scheduled runs are discovery-only by default: they refresh calendars/agenda but publish 0 new enrichment jobs. Existing queued jobs continue automatically through SQS and Step Functions.</p>
            <p class="diagnostics-help">Turning scheduled refresh off is durable. EventBridge still invokes the lightweight guard on its cadence, but the Lambda exits before calendar downloads, agenda refresh or queue publication.</p>
        `;
        pollingSection.insertAdjacentElement('afterend', section);
        section.querySelector('#scheduled-refresh-run-now')?.addEventListener('click', () => runScheduledRefreshNow());
        section.querySelector('#scheduled-refresh-status-refresh')?.addEventListener('click', () => refreshScheduledRefreshStatus(true));
        return section;
    }

    function renderScheduledRefreshControls(statusMessage = '') {
        const toggle = document.getElementById('scheduled-refresh-toggle');
        if (toggle) {
            toggle.checked = scheduledRefreshSettings?.enabled === true;
            toggle.disabled = scheduledRefreshBusy || !apiAuthReady || !scheduledRefreshSettings;
            toggle.title = scheduledRefreshSettings
                ? `${scheduledRefreshSettings.enabled ? 'Enabled' : 'Disabled'} · ${scheduledRefreshSettings.scheduleExpression || 'schedule unavailable'}`
                : 'Scheduled refresh status has not loaded yet.';
        }

        const target = document.getElementById('diagnostics-scheduled-refresh-content');
        if (!target) return;
        target.replaceChildren();

        if (statusMessage) {
            const status = document.createElement('p');
            status.className = 'dlq-action-status info';
            status.textContent = statusMessage;
            target.appendChild(status);
        }

        if (!scheduledRefreshSettings) {
            if (!statusMessage) {
                const waiting = document.createElement('p');
                waiting.textContent = apiAuthReady ? 'Scheduled refresh status not loaded.' : 'Waiting for admin API authentication…';
                target.appendChild(waiting);
            }
            return;
        }

        renderDefinition(target, 'State', scheduledRefreshSettings.enabled ? 'Enabled' : 'Disabled');
        renderDefinition(target, 'AWS cadence', scheduledRefreshSettings.scheduleExpression);
        renderDefinition(target, 'New enrichment jobs/run', scheduledRefreshSettings.maxQueuePublishesPerRun);
        renderDefinition(target, 'Configuration source', scheduledRefreshSettings.configSource);
        renderDefinition(target, 'Last changed', formatDateTime(scheduledRefreshSettings.updatedAt));
        renderDefinition(target, 'Changed by', scheduledRefreshSettings.updatedBy);
    }

    async function refreshScheduledRefreshStatus(showStatus = false) {
        if (!apiAuthReady) {
            renderScheduledRefreshControls();
            return;
        }
        if (showStatus) renderScheduledRefreshControls('Refreshing scheduled refresh status…');
        try {
            const result = await sendScoutsCommand({ realm: 'runtime', subject: 'schedule', action: 'status' });
            if (!result?.schedule) throw new Error('Scheduled refresh status payload missing');
            scheduledRefreshSettings = result.schedule;
            renderScheduledRefreshControls();
        } catch (error) {
            renderScheduledRefreshControls(`Failed to load scheduled refresh status: ${error?.message || error}`);
        }
    }

    async function setScheduledRefreshEnabled(enabled) {
        if (!apiAuthReady || scheduledRefreshBusy) {
            renderScheduledRefreshControls();
            return;
        }
        scheduledRefreshBusy = true;
        renderScheduledRefreshControls(`${enabled ? 'Enabling' : 'Disabling'} scheduled refresh…`);
        try {
            const result = await sendScoutsCommand({
                realm: 'runtime',
                subject: 'schedule',
                action: enabled ? 'enable' : 'disable',
            });
            if (!result?.schedule) throw new Error('Scheduled refresh update payload missing');
            scheduledRefreshSettings = result.schedule;
            const message = `Scheduled refresh ${scheduledRefreshSettings.enabled ? 'enabled' : 'disabled'}.`;
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'success', 5000);
        } catch (error) {
            const message = `Failed to ${enabled ? 'enable' : 'disable'} scheduled refresh: ${error?.message || error}`;
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'error', 7000);
        } finally {
            scheduledRefreshBusy = false;
            await refreshScheduledRefreshStatus(false);
        }
    }

    async function runScheduledRefreshNow() {
        if (!apiAuthReady || scheduledRefreshBusy) return;
        scheduledRefreshBusy = true;
        renderScheduledRefreshControls('Refreshing all calendars now…');
        try {
            const result = await sendScoutsCommand({
                realm: 'scouts',
                subject: 'calendars',
                action: 'refreshAllCalendars',
                calendar: 'all',
                maxEvents: 0,
            });
            const summary = typeof formatRuntimeSummary === 'function'
                ? formatRuntimeSummary({ realm: 'scouts', subject: 'calendars' }, result)
                : '';
            const message = summary || 'All calendars and agenda refreshed. No new enrichment jobs were published by this manual scheduled-style run.';
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'success', 6000);
            if (typeof loadEvents === 'function') setTimeout(() => loadEvents({ silent: true }), 1500);
        } catch (error) {
            const message = `Scheduled-style refresh failed: ${error?.message || error}`;
            if (typeof showAdminNotification === 'function') showAdminNotification(message, 'error', 7000);
        } finally {
            scheduledRefreshBusy = false;
            await refreshScheduledRefreshStatus(false);
            if (typeof pollQueueDepthSnapshots === 'function') pollQueueDepthSnapshots();
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
        if (!apiAuthReady) {
            if (showStatus) {
                DLQ_NAMES.forEach((name) => dlqActionState.set(name, {
                    message: 'Waiting for admin API authentication…',
                    tone: 'info',
                }));
                renderDlqDiagnostics();
            }
            return;
        }
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
        if (!apiAuthReady) return;
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
        if (!apiAuthReady) return;
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
            if (button.textContent !== 'Requesting image…') button.textContent = 'Requesting image…';
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
            if (button && button.textContent !== 'Image requested') button.textContent = 'Image requested';
            if (typeof pollQueueDepthSnapshots === 'function') {
                void Promise.resolve(pollQueueDepthSnapshots()).catch(() => {});
            }
            setTimeout(() => {
                loadEvents({ silent: true });
            }, 2000);
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
            // Generic API button refresh enables every `.requires-api` control.
            // Reapply the direct-image pending state immediately so a request that
            // has already been accepted cannot look clickable while its duplicate
            // guard still rejects clicks.
            enhanceEventCards();
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
            const pending = pendingDirectImageHexes.has(prerequisites.hex);
            if (existing) {
                const shouldDisable = !apiAuthReady || uiCommandInFlight || pending;
                const desiredLabel = pending ? 'Image requested' : 'Request Image';
                if (existing.disabled !== shouldDisable) existing.disabled = shouldDisable;
                if (existing.textContent !== desiredLabel) existing.textContent = desiredLabel;
                return;
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-secondary requires-api event-direct-image-request';
            button.textContent = pending ? 'Image requested' : 'Request Image';
            button.title = 'Image theme/prompt is already available. Generate the missing image without opening View Details.';
            button.disabled = !apiAuthReady || uiCommandInFlight || pending;
            button.addEventListener('click', () => requestDirectImage(index, button));

            const detailsButton = actions.querySelector('button');
            if (detailsButton?.nextSibling) actions.insertBefore(button, detailsButton.nextSibling);
            else actions.appendChild(button);
        });
    }

    function installEventCardRenderHook() {
        const originalRenderEvents = window.renderEvents;
        if (typeof originalRenderEvents !== 'function' || originalRenderEvents.__scoutsDiagnosticsEnhanced) return;
        function diagnosticsAwareRender(...args) {
            const result = originalRenderEvents.apply(this, args);
            enhanceEventCards();
            return result;
        }
        diagnosticsAwareRender.__scoutsDiagnosticsEnhanced = true;
        window.renderEvents = diagnosticsAwareRender;
    }

    function refreshOperationalStatusWhenReady(attempt = 0) {
        if (apiAuthReady) {
            refreshDlqOverview(false);
            refreshScheduledRefreshStatus(false);
            enhanceEventCards();
            return;
        }
        renderScheduledRefreshControls();
        if (attempt < 60) {
            setTimeout(() => refreshOperationalStatusWhenReady(attempt + 1), 250);
        }
    }

    function initialize() {
        replaceAutoLambdaHeartbeat();
        clarifyPollingControls();
        ensureScheduledRefreshSection();
        ensureDlqSection();
        installEventCardRenderHook();
        enhanceEventCards();
        document.getElementById('diagnostics-open')?.addEventListener('click', () => {
            if (!apiAuthReady) return;
            refreshDlqOverview(false);
            refreshScheduledRefreshStatus(false);
        });
        refreshOperationalStatusWhenReady();
    }

    document.addEventListener('DOMContentLoaded', () => {
        // admin-simplify builds the Diagnostics drawer in its own DOMContentLoaded
        // handler. Deferring one task ensures those canonical controls exist first.
        setTimeout(initialize, 0);
    });
})();