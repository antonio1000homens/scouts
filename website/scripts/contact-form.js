(function () {
    var form = document.getElementById('contact-form');
    if (!form) return;

    var submitBtn = document.getElementById('contact-submit');
    var statusEl = document.getElementById('contact-status');

    function showStatus(message, isError) {
        statusEl.textContent = message;
        statusEl.className = 'contact-status ' + (isError ? 'contact-status--error' : 'contact-status--success');
        statusEl.hidden = false;
    }

    function buildErrorMessage(data) {
        if (!data || typeof data !== 'object') {
            return 'Something went wrong. Please try again.';
        }

        if (data.code === 'NOTIFICATION_FAILED') {
            var details = [];
            if (data.upstreamStatus) {
                details.push('IFTTT status ' + data.upstreamStatus + (data.upstreamStatusText ? ' ' + data.upstreamStatusText : ''));
            }
            if (data.upstreamBody) {
                details.push(String(data.upstreamBody).trim());
            }
            return details.length
                ? 'Failed to notify IFTTT. ' + details.join(' - ')
                : 'Failed to notify IFTTT. Please try again later.';
        }

        return data.message || 'Something went wrong. Please try again.';
    }

    function setLoading(loading) {
        submitBtn.disabled = loading;
        submitBtn.textContent = loading ? 'Sending…' : 'Send Message';
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();

        var name = document.getElementById('contact-name').value.trim();
        var email = document.getElementById('contact-email').value.trim();
        var message = document.getElementById('contact-message').value.trim();

        // Retrieve the Turnstile token rendered in the form
        var turnstileToken = '';
        var tokenInput = form.querySelector('[name="cf-turnstile-response"]');
        if (tokenInput) {
            turnstileToken = tokenInput.value;
        }

        if (!name || !email || !message) {
            showStatus('Please fill in all fields.', true);
            return;
        }

        if (!turnstileToken) {
            showStatus('Please complete the CAPTCHA.', true);
            return;
        }

        setLoading(true);
        statusEl.hidden = true;

        fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                email: email,
                message: message,
                turnstileToken: turnstileToken
            })
        })
        .then(function (resp) {
            return resp.json().catch(function () {
                return {
                    ok: false,
                    message: 'Unexpected non-JSON response from contact endpoint.',
                    httpStatus: resp.status
                };
            });
        })
        .then(function (data) {
            setLoading(false);
            if (data.ok) {
                showStatus('Thank you! Your message has been sent.', false);
                form.reset();
                // Reset the Turnstile widget so the user can submit again if needed
                if (window.turnstile) {
                    window.turnstile.reset();
                }
            } else {
                showStatus(buildErrorMessage(data), true);
            }
        })
        .catch(function () {
            setLoading(false);
            showStatus('Network error. Please check your connection and try again.', true);
        });
    });
}());
