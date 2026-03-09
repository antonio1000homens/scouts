// Default non-secret runtime config for admin page.
// CI/manual deployment can overwrite this file using environment secrets.

window.ADMIN_API_BASE = '/admin-api';

// Optional runtime URL overrides
// window.SCOUTS_AUTH_STATUS_URL = '/admin-api/auth-status';
// window.SCOUTS_REFRESH_URL = '/admin-api/scouts';
// window.SCOUTS2SQS_URL = '/admin-api/scouts2sqs';
// window.SCOUTS_CONFIG_URL = '../../scouts.conf';
// Backward-compatible override (legacy name still supported by admin-script.js):
// window.SCOUTS_QUEUE_URL = '/admin-api/scouts2sqs';
