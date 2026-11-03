// Operations-only admin enhancements: explicit DLQ inspection/redrive and
// scheduled calendar refresh controls. Request lifecycle polling is owned by
// admin-activity-centre.js and event actions are rendered by admin-script.js.

(function () {
    const DLQ_NAMES = ['scoutsRequestsDLQ', 'scoutsProcessingDLQ'];
    const DLQ_SOURCE_LABELS = {
        scoutsRequestsDLQ: 'scoutsRequests',
        scoutsProcessingDLQ: 'scoutsProcessing',
    };
    const dlqSamples = new Map();
    const dlqActionState = new Map();
    let latestDlqActivity = null;
    let latestQueueStatus = null;
    let queueStatusBusy = false;
    let latestDeferredRefreshStatus = null;
    let deferredRefreshBusy = false;
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
        if (typeof setAutoLambdaInvocationEnabled === 'function') setAutoLambdaInvocationEnabled(false, false);
        document.querySelector('label[for="auto-lambda-toggle"]')?.remove();
        document.getElementById('auto-lambda-interval-seconds')?.remove();
    }

    function operationsBody() {
        return document.querySelector('#admin-diagnostics-drawer .admin-diagnostics-body');
    }

    function ensureScheduledRefreshSection() {
        let section = document.getElementById('diagnostics-scheduled-refresh');
        if (section) return section;

        const body = operationsBody();
        if (!body) return null;

        section = document.createElement('section');
        section.id = 'diagnostics-scheduled-refresh';
        section.className = 'admin-diagnostics-section';
        section.innerHTML = `
            <h3>Scheduled calendar refresh</h3>
            <p class="admin-diagnostics-section-description">EventBridge refreshes all configured calendars and rebuilds agenda state on an AWS-owned schedule.</p>
            <label class="request-archive-toggle" for="scheduled-refresh-toggle">
                <input type="checkbox" id="scheduled-refresh-toggle" disabled>
                Scheduled refresh enabled
            </label>
            <div id="diagnostics-scheduled-refresh-content"><p>Waiting for admin API authentication…</p></div>
            <div class="dlq-actions">
                <button type="button" class="btn btn-secondary requires-api" id="scheduled-refresh-run-now">Run refresh now</button>
                <button type="button" class="btn btn-secondary requires-api" id="scheduled-refresh-status-refresh">Refresh schedule status</button>
            </div>
            <p class="diagnostics-help">Scheduled runs publish 0 immediate enrichment jobs by default. If the optional deferred outbox is enabled, excess eligible work is retained for bounded scheduled dispatch; existing queued jobs continue through SQS and Step Functions.</p>
            <p class="diagnostics-help">Turning scheduled refresh off is durable. EventBridge still invokes the lightweight guard on its cadence, but the Lambda exits before calendar downloads, agenda refresh or queue publication.</p>
        `;
        body.appendChild(section);
        section.querySelector('#scheduled-refresh-toggle')?.addEventListener('change', (event) => setScheduledRefreshEnabled(event.target.checked));
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
            const result = await sendScoutsReadCommand({ realm: 'runtime', subject: 'schedule', action: 'status' });
            if (!result?.schedule) throw new Error('Scheduled refresh status payload missing');
            scheduledRefreshSettings = result.schedule;
            renderScheduledRefreshControls();
        } catch (error) {
            renderScheduledRefreshControls(`Failed to load scheduled refresh status: ${error?.message || error}`);
        }
    }

    function ensureLiveQueueStatusSection() {
        let section = document.getElementById('diagnostics-live-queues');
        if (section) return section;
        const body = operationsBody();
        if (!body) return null;

        section = document.createElement('section');
        section.id = 'diagnostics-live-queues';
        section.className = 'admin-diagnostics-section';
        section.innerHTML = `
            <h3>Live queue depth</h3>
            <p class="admin-diagnostics-section-description">Counts come from on-demand SQS GetQueueAttributes reads. They are approximate and do not inspect or change messages.</p>
            <div class="dlq-toolbar"><button type="button" class="btn btn-secondary requires-api" id="live-queue-refresh">Refresh queue counts</button></div>
            <div id="diagnostics-live-queues-content"><p>Queue status not loaded yet.</p></div>
        `;
        const scheduled = document.getElementById('diagnostics-scheduled-refresh');
        if (scheduled) scheduled.insertAdjacentElement('afterend', section);
        else body.appendChild(section);
        section.querySelector('#live-queue-refresh')?.addEventListener('click', () => refreshLiveQueueStatus(true));
        return section;
    }

    function renderLiveQueueStatus(statusMessage = '') {
        const target = document.getElementById('diagnostics-live-queues-content');
        const button = document.getElementById('live-queue-refresh');
        if (button) {
            button.disabled = queueStatusBusy || !apiAuthReady;
            button.textContent = queueStatusBusy ? 'Refreshing…' : 'Refresh queue counts';
        }
        if (!target) return;
        target.replaceChildren();
        if (statusMessage) {
            const status = document.createElement('p');
            status.className = 'dlq-action-status info';
            status.textContent = statusMessage;
            target.appendChild(status);
        }
        const queues = Array.isArray(latestQueueStatus?.queues) ? latestQueueStatus.queues : [];
        if (!queues.length) {
            if (!statusMessage) {
                const waiting = document.createElement('p');
                waiting.textContent = apiAuthReady ? 'Queue status not loaded yet.' : 'Waiting for admin API authentication…';
                target.appendChild(waiting);
            }
            return;
        }
        renderDefinition(target, 'Last sampled', formatDateTime(latestQueueStatus.sampledAt));
        for (const queue of queues) {
            const panel = document.createElement('article');
            panel.className = 'dlq-panel';
            const heading = document.createElement('div');
            heading.className = 'dlq-panel-header';
            const name = document.createElement('strong');
            name.textContent = queue.name || 'SQS queue';
            const count = document.createElement('span');
            count.className = 'dlq-count';
            count.textContent = queue.ok === false ? 'unavailable' : `${queue.visible ?? 'n/a'} visible`;
            heading.append(name, count);
            panel.appendChild(heading);
            if (queue.error) renderDefinition(panel, 'Read error', queue.error);
            renderDefinition(panel, 'In flight / delayed', `${queue.inFlight ?? 'n/a'} / ${queue.delayed ?? 'n/a'}`);
            renderDefinition(panel, 'Oldest message age', queue.oldestMessageAgeSeconds === null || queue.oldestMessageAgeSeconds === undefined
                ? 'n/a'
                : `${queue.oldestMessageAgeSeconds} seconds`);
            if (queue.oldestMessageAgeAt) renderDefinition(panel, 'Age metric sample', formatDateTime(queue.oldestMessageAgeAt));
            if (queue.oldestMessageAgeStatus === 'unavailable') renderDefinition(panel, 'Age metric error', queue.oldestMessageAgeError || 'unavailable');
            target.appendChild(panel);
        }
        if (latestQueueStatus.note) {
            const note = document.createElement('p');
            note.className = 'diagnostics-help';
            note.textContent = latestQueueStatus.note;
            target.appendChild(note);
        }
    }

    async function refreshLiveQueueStatus(showStatus = false) {
        if (!apiAuthReady || queueStatusBusy) {
            renderLiveQueueStatus();
            return latestQueueStatus;
        }
        queueStatusBusy = true;
        renderLiveQueueStatus(showStatus ? 'Reading approximate SQS queue attributes…' : '');
        try {
            const result = await sendScoutsReadCommand({ realm: 'runtime', subject: 'queues', action: 'status' });
            if (!result?.queueStatus || !Array.isArray(result.queueStatus.queues)) {
                throw new Error('Live queue status payload missing');
            }
            latestQueueStatus = result.queueStatus;
            return latestQueueStatus;
        } catch (error) {
            renderLiveQueueStatus(`Live queue status unavailable: ${error?.message || error}`);
            return null;
        } finally {
            queueStatusBusy = false;
            renderLiveQueueStatus();
        }
    }

    function ensureDeferredRefreshStatusSection() {
        let section = document.getElementById('diagnostics-deferred-refresh');
        if (section) return section;
        const body = operationsBody();
        if (!body) return null;
        section = document.createElement('section');
        section.id = 'diagnostics-deferred-refresh';
        section.className = 'admin-diagnostics-section';
        section.innerHTML = `
            <h3>Deferred enrichment work</h3>
            <p class="admin-diagnostics-section-description">Bounded read-only sample of scheduled work waiting for dispatch, retry, expiry, or operator attention.</p>
            <div class="dlq-toolbar"><button type="button" class="btn btn-secondary requires-api" id="deferred-refresh-status-button">Refresh deferred work status</button></div>
            <div id="diagnostics-deferred-refresh-content"><p>Deferred work status not loaded yet.</p></div>
        `;
        const queues = document.getElementById('diagnostics-live-queues');
        if (queues) queues.insertAdjacentElement('afterend', section);
        else body.appendChild(section);
        section.querySelector('#deferred-refresh-status-button')?.addEventListener('click', () => refreshDeferredRefreshStatus(true));
        return section;
    }

    function renderDeferredRefreshStatus(statusMessage = '') {
        const target = document.getElementById('diagnostics-deferred-refresh-content');
        const button = document.getElementById('deferred-refresh-status-button');
        if (button) {
            button.disabled = deferredRefreshBusy || !apiAuthReady;
            button.textContent = deferredRefreshBusy ? 'Refreshing…' : 'Refresh deferred work status';
        }
        if (!target) return;
        target.replaceChildren();
        if (statusMessage) {
            const status = document.createElement('p');
            status.className = 'dlq-action-status info';
            status.textContent = statusMessage;
            target.appendChild(status);
        }
        if (!latestDeferredRefreshStatus) {
            if (!statusMessage) target.appendChild(makeHelp(apiAuthReady ? 'Deferred work status not loaded yet.' : 'Waiting for admin API authentication…'));
            return;
        }
        if (latestDeferredRefreshStatus.status === 'disabled') {
            target.appendChild(makeHelp('The deferred refresh outbox is not enabled in this deployment.'));
            return;
        }
        const states = latestDeferredRefreshStatus.deferredRefresh?.states || {};
        renderDefinition(target, 'Ready items sampled', `${states.ready?.sampledItems ?? 0}${states.ready?.hasMore ? '+' : ''}`);
        renderDefinition(target, 'Due ready items sampled', `${states.ready?.dueSampledItems ?? 0}${states.ready?.dueHasMore ? '+' : ''}`);
        renderDefinition(target, 'Oldest ready item', formatDateTime(states.ready?.oldestReadyAt));
        renderDefinition(target, 'Retries in sample', states.ready?.sampledRetryCount ?? 0);
        renderDefinition(target, 'Leased items sampled', `${states.leased?.sampledItems ?? 0}${states.leased?.hasMore ? '+' : ''}`);
        renderDefinition(target, 'Expired leases sampled', `${states.leased?.dueSampledItems ?? 0}${states.leased?.dueHasMore ? '+' : ''}`);
        renderDefinition(target, 'Needs attention sampled', `${states.needs_attention?.sampledItems ?? 0}${states.needs_attention?.hasMore ? '+' : ''}`);
        renderDefinition(target, 'Expired sampled', `${states.expired?.sampledItems ?? 0}${states.expired?.hasMore ? '+' : ''}`);
        const attentionSamples = Array.isArray(states.needs_attention?.actionableSamples) ? states.needs_attention.actionableSamples : [];
        if (attentionSamples.length) {
            const list = document.createElement('ul');
            list.className = 'diagnostics-help';
            for (const item of attentionSamples) {
                const row = document.createElement('li');
                row.textContent = `${item.hex || 'unknown HEX'} · ${item.stage || 'unknown stage'} · ${item.reason || 'retry limit reached'}`;
                list.appendChild(row);
            }
            target.appendChild(list);
        }
        target.appendChild(makeHelp(`Each state is capped at ${latestDeferredRefreshStatus.deferredRefresh?.sampleLimitPerState ?? 'a bounded'} records; a plus sign means more records exist.`));
    }

    async function refreshDeferredRefreshStatus(showStatus = false) {
        if (!apiAuthReady || deferredRefreshBusy) {
            renderDeferredRefreshStatus();
            return latestDeferredRefreshStatus;
        }
        deferredRefreshBusy = true;
        renderDeferredRefreshStatus(showStatus ? 'Reading a bounded outbox status sample…' : '');
        try {
            latestDeferredRefreshStatus = await sendScoutsReadCommand({ realm: 'runtime', subject: 'deferredRefresh', action: 'status' });
            if (!latestDeferredRefreshStatus || !['ok', 'disabled'].includes(latestDeferredRefreshStatus.status)) {
                throw new Error('Deferred refresh status payload missing');
            }
            return latestDeferredRefreshStatus;
        } catch (error) {
            renderDeferredRefreshStatus(`Deferred refresh status unavailable: ${error?.message || error}`);
            return null;
        } finally {
            deferredRefreshBusy = false;
            renderDeferredRefreshStatus();
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

        const body = operationsBody();
        if (!body) return null;

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
        const scheduled = document.getElementById('diagnostics-scheduled-refresh');
        if (scheduled) scheduled.insertAdjacentElement('afterend', section);
        else body.appendChild(section);
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
            const status = await refreshLiveQueueStatus(false);
            if (!status) throw new Error('Live queue status unavailable');
            latestDlqActivity = {
                queueHealth: Object.fromEntries((status.queues || []).map((queue) => [queue.name, queue])),
            };
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
                        oldestMessageAgeSeconds: result.dlq.oldestMessageAgeSeconds,
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

    function refreshOperationalStatusWhenReady(attempt = 0) {
        if (apiAuthReady) {
            refreshDlqOverview(false);
            refreshScheduledRefreshStatus(false);
            refreshDeferredRefreshStatus(false);
            return;
        }
        renderScheduledRefreshControls();
        if (attempt < 60) {
            setTimeout(() => refreshOperationalStatusWhenReady(attempt + 1), 250);
        }
    }

    function initialize() {
        replaceAutoLambdaHeartbeat();
        ensureScheduledRefreshSection();
        ensureLiveQueueStatusSection();
        ensureDeferredRefreshStatusSection();
        ensureDlqSection();
        document.getElementById('diagnostics-open')?.addEventListener('click', () => {
            if (!apiAuthReady) return;
            refreshDlqOverview(false);
            refreshScheduledRefreshStatus(false);
            refreshDeferredRefreshStatus(false);
        });
        refreshOperationalStatusWhenReady();
    }

    document.addEventListener('DOMContentLoaded', () => {
        // admin-simplify builds the Operations drawer in its own DOMContentLoaded
        // handler. Deferring one task ensures those controls exist first.
        setTimeout(initialize, 0);
    });
})();
