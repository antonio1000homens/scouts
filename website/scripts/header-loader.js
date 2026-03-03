function handleAdminNavigation(event) {
    event.preventDefault();
    window.open('/website/admin/index.html', '_blank', 'noopener,noreferrer');
}

function attachAdminLinks(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-admin-link]').forEach(function(link) {
        if (link.dataset.adminReady === 'true') {
            return;
        }
        link.dataset.adminReady = 'true';
        link.setAttribute('href', '/website/admin/index.html');
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.addEventListener('click', handleAdminNavigation);
    });
}

document.addEventListener("DOMContentLoaded", function() {
    attachAdminLinks(document);
    fetch('/website/shared/header.html')
        .then(response => response.text())
        .then(data => {
            var placeholder = document.getElementById('header-placeholder');
            if (!placeholder) {
                return;
            }
            placeholder.innerHTML = data;
            attachAdminLinks(placeholder);
        });
});
