/**
 * Detect call-ending failures from ElevenLabs post_call_transcription payloads
 * (quota exhaustion, agent errors, etc.).
 */

function stringifyMaybe(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function collectTextBlobs(metadata = {}, data = {}) {
    const blobs = [];
    const push = (v) => {
        const s = stringifyMaybe(v);
        if (s) blobs.push(s);
    };

    push(metadata.error);
    push(metadata.termination_reason);
    push(metadata.failure_reason);
    push(metadata.failed_reason);
    push(data.error);
    push(data.status);

    if (Array.isArray(metadata.warnings)) {
        metadata.warnings.forEach(push);
    } else {
        push(metadata.warnings);
    }

    // Nested error shapes from ElevenLabs
    if (metadata.error && typeof metadata.error === 'object') {
        push(metadata.error.message);
        push(metadata.error.detail);
        push(metadata.error.reason);
    }

    return blobs.join(' | ');
}

/**
 * @returns {null | {
 *   isQuota: boolean,
 *   alertType: string,
 *   severity: 'CRITICAL' | 'WARNING',
 *   title: string,
 *   message: string,
 *   terminationReason: string,
 *   errorText: string,
 * }}
 */
function detectElevenLabsCallFailure(metadata = {}, data = {}) {
    const terminationReason = stringifyMaybe(metadata.termination_reason || metadata.terminationReason);
    const errorText = stringifyMaybe(
        metadata.error?.reason
        || metadata.error?.message
        || metadata.error?.detail
        || metadata.error
        || data.error
        || ''
    );
    const combined = collectTextBlobs(metadata, data).toLowerCase();

    if (!combined && !terminationReason && !errorText) {
        return null;
    }

    const isQuota = /quota|credits?\s+remaining|exceeds your quota|quota limit|insufficient credits|out of credits/i.test(
        combined
    );

    const isHardError =
        isQuota
        || /conversation ended due to an error|request exceeds|rate limit|insufficient|billing|payment required/i.test(combined)
        || /error|failed|quota/i.test(terminationReason)
        || Boolean(errorText);

    if (!isHardError) {
        return null;
    }

    if (isQuota) {
        return {
            isQuota: true,
            alertType: 'RATE_LIMIT_ERROR',
            severity: 'CRITICAL',
            title: 'ElevenLabs quota exceeded — Nora cannot take calls',
            message:
                errorText
                || terminationReason
                || 'This request exceeds your ElevenLabs quota limit. Nora calls are failing until credits are restored.',
            terminationReason,
            errorText,
        };
    }

    return {
        isQuota: false,
        alertType: 'ELEVENLABS_ERROR',
        severity: 'CRITICAL',
        title: 'Nora live call failed',
        message:
            errorText
            || terminationReason
            || 'ElevenLabs reported a call failure. Check conversation history for details.',
        terminationReason,
        errorText,
    };
}

module.exports = {
    detectElevenLabsCallFailure,
    collectTextBlobs,
};
