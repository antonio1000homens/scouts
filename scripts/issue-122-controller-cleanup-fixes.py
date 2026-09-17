from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 occurrence, got {count}')
    return text.replace(old, new, 1)


# The wrapper-removal pass intentionally removes the wrapper block, but
# refreshApprovedPresentation lived inside that block in the legacy file. Restore
# the behavior as an ordinary helper owned by the approval controller.
path = Path('website/admin/admin-approval-workflow.js')
text = path.read_text()
helper_anchor = "    async function issue91ApproveEvent(eventIndex, fromModal = false, action = 'approve', button = null) {"
refresh_helper = '''    function refreshApprovedPresentation(entry, fromModal = false) {
        const approvedHex = typeof getEventHex === 'function'
            ? String(getEventHex(entry?.event) || '').trim().toLowerCase()
            : '';

        if (typeof updateEventsCount === 'function') {
            updateEventsCount(
                uniqueEventEntries.length,
                eventsData.length,
                uniqueEventEntries.filter((candidate) => isEntryHidden(candidate)).length,
                uniqueEventEntries.filter((candidate) => isEntryComplete(candidate)).length,
            );
        }
        if (typeof updateSidebarUi === 'function') updateSidebarUi();
        if (typeof renderEvents === 'function') renderEvents();

        if (!fromModal) return;
        const refreshedIndex = approvedHex && Array.isArray(visibleEventEntries)
            ? visibleEventEntries.findIndex((candidate) => {
                return String(getEventHex(candidate?.event) || '').trim().toLowerCase() === approvedHex;
            })
            : -1;
        if (refreshedIndex >= 0 && typeof updateModalContent === 'function') {
            currentEventIndex = refreshedIndex;
            updateModalContent(refreshedIndex);
            return;
        }
        if (typeof closeUploadModal === 'function') closeUploadModal();
    }

'''
text = replace_once(text, helper_anchor, refresh_helper + helper_anchor, 'restore approval presentation helper')
text = text.replace(
    '// This controller deliberately loads after admin-script.js and replaces only the\n'
    '// approval action. The legacy handler remains available during deployment\n'
    '// rollback, while all normal approval clicks use the revisioned backend contract.\n',
    '// This controller owns the revisioned approval workflow behind an explicit\n'
    '// controller contract. admin-script.js keeps the stable UI entry point.\n',
)
path.write_text(text)

# Update the old refreshLambda unit test: the stable entry point now delegates to
# the agenda controller, whose implementation remains the manual calendar sync.
path = Path('tests/issue-39-admin-actions.test.mjs')
text = path.read_text()
old = '''test('admin agenda refresh publishes the selected enrichment count', async () => {
  const { sandbox, sent } = actionSandbox();
  await invokeAdminFunction('refreshLambda', ['refreshAgenda'], sandbox);
  assert.deepEqual(sent, [{
    realm: 'scouts',
    subject: 'agenda',
    action: 5,
    maxEvents: 5,
  }]);
});'''
new = '''test('admin agenda refresh delegates to the manual agenda controller', async () => {
  const calls = [];
  const { sandbox } = actionSandbox({
    window: {
      adminAgendaController: {
        refresh: async (...args) => { calls.push(args); return { ok: true }; },
      },
    },
  });
  await invokeAdminFunction('refreshLambda', ['refreshAgenda'], sandbox);
  assert.deepEqual(calls, [['refreshAgenda']]);
});'''
text = replace_once(text, old, new, 'refreshLambda test')
path.write_text(text)

# Tighten the architectural assertion so equality checks (===) are not mistaken
# for assignments. Only single-equals replacements are prohibited.
path = Path('tests/issue-122-controller-ownership.test.mjs')
text = path.read_text()
text = replace_once(
    text,
    r"/window\.(renderEvents|openUploadModal|updateModalContent|approveEvent|refreshLambda|sendScoutsCommand)\s*=/",
    r"/window\.(renderEvents|openUploadModal|updateModalContent|approveEvent|refreshLambda|sendScoutsCommand)\s*=(?!=)/",
    'assignment assertion',
)
path.write_text(text)

# Update stale comments now that this file is Operations-only.
path = Path('website/admin/admin-diagnostics-enhancements.js')
text = path.read_text()
text = text.replace(
    '// Operational admin enhancements: explicit DLQ inspection/redrive, clear polling\n'
    '// semantics, scheduled calendar refresh controls, and a direct Request Image action\n'
    '// when an event already has the image-generation prerequisite metadata.\n',
    '// Operations-only admin enhancements: explicit DLQ inspection/redrive and\n'
    '// scheduled calendar refresh controls. Request lifecycle polling is owned by\n'
    '// admin-activity-centre.js and event actions are rendered by admin-script.js.\n',
)
text = text.replace(
    '// admin-simplify builds the Diagnostics drawer in its own DOMContentLoaded\n'
    '// handler. Deferring one task ensures those canonical controls exist first.\n',
    '// admin-simplify builds the Operations drawer in its own DOMContentLoaded\n'
    '// handler. Deferring one task ensures those controls exist first.\n',
)
path.write_text(text)
