function handleAdminNavigation(event) {
    event.preventDefault();
    var password = window.prompt('Enter the admin password');
    if (password === null) {
        return;
    }
    if (password === 'coldbath') {
        window.location.href = '/website/admin/index.html';
    } else {
        window.alert('Incorrect password');
    }
}

function attachAdminLinks(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-admin-link]').forEach(function(link) {
        if (link.dataset.adminReady === 'true') {
            return;
        }
        link.dataset.adminReady = 'true';
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
