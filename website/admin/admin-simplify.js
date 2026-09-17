// Admin v2 shell owner: keeps the primary event workflow small and provides the
// Operations drawer used by scheduled-refresh and recovery controls.
(function () {
    function buildOperationsDrawer() {
        if (document.getElementById('admin-diagnostics-drawer')) return;
        const drawer = document.createElement('aside');
        drawer.id = 'admin-diagnostics-drawer';
        drawer.className = 'admin-diagnostics-drawer';
        drawer.setAttribute('aria-hidden', 'true');
        drawer.innerHTML = `
            <div class="admin-diagnostics-header">
                <div>
                    <h2>Operations</h2>
                    <p>Scheduled refresh and recovery controls.</p>
                </div>
                <button type="button" class="btn btn-secondary" id="diagnostics-close">Close</button>
            </div>
            <div class="admin-diagnostics-body"></div>
        `;
        document.body.appendChild(drawer);

        const button = document.createElement('button');
        button.id = 'diagnostics-open';
        button.type = 'button';
        button.className = 'btn btn-secondary btn-header diagnostics-open';
        button.textContent = 'Operations';
        document.getElementById('api-ready-indicator')?.insertAdjacentElement('afterend', button);

        const close = () => {
            drawer.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
        };
        button.addEventListener('click', () => {
            drawer.classList.add('open');
            drawer.setAttribute('aria-hidden', 'false');
        });
        drawer.querySelector('#diagnostics-close')?.addEventListener('click', close);
    }

    function removeLegacyOperatorUi() {
        document.querySelector('.viewer-menu-shell')?.remove();
        ['agenda-viewer', 'events-json-viewer', 'scouts-config-viewer', 'runtime-json-viewer'].forEach((id) => document.getElementById(id)?.remove());
        document.querySelector('.requests-sidebar')?.remove();
        document.querySelector('.admin-runtime-footer')?.remove();
        document.getElementById('admin-primary-summary')?.remove();
    }

    document.addEventListener('DOMContentLoaded', () => {
        try {
            setAutoLambdaInvocationEnabled(false, false);
            setStatusPollingEnabled(false, false);
            buildOperationsDrawer();
            removeLegacyOperatorUi();
            document.body.classList.add('admin-simplify-ready');
        } catch (error) {
            console.error('Failed to initialize Admin v2 shell', error);
            document.body.classList.remove('admin-simplify-ready');
        }
    });
})();
