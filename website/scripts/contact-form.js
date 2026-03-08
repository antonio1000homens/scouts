(function () {
    var form = document.getElementById('contact-form');
    if (!form) return;

    var submitBtn = document.getElementById('contact-submit');
    var statusEl = document.getElementById('contact-status');
    var turnstileContainer = document.getElementById('contact-turnstile');
    var widgetId = null;
    var pendingSubmission = null;
    var isSubmitting = false;

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

    function submitMessage(payload) {
        fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
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
            isSubmitting = false;
            setLoading(false);
            if (data.ok) {
                showStatus('Thank you! Your message has been sent.', false);
                form.reset();
            } else {
                showStatus(buildErrorMessage(data), true);
            }
            if (window.turnstile && widgetId !== null) {
                window.turnstile.reset(widgetId);
            }
            pendingSubmission = null;
        })
        .catch(function () {
            isSubmitting = false;
            setLoading(false);
            showStatus('Network error. Please check your connection and try again.', true);
            if (window.turnstile && widgetId !== null) {
                window.turnstile.reset(widgetId);
            }
            pendingSubmission = null;
        });
    }

    function renderTurnstile() {
        if (!turnstileContainer || widgetId !== null) {
            return;
        }

        if (!window.turnstile || typeof window.turnstile.render !== 'function') {
            window.setTimeout(renderTurnstile, 150);
            return;
        }

        widgetId = window.turnstile.render(turnstileContainer, {
            sitekey: turnstileContainer.getAttribute('data-sitekey'),
            theme: turnstileContainer.getAttribute('data-theme') || 'light',
            execution: 'execute',
            appearance: 'interaction-only',
            callback: function (token) {
                if (!pendingSubmission) {
                    return;
                }
                var payload = {
                    name: pendingSubmission.name,
                    email: pendingSubmission.email,
                    message: pendingSubmission.message,
                    turnstileToken: token
                };
                submitMessage(payload);
            },
            'error-callback': function () {
                isSubmitting = false;
                setLoading(false);
                showStatus('CAPTCHA failed to load. Please try again.', true);
                pendingSubmission = null;
            },
            'expired-callback': function () {
                if (window.turnstile && widgetId !== null) {
                    window.turnstile.reset(widgetId);
                }
            }
        });
    }

    renderTurnstile();

    form.addEventListener('submit', function (event) {
        event.preventDefault();

        if (isSubmitting) {
            return;
        }

        var name = document.getElementById('contact-name').value.trim();
        var email = document.getElementById('contact-email').value.trim();
        var message = document.getElementById('contact-message').value.trim();

        if (!name || !email || !message) {
            showStatus('Please fill in all fields.', true);
            return;
        }

        if (!window.turnstile || widgetId === null) {
            showStatus('CAPTCHA is still loading. Please try again in a moment.', true);
            return;
        }

        pendingSubmission = { name: name, email: email, message: message };
        isSubmitting = true;
        setLoading(true);
        statusEl.hidden = true;
        window.turnstile.execute(widgetId);
    });
}());
