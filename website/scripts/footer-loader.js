document.addEventListener("DOMContentLoaded", function() {
    const footerPlaceholder = document.getElementById('footer-placeholder');
    
    if (footerPlaceholder) {
        // Determine which footer to load based on data attribute
        const footerType = footerPlaceholder.getAttribute('data-footer-type') || 'simple';
        const footerFile = footerType === 'detailed' 
            ? '/website/shared/footer-detailed.html' 
            : '/website/shared/footer-simple.html';
        
        fetch(footerFile)
            .then(response => response.text())
            .then(data => {
                footerPlaceholder.innerHTML = data;
                
                // Update current year if simple footer is loaded
                const yearElement = document.getElementById('current-year');
                if (yearElement) {
                    yearElement.textContent = new Date().getFullYear();
                }
            })
            .catch(error => {
                console.error('Error loading footer:', error);
            });
    }
});
