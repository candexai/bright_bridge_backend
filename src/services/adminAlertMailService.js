const { sendViaSMTP } = require('./mailService');
const { buildEscalationBanner } = require('../utils/alertMessageFormatter');

function parseAdminEmails() {
    const raw = process.env.ADMIN_ALERT_EMAILS || '';
    return raw
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0 && e.includes('@'));
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function subjectForAlert(alert, escalationTier) {
    const base = alert.title || 'Alert';
    if (escalationTier === 'initial' || !escalationTier) {
        return `[CRITICAL] ${base}`;
    }
    return `[CRITICAL] [${escalationTier} reminder] ${base}`;
}

/**
 * Send CRITICAL alert email to ADMIN_ALERT_EMAILS via SMTP only.
 * @param {object} alert - Mongoose alert document or plain object
 * @param {object} opts - { escalationTier: 'initial' | '1h' | '6h' | '24h' }
 */
async function sendCriticalAlert(alert, opts = {}) {
    const recipients = parseAdminEmails();
    if (recipients.length === 0) {
        console.warn('[AdminAlertMail] ADMIN_ALERT_EMAILS not configured, skipping email');
        return { success: false, reason: 'no_recipients' };
    }

    const escalationTier = opts.escalationTier || 'initial';
    const stack = alert.metadata?.stack || alert.metadata?.errorStack || '';
    const timestamp = alert.lastOccurredAt || alert.createdAt || new Date();
    const schoolLine = alert.schoolName || alert.schoolId
        ? `${escapeHtml(alert.schoolName || '—')} (${alert.schoolId || '—'})`
        : '— (platform-wide)';

    const displayMessage = alert.message || alert.metadata?.rawMessage || 'No details available.';
    const escalationHtml =
        escalationTier !== 'initial'
            ? `<div style="background: #fff7ed; border: 1px solid #fdba74; padding: 12px; border-radius: 8px; margin-bottom: 16px;">${escapeHtml(buildEscalationBanner(escalationTier, alert))}</div>`
            : '';
    const escalationText =
        escalationTier !== 'initial' ? `${buildEscalationBanner(escalationTier, alert)}\n\n` : '';

    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
  <h2 style="color: #dc2626;">${escapeHtml(subjectForAlert(alert, escalationTier))}</h2>
  ${escalationHtml}
  <table style="border-collapse: collapse; margin-bottom: 16px;">
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Severity</td><td>${escapeHtml(alert.severity)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Type</td><td>${escapeHtml(alert.type)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">School</td><td>${schoolLine}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Source</td><td><code>${escapeHtml(alert.source)}</code></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Last seen</td><td>${escapeHtml(new Date(timestamp).toISOString())}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">First seen</td><td>${escapeHtml(new Date(alert.firstOccurredAt || timestamp).toISOString())}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Occurrences</td><td>${alert.occurrenceCount || 1}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Status</td><td>${escapeHtml(alert.status || 'ACTIVE')}</td></tr>
  </table>
  <h3>What happened</h3>
  <pre style="background: #f1f5f9; padding: 12px; border-radius: 8px; white-space: pre-wrap; font-size: 14px;">${escapeHtml(displayMessage)}</pre>
  ${stack ? `<h3>Stack trace</h3><pre style="background: #fef2f2; padding: 12px; border-radius: 8px; font-size: 12px; overflow-x: auto; white-space: pre-wrap;">${escapeHtml(stack)}</pre>` : ''}
</body>
</html>`;

    const text = [
        subjectForAlert(alert, escalationTier),
        escalationText,
        `Severity: ${alert.severity}`,
        `Type: ${alert.type}`,
        `School: ${alert.schoolName || '—'} (${alert.schoolId || '—'})`,
        `Source: ${alert.source}`,
        `Occurrences: ${alert.occurrenceCount || 1}`,
        `First seen: ${new Date(alert.firstOccurredAt || timestamp).toISOString()}`,
        `Last seen: ${new Date(timestamp).toISOString()}`,
        '',
        'What happened:',
        displayMessage,
        stack ? `\nStack trace:\n${stack}` : '',
    ].join('\n');

    const fromOverride = process.env.ALERT_EMAIL_FROM || process.env.SMTP_FROM || process.env.MAIL_FROM;

    try {
        await sendViaSMTP({
            to: recipients.join(', '),
            subject: subjectForAlert(alert, escalationTier),
            text,
            html,
            from: fromOverride,
        });
        return { success: true, tier: escalationTier };
    } catch (err) {
        console.error('[AdminAlertMail] Failed to send critical alert email:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = { sendCriticalAlert, parseAdminEmails };
