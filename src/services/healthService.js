const mongoose = require('mongoose');
const axios = require('axios');
const AlertService = require('./alertService');

let lastHealthAlerts = {};

function shouldAlertHealth(checkName) {
    const now = Date.now();
    const last = lastHealthAlerts[checkName] || 0;
    const cooldown = parseInt(process.env.ALERT_DEDUP_COOLDOWN_MINUTES || '60', 10) * 60 * 1000;
    if (now - last < cooldown) return false;
    lastHealthAlerts[checkName] = now;
    return true;
}

function healthAlert(checkName, severity, message) {
    if (!shouldAlertHealth(checkName)) return;
    AlertService.create({
        type: checkName === 'database' ? 'DATABASE_ERROR' : 'SYSTEM_ERROR',
        severity,
        title: `Health check failed: ${checkName}`,
        message,
        source: `healthService.${checkName}`,
        metadata: { check: checkName },
    });
}

async function checkDatabase() {
    const start = Date.now();
    try {
        if (mongoose.connection.readyState !== 1) {
            return { ok: false, detail: `readyState=${mongoose.connection.readyState}`, latencyMs: Date.now() - start };
        }
        await mongoose.connection.db.admin().ping();
        return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
        return { ok: false, detail: err.message, latencyMs: Date.now() - start };
    }
}

function checkOutlook() {
    const configured = Boolean(
        process.env.OUTLOOK_CLIENT_ID &&
        process.env.OUTLOOK_CLIENT_SECRET &&
        process.env.OUTLOOK_REDIRECT_URI
    );
    return { ok: configured, detail: configured ? 'MSAL env configured' : 'Outlook env missing' };
}

function checkEmail() {
    const configured = Boolean(
        process.env.SMTP_HOST &&
        process.env.SMTP_USER &&
        (process.env.SMTP_PASS || process.env.SMTP_PASSWORD)
    );
    return { ok: configured, detail: configured ? 'SMTP configured' : 'SMTP env missing' };
}

function checkOpenAI() {
    const configured = Boolean(process.env.OPENAI_API_KEY);
    return { ok: configured, detail: configured ? 'API key present' : 'OPENAI_API_KEY missing' };
}

async function checkElevenLabs() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const baseUrl = (process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
    if (!apiKey) {
        return { ok: false, detail: 'ELEVENLABS_API_KEY missing' };
    }
    try {
        const start = Date.now();
        await axios.get(`${baseUrl}/v1/user`, {
            headers: { 'xi-api-key': apiKey },
            timeout: 8000,
        });
        return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
        const status = err.response?.status;
        return {
            ok: false,
            detail: status ? `HTTP ${status}` : err.message,
            latencyMs: undefined,
        };
    }
}

async function runHealthChecks() {
    const [database, elevenlabs] = await Promise.all([
        checkDatabase(),
        checkElevenLabs(),
    ]);

    const outlook = checkOutlook();
    const openai = checkOpenAI();
    const email = checkEmail();

    const checks = { database, outlook, elevenlabs, openai, email };

    if (!database.ok) {
        healthAlert('database', 'CRITICAL', database.detail || 'Database unreachable');
    }
    if (!outlook.ok) {
        healthAlert('outlook', 'WARNING', outlook.detail);
    }
    if (!elevenlabs.ok) {
        healthAlert('elevenlabs', 'WARNING', elevenlabs.detail || 'ElevenLabs check failed');
    }
    if (!openai.ok) {
        healthAlert('openai', 'WARNING', openai.detail);
    }
    if (!email.ok) {
        healthAlert('email', 'WARNING', email.detail);
    }

    const values = Object.values(checks);
    const allOk = values.every((c) => c.ok);
    const anyCriticalDown = !database.ok;

    let status = 'ok';
    if (anyCriticalDown) status = 'down';
    else if (!allOk) status = 'degraded';

    return {
        status,
        timestamp: new Date().toISOString(),
        checks,
    };
}

module.exports = { runHealthChecks };
