require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const msal = require('@azure/msal-node');
const Integration = require('../models/Integration');
const { createMsalCachePlugin } = require('../utils/msalTokenCache');

const router = express.Router();

const OUTLOOK_SCOPES = ['User.Read', 'Calendars.ReadWrite', 'Mail.Send', 'offline_access'];

function integrationsPageUrl(query = {}) {
    const base = process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value != null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return `${base}/school/integrations${qs ? `?${qs}` : ''}`;
}

// ── Google OAuth Configuration ──
const googleConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
};

function createGoogleOAuthClient() {
    return new google.auth.OAuth2(
        googleConfig.clientId,
        googleConfig.clientSecret,
        googleConfig.redirectUri
    );
}

function getGoogleAuthUrl(schoolId) {
    if (!googleConfig.clientId || !googleConfig.clientSecret) {
        return null; // Not configured
    }
    const oauth2Client = createGoogleOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/gmail.send', // Gmail API scope for sending emails
        ],
        state: schoolId.toString(),
        prompt: 'consent select_account',
    });
}

// ── Microsoft Outlook OAuth Configuration ──
const msalConfig = {
    auth: {
        clientId: process.env.OUTLOOK_CLIENT_ID || 'placeholder',
        authority: `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID || 'common'}`,
        clientSecret: process.env.OUTLOOK_CLIENT_SECRET || 'placeholder',
    },
};

/**
 * Helper to get a school-specific MSAL ConfidentialClientApplication with persistent caching.
 */
function getMsalClient(schoolId) {
    if (!process.env.OUTLOOK_CLIENT_ID) return null;
    
    const clientConfig = {
        ...msalConfig,
        cache: {
            cachePlugin: createMsalCachePlugin(schoolId)
        }
    };
    return new msal.ConfidentialClientApplication(clientConfig);
}

// Keep a default instance for general use (like getting auth URL if schoolId is not yet known, though we usually have it)
let pca;
try {
    pca = new msal.ConfidentialClientApplication(msalConfig);
} catch (e) {
    console.warn('[Integrations] MSAL default init skipped:', e.message);
}

async function getOutlookAuthUrl(schoolId) {
    const schoolPca = getMsalClient(schoolId) || pca;
    if (!schoolPca) return null;

    const authCodeUrlParameters = {
        scopes: OUTLOOK_SCOPES,
        redirectUri: process.env.OUTLOOK_REDIRECT_URI,
        state: schoolId.toString(),
        prompt: 'select_account',
    };
    return await schoolPca.getAuthCodeUrl(authCodeUrlParameters);
}

// ── Google OAuth Callback ──
router.get('/google/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send('Missing code or state');
    }

    try {
        const schoolId = state;
        const oauth2Client = createGoogleOAuthClient();
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch user email from Google
        let userEmail = null;
        try {
            // Option 1: Try to get email from ID token
            if (tokens.id_token) {
                try {
                    const ticket = await oauth2Client.verifyIdToken({
                        idToken: tokens.id_token,
                        audience: googleConfig.clientId
                    });
                    const payload = ticket.getPayload();
                    userEmail = payload.email;
                } catch (idTokenErr) {
                    console.warn('[Integrations] Failed to verify ID token, trying userinfo API:', idTokenErr.message);
                }
            }

            // Option 2: Fallback to userinfo API
            if (!userEmail && tokens.access_token) {
                const axios = require('axios');
                const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        Authorization: `Bearer ${tokens.access_token}`
                    }
                });
                userEmail = userInfoResponse.data.email;
            }
        } catch (emailErr) {
            console.error('[Integrations] Failed to fetch user email from Google:', emailErr.message);
            // Continue without email - connection still works, just won't have email stored
        }

        // Store integration with tokens and email
        const config = { tokens };
        if (userEmail) {
            config.userEmail = userEmail;
        }

        await Integration.findOneAndUpdate(
            { schoolId, type: 'google' },
            { 
                name: 'Google Workspace', 
                connected: true, 
                connectedAt: new Date(), 
                config 
            },
            { upsert: true }
        );

        res.redirect(`${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/school/integrations?success=google`);
    } catch (err) {
        console.error('Google Callback Error:', err);
        res.redirect(`${process.env.FRONTEND_URL || process.env.FORM_BASE_URL || 'http://localhost:5173'}/school/integrations?error=google`);
    }
});

// ── Outlook OAuth Callback ──
router.get('/outlook/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    if (error) {
        const detail = error_description || error;
        console.error('Outlook OAuth error:', error, error_description);
        return res.redirect(integrationsPageUrl({ error: 'outlook', detail }));
    }
    if (!code || !state) {
        return res.redirect(integrationsPageUrl({
            error: 'outlook',
            detail: 'Missing authorization code or state from Microsoft',
        }));
    }

    try {
        const schoolId = state;
        const schoolPca = getMsalClient(schoolId);
        if (!schoolPca) throw new Error('MSAL not configured');

        // Ensure a row exists so the MSAL cache plugin can persist refresh tokens during token exchange.
        await Integration.findOneAndUpdate(
            { schoolId, type: 'outlook' },
            { $setOnInsert: { name: 'Microsoft Outlook', connected: false, config: {} } },
            { upsert: true }
        );

        const tokenRequest = {
            code,
            redirectUri: process.env.OUTLOOK_REDIRECT_URI,
            scopes: OUTLOOK_SCOPES,
        };
        const response = await schoolPca.acquireTokenByCode(tokenRequest);

        await Integration.findOneAndUpdate(
            { schoolId, type: 'outlook' },
            {
                $set: {
                    name: 'Microsoft Outlook',
                    connected: true,
                    connectedAt: new Date(),
                    'config.account': response.account,
                    'config.accessToken': response.accessToken,
                    'config.expiresOn': response.expiresOn,
                    'config.scopes': response.scopes,
                }
            },
            { upsert: true }
        );

        console.log(`[Integrations] Outlook connected and config persisted for school: ${schoolId}`);

        res.redirect(integrationsPageUrl({ success: 'outlook' }));
    } catch (err) {
        console.error('Outlook Callback Error:', err);
        const AlertService = require('../services/alertService');
        AlertService.create({
            type: 'OUTLOOK_ERROR',
            severity: 'WARNING',
            schoolId: req.query.state,
            title: 'Outlook OAuth connection failed',
            message: err.message,
            source: 'integrations.outlook.callback',
            metadata: { stack: err.stack },
        });
        res.redirect(integrationsPageUrl({ error: 'outlook', detail: err.message }));
    }
});

module.exports = {
    router,
    getGoogleAuthUrl,
    getOutlookAuthUrl,
    getMsalClient,
    pca,
};
