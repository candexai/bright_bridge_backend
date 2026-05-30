/**
 * CRITICAL alert email throttling: initial + optional 1h / 6h / 24h reminders.
 */

const ESCALATION_TIERS = [
    { tier: '1h', minHoursFromFirst: 1 },
    { tier: '6h', minHoursFromFirst: 6 },
    { tier: '24h', minHoursFromFirst: 24 },
];

function hoursSince(date) {
    if (!date) return 0;
    return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
}

/**
 * Which email tier to send, or null if no email.
 * @param {object} alert - saved alert document
 * @param {boolean} isNewAlert
 * @returns {string|null} tier key: initial | 1h | 6h | 24h
 */
function resolveCriticalEmailTier(alert) {
    if (!alert || alert.severity !== 'CRITICAL') return null;
    if (alert.status === 'RESOLVED') return null;

    const sent = new Set(alert.emailTiersSent || []);
    const elapsed = hoursSince(alert.firstOccurredAt);

    if (!sent.has('initial')) {
        return 'initial';
    }

    for (const { tier, minHoursFromFirst } of ESCALATION_TIERS) {
        if (sent.has(tier)) continue;
        if (elapsed >= minHoursFromFirst) {
            return tier;
        }
    }

    return null;
}

module.exports = { resolveCriticalEmailTier, ESCALATION_TIERS };
