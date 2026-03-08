const HEADER_LOADER_SCRIPT_URL = new URL(
    document.currentScript?.src || 'header-loader.js',
    window.location.href
);
const WEBSITE_BASE_URL = new URL('..', HEADER_LOADER_SCRIPT_URL);
const ADMIN_INDEX_URL = new URL('admin/index.html', WEBSITE_BASE_URL);
const HEADER_HTML_URL = new URL('shared/header.html', WEBSITE_BASE_URL);
const WEBSITE_BASE_PATH = WEBSITE_BASE_URL.pathname;

function rewriteWebsiteLinks(root) {
    (root || document).querySelectorAll('a[href^="/website/"]').forEach(function(link) {
        const href = link.getAttribute('href');
        if (!href) {
            return;
        }
        link.setAttribute('href', `${WEBSITE_BASE_PATH}${href.slice('/website/'.length)}`);
    });
}

function handleAdminNavigation(event) {
    event.preventDefault();
    window.open(ADMIN_INDEX_URL.href, '_blank', 'noopener,noreferrer');
}

function attachAdminLinks(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-admin-link]').forEach(function(link) {
        if (link.dataset.adminReady === 'true') {
            return;
        }
        link.dataset.adminReady = 'true';
        link.setAttribute('href', ADMIN_INDEX_URL.href);
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
    fetch(HEADER_HTML_URL.href)
        .then(response => response.text())
        .then(data => {
            var placeholder = document.getElementById('header-placeholder');
            if (!placeholder) {
                return;
            }
            placeholder.innerHTML = data;
            rewriteWebsiteLinks(placeholder);
            attachAdminLinks(placeholder);
            initMobileMenu();
        });
});
