const FOOTER_LOADER_SCRIPT_URL = new URL(
    document.currentScript?.src || 'footer-loader.js',
    window.location.href
);
const FOOTER_WEBSITE_BASE_URL = new URL('..', FOOTER_LOADER_SCRIPT_URL);
const FOOTER_WEBSITE_BASE_PATH = FOOTER_WEBSITE_BASE_URL.pathname;

function rewriteWebsiteLinks(root) {
    (root || document).querySelectorAll('a[href^="/website/"]').forEach(function(link) {
        const href = link.getAttribute('href');
        if (!href) {
            return;
        }
        link.setAttribute('href', `${FOOTER_WEBSITE_BASE_PATH}${href.slice('/website/'.length)}`);
    });
}

document.addEventListener("DOMContentLoaded", function() {
    const footerPlaceholder = document.getElementById('footer-placeholder');
    
    if (footerPlaceholder) {
        // Determine which footer to load based on data attribute
        const footerType = footerPlaceholder.getAttribute('data-footer-type') || 'detailed';
        const footerFile = footerType === 'detailed'
            ? new URL('shared/footer-detailed.html', FOOTER_WEBSITE_BASE_URL).href
            : new URL('shared/footer-simple.html', FOOTER_WEBSITE_BASE_URL).href;
        
        fetch(footerFile)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load footer: ${response.status} ${response.statusText} from ${footerFile}`);
                }
                return response.text();
            })
            .then(data => {
                footerPlaceholder.innerHTML = data;
                rewriteWebsiteLinks(footerPlaceholder);

                if (footerPlaceholder.getAttribute('data-footer-remove-content') === 'true') {
                    const footerContent = footerPlaceholder.querySelector('.footer-content');
                    if (footerContent) {
                        footerContent.remove();
                    }
                }
                
                // Update current year in footer - looks for common year element IDs
                const yearElement = footerPlaceholder.querySelector('#current-year, #footer-year, [data-year]');
                if (yearElement) {
                    yearElement.textContent = new Date().getFullYear();
                }
            })
            .catch(error => {
                console.error('Error loading footer:', error);
                // Provide fallback footer content
                footerPlaceholder.innerHTML = `
                    <footer>
                        <div class="container">
                            <div class="footer-bottom">
                                <p>&copy; ${new Date().getFullYear()} 2nd Tolworth Scout Group. Part of The Scout Association.</p>
                                <p>Registered Charity. Charity numbers: 306101 (England and Wales) and SC038437 (Scotland).</p>
                            </div>
                        </div>
                    </footer>
                `;
            });
    }
});
