const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
const Integration = require('../models/Integration');
const School = require('../models/School');
const { refreshOutlookToken } = require('./calendarService');
const AlertService = require('./alertService');

async function reportEmailFailure(schoolId, err, context = '') {
    const school = schoolId ? await School.findById(schoolId).select('name').lean() : null;
    AlertService.create({
        type: 'EMAIL_ERROR',
        severity: 'CRITICAL',
        schoolId,
        schoolName: school?.name,
        title: 'Email send failed',
        message: `${context} ${err?.message || 'All providers failed'}`.trim(),
        source: 'mailService.sendEmail',
        metadata: { stack: err?.stack },
    });
}

/**
 * Creates a Google OAuth2 client for a school's integration.
 */
function createGoogleOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

/**
 * Sends an email using the best available method for the school.
 * Priorities: 
 * 1. Gmail API (if Google connected)
 * 2. Outlook/Graph API (if Outlook connected)
 * 3. Fallback to System SMTP
 * 
 * @param {string} schoolId - MongoDB ObjectId
 * @param {object} opts - { to, subject, text, html, attachments?: [{ filename, content }] }
 */
async function sendEmail(schoolId, opts) {
    const { to, subject, text, html, attachments } = opts;
    
    try {
        const [school, integrations] = await Promise.all([
            School.findById(schoolId).select('preferredEmailProvider').lean(),
            Integration.find({ schoolId, connected: true }).lean()
        ]);

        const preferred = school?.preferredEmailProvider || 'google';
        // Define priority order based on preference
        const providers = preferred === 'outlook' ? ['outlook', 'google'] : ['google', 'outlook'];

        for (const type of providers) {
            const integration = integrations.find(i => i.type === type);
            if (!integration) continue;

            try {
                if (type === 'google' && integration.config?.tokens) {
                    return await sendViaGmail(integration, opts);
                } else if (type === 'outlook' && integration.config) {
                    return await sendViaOutlook(integration, opts);
                }
            } catch (err) {
                console.warn(`[MailService] Send via ${type} failed for school ${schoolId}:`, err.message);
                // Continue to next provider in loop
            }
        }
        
        // 3. Last fallback to system SMTP if configured
        console.log(`[MailService] No suitable integration found or all failed for school ${schoolId}, falling back to SMTP.`);
        try {
            return await sendViaSMTP(opts);
        } catch (smtpErr) {
            await reportEmailFailure(schoolId, smtpErr, 'SMTP fallback failed after provider attempts');
            throw smtpErr;
        }

    } catch (err) {
        console.error('[MailService] Unified send error:', err.message);
        try {
            return await sendViaSMTP(opts);
        } catch (smtpErr) {
            await reportEmailFailure(schoolId, smtpErr, 'SMTP fallback failed');
            throw smtpErr;
        }
    }
}

async function sendViaGmail(integration, { to, subject, text, html, attachments }) {
    const oauth2Client = createGoogleOAuthClient();
    const tokens = integration.config.tokens;
    oauth2Client.setCredentials(tokens);

    // Refresh token listener
    oauth2Client.on('tokens', async (newTokens) => {
        await Integration.updateOne(
            { _id: integration._id },
            { $set: { 'config.tokens': { ...tokens, ...newTokens } } }
        );
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const bodyContent = html || text.replace(/\n/g, '<br>');

    let rawMessage;
    if (attachments && attachments.length > 0) {
        const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const bodyPart = [
            `Content-Type: text/html; charset=utf-8`,
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from(bodyContent).toString('base64')
        ].join('\r\n');
        const attachmentParts = attachments.map(att => {
            const content = typeof att.content === 'string' ? att.content : (att.content || '').toString();
            return [
                `Content-Type: application/ics; name="${(att.filename || 'invite.ics').replace(/"/g, '')}"`,
                'Content-Transfer-Encoding: base64',
                'Content-Disposition: attachment',
                '',
                Buffer.from(content).toString('base64')
            ].join('\r\n');
        });
        rawMessage = [
            `To: ${to}`,
            'MIME-Version: 1.0',
            `Subject: ${utf8Subject}`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            bodyPart,
            `--${boundary}`,
            attachmentParts.join(`\r\n--${boundary}\r\n`),
            `--${boundary}--`
        ].join('\r\n');
    } else {
        rawMessage = [
            `To: ${to}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            `Subject: ${utf8Subject}`,
            '',
            bodyContent
        ].join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
    });

    console.log('[MailService] Email sent via Gmail API:', res.data.id);
    return { success: true, method: 'gmail', messageId: res.data.id };
}

async function sendViaOutlook(integration, { to, subject, text, html, attachments }) {
    const accessToken = await refreshOutlookToken(integration);
    if (!accessToken) throw new Error('Outlook token refresh failed');
    const message = {
        subject: subject,
        body: {
            contentType: html ? 'HTML' : 'Text',
            content: html || text
        },
        toRecipients: [
            { emailAddress: { address: to } }
        ]
    };
    if (attachments && attachments.length > 0) {
        message.attachments = attachments.map(att => {
            const content = typeof att.content === 'string' ? att.content : (att.content || '').toString();
            return {
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: att.filename || 'invite.ics',
                contentType: 'text/calendar',
                contentBytes: Buffer.from(content).toString('base64')
            };
        });
    }
    const res = await axios.post(
        'https://graph.microsoft.com/v1.0/me/sendMail',
        { message },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    console.log('[MailService] Email sent via Outlook API');
    return { success: true, method: 'outlook' };
}

async function sendViaSMTP({ to, subject, text, html, attachments, from: fromOverride }) {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
    const from = fromOverride || process.env.MAIL_FROM || process.env.EMAIL_FROM || user || 'noreply@enrollmentai.com';

    if (!host || !user || !pass) {
        throw new Error('SMTP not configured');
    }

    const transporter = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user, pass },
    });

    const mailOpts = { from, to, subject, text, html };
    if (attachments && attachments.length > 0) {
        mailOpts.attachments = attachments.map(att => ({
            filename: att.filename || 'invite.ics',
            content: typeof att.content === 'string' ? att.content : (att.content || '')
        }));
    }
    const info = await transporter.sendMail(mailOpts);

    console.log('[MailService] Email sent via SMTP:', info.messageId);
    return { success: true, method: 'smtp', messageId: info.messageId };
}

module.exports = { sendEmail, sendViaSMTP };
