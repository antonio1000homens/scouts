# Scouts Admin

The Admin page is a thin, same-origin client for event editing and review. It reads the published `agenda.json` and submits existing Scouts API commands; asynchronous work is tracked by the canonical Activity service.

## Normal workflow

- Use **Sync calendars & agenda** for an explicit calendar reconciliation.
- Use event cards to see date, section, visibility, approval, completeness, and any image.
- Open **View details** to save or regenerate metadata, generate an image, hide/unhide one occurrence, or approve shown changes.
- Use **Activity** for accepted, running, completed, and failed operations.
- Use **Operations** only for scheduled refresh, DLQ recovery, and technical diagnostics.

The browser does not run calendar reconciliation on page load, expose polling intervals, or use HEX polling controls. AWS/EventBridge scheduled refresh remains independent of the browser.

## Identity and visibility

Each published occurrence carries a server-owned opaque `occurrenceId`. Shared enrichment metadata is grouped by HEX, but Hide/Unhide commands are selected by `occurrenceId`; same-title occurrences therefore remain independently addressable. HEX and UID are shown only under Advanced diagnostics.

Visibility is occurrence-owned state. Shared metadata publication must preserve an occurrence's current visibility unless the request explicitly targets that `occurrenceId` with a visibility change. UI pending state is also action-scoped, so one accepted or slow operation must not disable unrelated event actions.

## Security and API

All requests use the same-origin Cloudflare admin proxy. The browser never contains the Lambda API key. Write acknowledgements have a finite timeout and are never automatically retried; after a timeout, check Activity before submitting again.

## Development

Serve the repository root with any static HTTP server and open `/website/admin/index.html`. The relevant browser modules are:

- `admin-script.js` — event state, rendering, and API compatibility helpers
- `admin-agenda-refresh.js` — manual calendar sync only
- `admin-activity-centre.js` — the single browser Activity poller
- `admin-diagnostics-enhancements.js` — Operations controls
- `admin-approval-workflow.js` — revision-safe approval flow
