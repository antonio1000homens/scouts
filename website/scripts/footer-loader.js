document.addEventListener("DOMContentLoaded", function() {
    const footerPlaceholder = document.getElementById('footer-placeholder');
    
    if (footerPlaceholder) {
        // Determine which footer to load based on data attribute
        const footerType = footerPlaceholder.getAttribute('data-footer-type') || 'simple';
        const footerFile = footerType === 'detailed' 
            ? '/website/shared/footer-detailed.html' 
            : '/website/shared/footer-simple.html';
        
        fetch(footerFile)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to load footer: ${response.status} ${response.statusText} from ${footerFile}`);
                }
                return response.text();
            })
            .then(data => {
                footerPlaceholder.innerHTML = data;
                
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
                            <p>&copy; ${new Date().getFullYear()} 2nd Tolworth Scout Group. All rights reserved.</p>
                        </div>
                    </footer>
                `;
            });
    }
});
