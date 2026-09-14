// Manual calendar/agenda synchronisation and metadata classification.
// Browser startup must remain read-only; durable scheduled refresh is owned by AWS.
(function () {
    window.getMissingMetadataFields = function (event) {
        const missing = [];
        if (!hasText(getAIPrompt(event))) missing.push('Tagline');
        if (!hasText(getImageThemeOrLegacyPrompt(event))) missing.push('Image Theme');
        if (!hasRelativeImageUrl(event)) missing.push('Image URL');
        return missing;
    };

    function reconciliationPayload() {
        return {
            realm: 'scouts',
            subject: 'calendars',
            action: 'refreshAllCalendars',
            calendar: 'all',
        };
    }

    window.refreshLambda = async function refreshLambda() {
        if (!apiAuthReady) {
            updateGlobalRefreshStatus('Admin API auth not ready', 'error');
            return null;
        }
        const button = document.getElementById('refresh-button');
        const status = document.getElementById('refresh-status');
        if (button) { button.disabled = true; button.textContent = 'Syncing…'; }
        if (status) { status.textContent = 'Syncing calendars & agenda…'; status.className = 'refresh-status loading'; }
        try {
            const result = await sendScoutsCommand(reconciliationPayload());
            updateRuntimePanelsFromResult(result);
            await loadEvents({ silent: true, notifyOnAgendaChanges: true, onlyIfChanged: false, notificationSource: 'Manual calendar sync' });
            if (status) { status.textContent = 'Calendars & agenda synchronised'; status.className = 'refresh-status success'; }
            return result;
        } catch (error) {
            if (status) { status.textContent = `Calendar sync failed: ${error.message}`; status.className = 'refresh-status error'; }
            return null;
        } finally {
            if (button) { button.disabled = !apiAuthReady; button.textContent = 'Sync calendars & agenda'; }
        }
    };

    // Keep named legacy hooks harmless for cached markup. They never reconcile or schedule.
    window.toggleAgendaAutoRefresh = () => {};
    window.updateAgendaAutoRefreshInterval = () => {};

    document.addEventListener('DOMContentLoaded', () => {
        const refreshButton = document.getElementById('refresh-button');
        if (refreshButton) {
            refreshButton.textContent = 'Sync calendars & agenda';
            refreshButton.title = 'Synchronise calendar feeds and the agenda now.';
        }
        document.getElementById('refresh-action')?.remove();
        document.getElementById('agenda-auto-refresh-toggle')?.closest('label')?.remove();
        document.getElementById('agenda-auto-refresh-interval-seconds')?.remove();
        document.getElementById('agenda-auto-refresh-status')?.remove();
    });
})();
