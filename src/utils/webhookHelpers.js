const PLACEHOLDER_CALLER_NAMES = new Set([
    'parent',
    'unknown',
    'unknown caller',
    'not provided',
    '',
]);

function isUsableCallerName(name) {
    const normalized = String(name || '').trim();
    if (!normalized) return false;
    return !PLACEHOLDER_CALLER_NAMES.has(normalized.toLowerCase());
}

/** ElevenLabs web widget sessions reuse a stable user_id — not a phone number. */
function isWidgetCallerId(value) {
    return /^user_/i.test(String(value || '').trim());
}

/** Only real phone numbers should be used for cross-call name lookup. */
function isRealPhoneForLookup(phone) {
    if (isWidgetCallerId(phone)) return false;
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 10;
}

/**
 * Resolve the caller's name from an ElevenLabs webhook document.
 * Prefers tour_booking_extracted.name, then comprehensive_result.parent_name.
 * @param {Object} webhook
 * @param {string} [fallback='Parent']
 * @returns {string}
 */
function getCallerNameFromWebhook(webhook, fallback = 'Parent') {
    if (!webhook) return fallback;

    const candidates = [
        webhook.tour_booking_extracted?.name,
        webhook.comprehensive_result?.parent_name,
    ];

    for (const name of candidates) {
        if (isUsableCallerName(name)) {
            return String(name).trim();
        }
    }

    return fallback;
}

/**
 * Get call duration in seconds from a webhook document.
 * ElevenLabs may send duration in different places; also fallback to transcript timestamps.
 * Used by admin email (webhook) and dashboard (school routes).
 * @param {Object} webhook - Webhook doc with metadata, raw_payload, transcript
 * @returns {number} Duration in seconds (0 if not found)
 */
function getCallDurationSeconds(webhook) {
    if (!webhook) return 0;

    const meta = webhook.metadata || {};
    const phoneCall = meta.phone_call || {};
    const raw = webhook.raw_payload?.data?.metadata || {};
    const rawPhone = raw.phone_call || {};

    const fromMeta = phoneCall.call_duration_secs ?? meta.call_duration_secs ?? meta.system__call_duration_secs;
    if (typeof fromMeta === 'number' && fromMeta >= 0) return Math.round(fromMeta);

    const fromRaw = rawPhone.call_duration_secs ?? raw.call_duration_secs ?? raw.system__call_duration_secs;
    if (typeof fromRaw === 'number' && fromRaw >= 0) return Math.round(fromRaw);

    // Fallback: compute from transcript time_in_call_secs if present
    const transcript = Array.isArray(webhook.transcript) ? webhook.transcript : [];
    if (transcript.length > 0) {
        const times = transcript
            .map(t => t.time_in_call_secs ?? t.time_in_call)
            .filter(t => typeof t === 'number' && t >= 0);
        if (times.length > 0) {
            const maxSec = Math.max(...times);
            if (maxSec > 0) return Math.round(maxSec);
        }
    }

    return 0;
}

/**
 * Resolve the caller's phone number from an ElevenLabs webhook document.
 * ElevenLabs SIP calls often use external_number (not from_number).
 * @param {Object} webhook - Webhook doc with metadata, user_id, tour_booking_extracted, raw_payload
 * @param {string} [fallback='Unknown'] - Value when no phone is found
 * @returns {string}
 */
function getCallerPhoneFromWebhook(webhook, fallback = 'Unknown') {
    if (!webhook) return fallback;

    const phoneCall = webhook.metadata?.phone_call || {};
    const rawPhoneCall = webhook.raw_payload?.data?.metadata?.phone_call || {};

    const phone = phoneCall.from_number
        || phoneCall.external_number
        || rawPhoneCall.from_number
        || rawPhoneCall.external_number
        || webhook.tour_booking_extracted?.phone
        || webhook.user_id
        || '';

    const trimmed = String(phone).trim();
    return trimmed || fallback;
}

module.exports = {
    getCallDurationSeconds,
    getCallerPhoneFromWebhook,
    getCallerNameFromWebhook,
    isUsableCallerName,
    isWidgetCallerId,
    isRealPhoneForLookup,
};
