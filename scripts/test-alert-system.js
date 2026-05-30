#!/usr/bin/env node
/**
 * Alert & Notification System — end-to-end test script
 *
 * Usage (from backend/):
 *   node scripts/test-alert-system.js              # full suite + cleanup at end
 *   node scripts/test-alert-system.js --keep       # leave test alerts in DB for UI inspection
 *   node scripts/test-alert-system.js --yes        # send real CRITICAL emails without prompt
 *   node scripts/test-alert-system.js --api-only   # only test admin HTTP API (server must run)
 *   node scripts/test-alert-system.js --cleanup    # delete alerts from last run (uses tag file)
 *   node scripts/test-alert-system.js --plan       # print test matrix only, no DB writes
 *
 * Prerequisites:
 *   - MongoDB running (MONGODB_URI in .env)
 *   - For --api-only: backend on PORT (default 5001)
 *   - For CRITICAL email tests: ADMIN_ALERT_EMAILS + SMTP_* in .env
 *
 * After running, open Admin → Notifications and Dashboard alert cards.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const Alert = require('../src/models/Alert');
const { ALERT_TYPES } = require('../src/models/Alert');
const AlertService = require('../src/services/alertService');
const { sendCriticalAlert, parseAdminEmails } = require('../src/services/adminAlertMailService');
const School = require('../src/models/School');

const TAG_FILE = path.join(__dirname, '.last-alert-test-run.json');
const API_BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5001}/api`;

const args = process.argv.slice(2);
const FLAGS = {
    keep: args.includes('--keep'),
    yes: args.includes('--yes') || args.includes('-y'),
    apiOnly: args.includes('--api-only'),
    cleanupOnly: args.includes('--cleanup'),
    plan: args.includes('--plan'),
    skipApi: args.includes('--no-api'),
};

const results = [];
let runId = `test-${Date.now()}`;
let schoolId = null;
let schoolName = 'Alert Test School';

function log(msg) {
    console.log(msg);
}

function section(title) {
    console.log('\n' + '='.repeat(72));
    console.log(title);
    console.log('='.repeat(72));
}

function record(name, expected, actual, pass, extra = '') {
    results.push({ name, expected, actual, pass, extra });
    const icon = pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${name}`);
    if (extra) console.log(`         ${extra}`);
    if (!pass) {
        console.log(`         Expected: ${expected}`);
        console.log(`         Actual:   ${actual}`);
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function expectedForSeverity(severity) {
    const inDb = 'Yes — Admin → Notifications';
    const email =
        severity === 'CRITICAL'
            ? parseAdminEmails().length
                ? `Yes — email to: ${parseAdminEmails().join(', ')}`
                : 'No — ADMIN_ALERT_EMAILS empty'
            : 'No — only CRITICAL sends mail';
    return { inDb, email };
}

async function connectDb() {
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/childcare-enrollment-ai';
    await mongoose.connect(uri);
}

async function loadSchool() {
    const school = await School.findOne().sort({ createdAt: 1 }).lean();
    if (school) {
        schoolId = school._id;
        schoolName = school.name;
    }
}

async function cleanupRun(tag) {
    const q = tag
        ? { 'metadata.testRunId': tag }
        : { 'metadata.testRunId': { $regex: /^test-/ } };
    const deleted = await Alert.deleteMany(q);
    return deleted.deletedCount;
}

function saveRunTag() {
    fs.writeFileSync(
        TAG_FILE,
        JSON.stringify({ runId, at: new Date().toISOString() }, null, 2)
    );
}

function loadRunTag() {
    if (!fs.existsSync(TAG_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(TAG_FILE, 'utf8')).runId;
    } catch {
        return null;
    }
}

async function createTestAlert(payload) {
    const full = {
        ...payload,
        metadata: {
            ...(payload.metadata || {}),
            testRunId: runId,
            testScript: 'scripts/test-alert-system.js',
        },
    };
    return AlertService.createAlertInternal(full);
}

function printPlan() {
    section('ALERT TEST PLAN — what should happen');
    console.log(`
Severity rules (production):
  INFO     → MongoDB alert row → Admin UI only → NO email
  WARNING  → MongoDB alert row → Admin UI only → NO email
  CRITICAL → MongoDB alert row → Admin UI + Dashboard cards → SMTP to ADMIN_ALERT_EMAILS

Dedupe (same type + source + school + title within ALERT_DEDUP_COOLDOWN_MINUTES):
  → Same alert row, occurrenceCount increases, lastOccurredAt updates
  → CRITICAL email: once on first occurrence, then only at 1h / 6h / 24h if still unresolved

After RESOLVED, same error fingerprint:
  → New alert row (new _id)

Admin API (requires running server + admin login):
  GET  /api/admin/alerts/stats
  GET  /api/admin/alerts?severity=CRITICAL&page=1
  GET  /api/admin/alerts/:id
  PATCH /api/admin/alerts/:id/status  { "status": "ACKNOWLEDGED" | "RESOLVED" | "ACTIVE" }

Health:
  GET /api/health → status ok | degraded | down + per-service checks
`);
    console.log('Alert types covered in suite:', ALERT_TYPES.join(', '));
    console.log('\nEnv check:');
    console.log('  MONGODB_URI:', process.env.MONGODB_URI ? 'set' : 'default localhost');
    console.log('  ADMIN_ALERT_EMAILS:', parseAdminEmails().join(', ') || '(not set)');
    console.log(
        '  SMTP:',
        process.env.SMTP_HOST && process.env.SMTP_USER ? 'configured' : 'missing — CRITICAL emails will fail'
    );
    console.log('  ALERT_DEDUP_COOLDOWN_MINUTES:', process.env.ALERT_DEDUP_COOLDOWN_MINUTES || '60 (default)');
}

async function phaseSeverity() {
    section('Phase 1 — Severity matrix (INFO / WARNING / CRITICAL)');

    const cases = [
        {
            name: '1a INFO',
            severity: 'INFO',
            type: 'SYSTEM_ERROR',
            title: `[${runId}] Test INFO alert`,
            source: 'test-alert-system.phase1',
        },
        {
            name: '1b WARNING',
            severity: 'WARNING',
            type: 'INTEGRATION_ERROR',
            title: `[${runId}] Test WARNING alert`,
            source: 'test-alert-system.phase1',
        },
        {
            name: '1c CRITICAL',
            severity: 'CRITICAL',
            type: 'DATABASE_ERROR',
            title: `[${runId}] Test CRITICAL alert`,
            source: 'test-alert-system.phase1',
            message: 'Script-generated CRITICAL — verify inbox and Admin UI',
            metadata: { stack: 'Error: Test stack trace\n    at test-alert-system.js:phase1' },
        },
    ];

    for (const c of cases) {
        const exp = expectedForSeverity(c.severity);
        console.log(`\n  → ${c.name}: DB=${exp.inDb} | Email=${exp.email}`);

        const alert = await createTestAlert({
            type: c.type,
            severity: c.severity,
            title: c.title,
            message: c.message || `Automated test message for ${c.severity}`,
            source: c.source,
            schoolId,
            schoolName,
            metadata: c.metadata,
        });

        let emailResult = { success: false, reason: 'not_critical' };
        if (c.severity === 'CRITICAL') {
            emailResult = await sendCriticalAlert(alert);
        }

        const passDb = !!alert && alert.severity === c.severity;
        record(
            `${c.name} saved to DB`,
            `severity=${c.severity}`,
            alert ? `id=${alert._id} severity=${alert.severity}` : 'null',
            passDb
        );

        if (c.severity === 'CRITICAL') {
            const expectedEmail = parseAdminEmails().length > 0 && process.env.SMTP_HOST;
            const passEmail =
                !expectedEmail
                    ? emailResult.reason === 'no_recipients' || !emailResult.success
                    : emailResult.success === true;
            record(
                `${c.name} email`,
                expectedEmail ? 'SMTP send success' : 'skip (no ADMIN_ALERT_EMAILS or SMTP)',
                JSON.stringify(emailResult),
                passEmail || !expectedEmail,
                expectedEmail ? 'Check your inbox for subject [CRITICAL] ...' : ''
            );
        } else {
            record(`${c.name} no email`, 'no email sent', 'skipped', true);
        }
    }
}

async function phaseAllTypes() {
    section('Phase 2 — All alert categories (WARNING only — avoids email flood)');

    for (const type of ALERT_TYPES) {
        const title = `[${runId}] Category ${type}`;
        const alert = await createTestAlert({
            type,
            severity: 'WARNING',
            title,
            message: `Simulated ${type} for admin filter testing`,
            source: `test-alert-system.phase2.${type}`,
            schoolId,
            schoolName,
        });
        record(`Type ${type}`, 'row created', alert ? alert.type : 'failed', !!alert);
    }
}

async function phaseDedupe() {
    section('Phase 3 — Dedupe (3 identical CRITICAL fires)');

    const title = `[${runId}] Dedupe probe CRITICAL`;
    const source = 'test-alert-system.phase3.dedupe';
    const ids = [];

    let emailCount = 0;
    for (let i = 1; i <= 3; i++) {
        const alert = await createTestAlert({
            type: 'OUTLOOK_ERROR',
            severity: 'CRITICAL',
            title,
            message: `Dedupe occurrence #${i}`,
            source,
            schoolId,
            schoolName,
            metadata: { occurrence: i },
        });
        ids.push(String(alert._id));
        const refreshed = await Alert.findById(alert._id).lean();
        emailCount = (refreshed?.emailTiersSent || []).length;
        console.log(`  Fire ${i}: id=${alert._id} count=${alert.occurrenceCount} emailTiers=${JSON.stringify(refreshed?.emailTiersSent)}`);
        await sleep(100);
    }

    const uniqueIds = [...new Set(ids)];
    const row = await Alert.findOne({ 'metadata.testRunId': runId, title }).lean();
    const passOneRow = uniqueIds.length === 1;
    const passCount = row && row.occurrenceCount >= 3;
    const passOneEmail = emailCount === 1 && (row?.emailTiersSent || []).includes('initial');

    record('Dedupe same document', '1 alert _id, occurrenceCount>=3', `ids=${uniqueIds.length} count=${row?.occurrenceCount}`, passOneRow && passCount);
    record('Dedupe email throttle', '1 email (initial tier only)', `tiers=${JSON.stringify(row?.emailTiersSent)}`, passOneEmail);
    console.log('\n  Admin UI: one row, occurrence count should be 3.');
    console.log('  Email: only 1 message for 3 fires; reminders at 1h/6h/24h if still active.');
}

async function phaseResolveReopen() {
    section('Phase 4 — Resolve then new alert');

    const title = `[${runId}] Resolve cycle probe`;
    const source = 'test-alert-system.phase4';

    const first = await createTestAlert({
        type: 'SIGNUP_ERROR',
        severity: 'WARNING',
        title,
        message: 'First occurrence before resolve',
        source,
        schoolId,
        schoolName,
    });

    await AlertService.resolve(first._id, null);
    const resolved = await Alert.findById(first._id).lean();
    record('Resolve', 'status=RESOLVED', resolved?.status, resolved?.status === 'RESOLVED');

    const second = await createTestAlert({
        type: 'SIGNUP_ERROR',
        severity: 'WARNING',
        title,
        message: 'Second occurrence after resolve',
        source,
        schoolId,
        schoolName,
    });

    const newDoc = String(first._id) !== String(second._id);
    record('New alert after resolve', 'different _id', `first=${first._id} second=${second._id}`, newDoc);
    console.log('  Admin UI: two rows with same title pattern (one RESOLVED, one ACTIVE).');
}

async function phaseAcknowledge() {
    section('Phase 5 — Acknowledge status');

    const alert = await createTestAlert({
        type: 'CRON_ERROR',
        severity: 'WARNING',
        title: `[${runId}] Acknowledge probe`,
        message: 'Test acknowledge flow',
        source: 'test-alert-system.phase5',
    });

    const acked = await AlertService.acknowledge(alert._id, null);
    record('Acknowledge', 'ACKNOWLEDGED', acked?.status, acked?.status === 'ACKNOWLEDGED');
    console.log('  Admin UI: use PATCH or drawer — status should show ACKNOWLEDGED.');
}

async function phaseGlobalVsSchool() {
    section('Phase 6 — Platform-wide vs school-scoped');

    const globalAlert = await createTestAlert({
        type: 'DATABASE_ERROR',
        severity: 'WARNING',
        title: `[${runId}] Platform-wide alert`,
        message: 'No schoolId — appears as — in UI',
        source: 'test-alert-system.phase6.global',
        schoolId: null,
        schoolName: null,
    });

    const schoolAlert = await createTestAlert({
        type: 'DATABASE_ERROR',
        severity: 'WARNING',
        title: `[${runId}] School-scoped alert`,
        message: `Scoped to ${schoolName}`,
        source: 'test-alert-system.phase6.school',
        schoolId,
        schoolName,
    });

    record('Global alert', 'schoolId null', globalAlert?.schoolId ? 'has schoolId' : 'null', !globalAlert?.schoolId);
    record('School alert', `schoolId=${schoolId}`, schoolAlert?.schoolId ? 'set' : 'null', !!schoolAlert?.schoolId);
}

async function phaseSimulatedProductionErrors() {
    section('Phase 7 — Simulated production scenarios (reference matrix)');

    const scenarios = [
        { type: 'OUTLOOK_ERROR', severity: 'CRITICAL', title: 'Outlook refresh token failed', source: 'calendarService.refreshOutlookToken', msg: 'invalid_grant — reconnect Outlook' },
        { type: 'AGENT_ERROR', severity: 'CRITICAL', title: 'Agent creation failed: Demo School', source: 'elevenlabs.createSchoolAgent', msg: 'createSchoolAgent returned null' },
        { type: 'OPENAI_ERROR', severity: 'WARNING', title: 'OpenAI transcript processing failed', source: 'openaiService.processTranscriptComprehensive', msg: 'API timeout' },
        { type: 'EMAIL_ERROR', severity: 'CRITICAL', title: 'Email send failed', source: 'mailService.sendEmail', msg: 'SMTP fallback failed' },
        { type: 'WEBHOOK_ERROR', severity: 'CRITICAL', title: 'ElevenLabs webhook processing failed', source: 'webhook.processWebhookAsync', msg: 'Async processor threw' },
        { type: 'PAYMENT_ERROR', severity: 'CRITICAL', title: 'PayPal top-up amount mismatch', source: 'billing.capture-order', msg: 'Expected $10, captured $9' },
        { type: 'SIGNUP_ERROR', severity: 'CRITICAL', title: 'School registration failed', source: 'auth.register', msg: 'Duplicate key error' },
        { type: 'CRON_ERROR', severity: 'WARNING', title: 'Reminder cron job failed', source: 'reminderService.cron', msg: 'Unhandled exception' },
        { type: 'RATE_LIMIT_ERROR', severity: 'CRITICAL', title: 'OpenAI API failure', source: 'openaiService', msg: 'HTTP 429' },
        { type: 'WEBHOOK_ERROR', severity: 'CRITICAL', title: 'PayPal webhook signature verification failed', source: 'paypalWebhook.verify', msg: 'Invalid signature' },
    ];

    console.log('\n  Scenario                          | Severity  | Admin UI | Email');
    console.log('  ' + '-'.repeat(68));
    for (const s of scenarios) {
        const exp = expectedForSeverity(s.severity);
        const emailShort = s.severity === 'CRITICAL' ? (parseAdminEmails().length ? 'YES' : 'NO*') : 'no';
        console.log(`  ${s.title.slice(0, 34).padEnd(34)} | ${s.severity.padEnd(9)} | yes      | ${emailShort}`);

        await createTestAlert({
            type: s.type,
            severity: s.severity,
            title: `[${runId}] ${s.title}`,
            message: s.msg,
            source: s.source,
            schoolId,
            schoolName,
            metadata: { simulated: true, scenario: s.title },
        });
        await sleep(50);
    }
    console.log('\n  * NO* = set ADMIN_ALERT_EMAILS + SMTP in .env');
}

async function phaseApi() {
    section('Phase 8 — Admin HTTP API');

    const email = process.env.TEST_ADMIN_EMAIL || 'admin@enrollmentai.com';
    const password = process.env.TEST_ADMIN_PASSWORD || 'admin123';

    try {
        const login = await axios.post(`${API_BASE}/auth/login`, { email, password });
        const token = login.data.token;
        if (!token) {
            record('Admin login', 'token', 'missing', false);
            return;
        }
        record('Admin login', 'JWT token', 'ok', true);

        const headers = { Authorization: `Bearer ${token}` };

        const stats = await axios.get(`${API_BASE}/admin/alerts/stats`, { headers });
        record('GET /admin/alerts/stats', 'activeCritical, last24h', JSON.stringify(stats.data).slice(0, 80) + '...', stats.status === 200);

        const list = await axios.get(`${API_BASE}/admin/alerts`, {
            headers,
            params: { search: runId, limit: 5 },
        });
        const found = list.data.alerts?.length > 0;
        record('GET /admin/alerts?search=runId', '>=1 alert', `count=${list.data.alerts?.length}`, found);

        if (list.data.alerts?.[0]) {
            const id = list.data.alerts[0]._id;
            const detail = await axios.get(`${API_BASE}/admin/alerts/${id}`, { headers });
            record('GET /admin/alerts/:id', '200 + title', detail.data?.title ? 'ok' : 'fail', detail.status === 200);
        }

        const health = await axios.get(`${API_BASE.replace('/api', '')}/api/health`);
        record('GET /api/health', 'checks object', health.data?.status || 'unknown', !!health.data?.checks);

        console.log('\n  Open frontend: /admin/notifications and /admin/dashboard');
    } catch (err) {
        record('Admin API', 'server reachable', err.message, false, `Start backend: npm run dev (PORT=${process.env.PORT || 5001})`);
    }
}

function printSummary() {
    section('SUMMARY');
    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass).length;
    console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);
    console.log(`  Test run id: ${runId}`);
    console.log(`  Tag file: ${TAG_FILE}`);
    console.log('\n  Manual verification checklist:');
    console.log('    [ ] Admin → Notifications — filter by search:', runId);
    console.log('    [ ] Dashboard — System alerts cards updated');
    console.log('    [ ] Inbox — CRITICAL emails only (not WARNING/INFO)');
    console.log('    [ ] Drawer — metadata, stack, Acknowledge / Resolve / Reopen');
    if (!FLAGS.keep) {
        console.log('\n  Test alerts will be cleaned up (--keep to leave them).');
    }
}

async function main() {
    if (FLAGS.plan) {
        printPlan();
        return;
    }

    if (FLAGS.cleanupOnly) {
        await connectDb();
        const tag = loadRunTag();
        const n = await cleanupRun(tag);
        log(`Cleaned up ${n} alert(s) for runId=${tag || 'any test-*'}`);
        await mongoose.disconnect();
        return;
    }

    printPlan();

    if (!FLAGS.yes && !FLAGS.apiOnly) {
        const criticalCount = parseAdminEmails().length;
        if (criticalCount) {
            console.log(`\n⚠️  This run will send CRITICAL emails to: ${parseAdminEmails().join(', ')}`);
            console.log('    Use --yes to skip this notice, or unset ADMIN_ALERT_EMAILS for dry CRITICAL tests.\n');
        }
    }

    if (FLAGS.apiOnly) {
        await phaseApi();
        printSummary();
        return;
    }

    await connectDb();
    await loadSchool();
    log(`Using school: ${schoolName} (${schoolId || 'none — global-only tests'})`);
    saveRunTag();

    try {
        await phaseSeverity();
        await phaseAllTypes();
        await phaseDedupe();
        await phaseResolveReopen();
        await phaseAcknowledge();
        await phaseGlobalVsSchool();
        await phaseSimulatedProductionErrors();

        if (!FLAGS.skipApi) {
            await phaseApi();
        }

        printSummary();

        if (!FLAGS.keep) {
            section('Cleanup');
            const n = await cleanupRun(runId);
            log(`  Deleted ${n} test alert(s) with testRunId=${runId}`);
            log('  Use --keep to inspect alerts in Admin UI before cleanup.');
        } else {
            log(`\n  Kept alerts tagged metadata.testRunId=${runId}`);
            log(`  Cleanup later: node scripts/test-alert-system.js --cleanup`);
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((err) => {
    console.error('Test script failed:', err);
    process.exit(1);
});
