/**
 * Builds human-readable alert messages for admin UI and email.
 */

const TYPE_SUMMARIES = {
    SYSTEM_ERROR: 'An unhandled server error occurred. A request may have failed with HTTP 500.',
    DATABASE_ERROR: 'MongoDB connection or query failed. Data may not be saved until this is fixed.',
    AUTH_ERROR: 'Authentication or JWT validation failed.',
    SIGNUP_ERROR: 'School registration or onboarding failed. A school or user account may be incomplete.',
    OUTLOOK_ERROR: 'Microsoft Outlook / Graph integration failed. Calendar or email for this school may be unavailable.',
    ELEVENLABS_ERROR: 'ElevenLabs voice agent API call failed.',
    OPENAI_ERROR: 'OpenAI API call failed during transcript or AI processing.',
    EMAIL_ERROR: 'Outbound email could not be sent for this school (Gmail, Outlook, and SMTP all failed).',
    WEBHOOK_ERROR: 'An incoming webhook (ElevenLabs, PayPal, etc.) failed to process.',
    CRON_ERROR: 'A scheduled background job (reminders, follow-ups) failed.',
    PAYMENT_ERROR: 'PayPal billing or minute deduction encountered an error.',
    AGENT_ERROR: 'ElevenLabs agent creation, sync, or phone linking failed.',
    INTEGRATION_ERROR: 'A third-party integration (Google, translate, etc.) failed.',
    RATE_LIMIT_ERROR: 'An external API rate limit was hit (OpenAI, ElevenLabs, etc.).',
    UNKNOWN_ERROR: 'An unexpected error was reported.',
};

const TYPE_ACTIONS = {
    SYSTEM_ERROR: 'Check server logs and the stack trace below. Reproduce using the request path in metadata.',
    DATABASE_ERROR: 'Verify MongoDB is running and MONGODB_URI is correct. Check hosting/network.',
    SIGNUP_ERROR: 'Check auth.register logs. For "duplicate key", the email or school may already exist. Inspect MongoDB unique index errors.',
    OUTLOOK_ERROR: 'Ask the school to reconnect Outlook under School → Integrations. Verify OUTLOOK_* env vars.',
    ELEVENLABS_ERROR: 'Verify ELEVENLABS_API_KEY and API URL. Check ElevenLabs dashboard for quota or agent ID.',
    OPENAI_ERROR: 'Verify OPENAI_API_KEY and billing. Retry; check for 429 rate limits.',
    EMAIL_ERROR: 'Verify SMTP_* env vars and school Gmail/Outlook tokens.',
    WEBHOOK_ERROR: 'Inspect webhook payload in logs. Confirm ElevenLabs/PayPal secrets and URLs.',
    PAYMENT_ERROR: 'Compare PayPal dashboard with billing transactions. Verify webhook signature and amounts.',
    AGENT_ERROR: 'Open school settings; re-sync agent or re-run agent creation for the school.',
    CRON_ERROR: 'Check reminderService logs on the server.',
};

function stringifyDetail(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/**
 * Expand short error strings into clearer explanations.
 */
function expandShortMessage(message) {
    const m = String(message || '').trim();
    if (!m) return 'No error message was provided.';

    const lower = m.toLowerCase();
    if (lower.includes('duplicate key') || lower.includes('e11000')) {
        return [
            m,
            'A record with the same unique value already exists in the database (for example duplicate email, school slug, or referral code).',
            'The registration was rejected to avoid creating duplicate accounts.',
        ].join(' ');
    }
    if (lower.includes('invalid_grant') || lower.includes('interaction_required')) {
        return [
            m,
            'The Outlook refresh token is no longer valid. The school must sign in again under Integrations.',
        ].join(' ');
    }
    if (lower.includes('smtp not configured')) {
        return [m, 'System SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in environment.'].join(' ');
    }
    if (lower === 'internal server error') {
        return [m, 'See stack trace and server logs for the underlying cause.'].join(' ');
    }
    return m;
}

/**
 * @returns {string} Multi-paragraph message for DB + email
 */
function buildEnrichedAlertMessage({ type, title, message, source, metadata = {} }) {
    const parts = [];
    const summary = TYPE_SUMMARIES[type];
    if (summary) {
        parts.push(summary);
    }

    const expanded = expandShortMessage(message);
    parts.push(`Error: ${expanded}`);

    if (metadata.failureReason && String(metadata.failureReason) !== String(message)) {
        parts.push(`Failure reason: ${stringifyDetail(metadata.failureReason)}`);
    }
    if (metadata.mailbox) {
        parts.push(`Outlook mailbox: ${metadata.mailbox}`);
    }
    if (metadata.httpStatus || metadata.status) {
        parts.push(`HTTP status: ${metadata.httpStatus || metadata.status}`);
    }
    if (metadata.method && metadata.path) {
        parts.push(`Request: ${metadata.method} ${metadata.path}`);
    }
    if (metadata.orderId) {
        parts.push(`PayPal order ID: ${metadata.orderId}`);
    }
    if (metadata.agentId) {
        parts.push(`ElevenLabs agent ID: ${metadata.agentId}`);
    }
    if (metadata.webhookId) {
        parts.push(`Webhook ID: ${metadata.webhookId}`);
    }
    if (metadata.mongoCode) {
        parts.push(`MongoDB code: ${metadata.mongoCode}`);
    }
    if (metadata.apiDetail) {
        parts.push(`API response: ${stringifyDetail(metadata.apiDetail)}`);
    }

    parts.push(`Source module: ${source}`);

    const action = TYPE_ACTIONS[type];
    if (action) {
        parts.push(`What to do: ${action}`);
    }

    return parts.join('\n\n');
}

/**
 * Extra lines for escalation reminder emails.
 */
function buildEscalationBanner(tier, alert) {
    const count = alert.occurrenceCount || 1;
    const first = alert.firstOccurredAt
        ? new Date(alert.firstOccurredAt).toISOString()
        : 'unknown';
    const tierLabel =
        tier === '1h' ? '1 hour' : tier === '6h' ? '6 hours' : tier === '24h' ? '24 hours' : tier;

    return [
        `⏱ Reminder: This CRITICAL issue is still unresolved after ${tierLabel}.`,
        `It has occurred ${count} time(s) since first seen at ${first}.`,
        'Please review in Admin → Notifications.',
    ].join('\n');
}

module.exports = {
    buildEnrichedAlertMessage,
    buildEscalationBanner,
    expandShortMessage,
};
