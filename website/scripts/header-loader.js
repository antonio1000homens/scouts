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

function initMobileMenu() {
    var hamburgerMenu = document.querySelector('.hamburger-menu');
    var mainNav = document.querySelector('.main-nav');
    if (hamburgerMenu && mainNav) {
        hamburgerMenu.setAttribute('aria-expanded', 'false');
        hamburgerMenu.addEventListener('click', function() {
            mainNav.classList.toggle('active');
            hamburgerMenu.setAttribute('aria-expanded', mainNav.classList.contains('active'));
        });
    }
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
            initMobileMenu();
        });
});
