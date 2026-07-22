const crypto = require('crypto');
const mongoose = require('mongoose');
const Alert = require('../models/Alert');
const School = require('../models/School');
const { sendCriticalAlert } = require('./adminAlertMailService');
const { buildEnrichedAlertMessage } = require('../utils/alertMessageFormatter');
const { resolveCriticalEmailTier } = require('../utils/alertEmailPolicy');

const DEDUP_COOLDOWN_MS = () => {
    const minutes = parseInt(process.env.ALERT_DEDUP_COOLDOWN_MINUTES || '60', 10);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
};

function normalizeTitle(title) {
    return String(title || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

function buildDedupeKey({ type, source, schoolId, title }) {
    const schoolPart = schoolId ? String(schoolId) : 'global';
    const payload = `${type}|${source}|${schoolPart}|${normalizeTitle(title)}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function mergeMetadata(existing, incoming) {
    const base = existing && typeof existing === 'object' ? { ...existing } : {};
    const next = incoming && typeof incoming === 'object' ? incoming : {};
    const merged = { ...base, ...next };
    if (next.stack && base.stack && next.stack !== base.stack) {
        merged.stack = `${base.stack}\n---\n${next.stack}`;
    }
    return merged;
}

async function resolveSchoolName(schoolId, schoolName) {
    if (schoolName) return schoolName;
    if (!schoolId) return null;
    try {
        const school = await School.findById(schoolId).select('name').lean();
        return school?.name || null;
    } catch {
        return null;
    }
}

async function deliverCriticalEmailIfNeeded(alert) {
    const tier = resolveCriticalEmailTier(alert);
    if (!tier) return { sent: false };

    const result = await sendCriticalAlert(alert, { escalationTier: tier });
    if (result.success) {
        await Alert.findByIdAndUpdate(alert._id, {
            $set: { lastEmailedAt: new Date() },
            $addToSet: { emailTiersSent: tier },
        });
        console.log(`[AlertService] CRITICAL email sent (tier=${tier}) for alert ${alert._id}`);
    }
    return { sent: result.success, tier, result };
}

async function createAlertInternal(payload) {
    const {
        type,
        severity,
        schoolId,
        schoolName: providedSchoolName,
        title,
        message,
        source,
        metadata = {},
    } = payload;

    if (!type || !severity || !title || !message || !source) {
        console.warn('[AlertService] create skipped: missing required fields', { type, severity, title, source });
        return null;
    }

    const effectiveSeverity =
        type === 'OUTLOOK_ERROR' || type === 'RATE_LIMIT_ERROR' ? 'CRITICAL' : severity;

    const mergedMetadata = {
        ...metadata,
        rawMessage: message,
    };
    const enrichedMessage = buildEnrichedAlertMessage({
        type,
        title,
        message,
        source,
        metadata: mergedMetadata,
    });

    const schoolIdStr = schoolId ? String(schoolId) : null;
    const schoolObjectId = schoolIdStr && mongoose.Types.ObjectId.isValid(schoolIdStr)
        ? new mongoose.Types.ObjectId(schoolIdStr)
        : null;

    const schoolName = await resolveSchoolName(schoolObjectId, providedSchoolName);
    const dedupeKey = buildDedupeKey({ type, source, schoolId: schoolIdStr, title });
    const now = new Date();
    const cooldownSince = new Date(now.getTime() - DEDUP_COOLDOWN_MS());

    const existing = await Alert.findOne({
        dedupeKey,
        status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] },
        lastOccurredAt: { $gte: cooldownSince },
    }).sort({ lastOccurredAt: -1 });

    let alert;
    if (existing) {
        existing.occurrenceCount += 1;
        existing.lastOccurredAt = now;
        existing.message = enrichedMessage;
        existing.metadata = mergeMetadata(existing.metadata, mergedMetadata);
        if (schoolName) existing.schoolName = schoolName;
        if (effectiveSeverity === 'CRITICAL' && existing.severity !== 'CRITICAL') {
            existing.severity = 'CRITICAL';
        }
        await existing.save();
        alert = existing;
    } else {
        alert = await Alert.create({
            type,
            severity: effectiveSeverity,
            status: 'ACTIVE',
            title,
            message: enrichedMessage,
            schoolId: schoolObjectId,
            schoolName,
            source,
            metadata: mergedMetadata,
            dedupeKey,
            occurrenceCount: 1,
            firstOccurredAt: now,
            lastOccurredAt: now,
            emailTiersSent: [],
            lastEmailedAt: null,
        });
    }

    if (effectiveSeverity === 'CRITICAL') {
        try {
            await deliverCriticalEmailIfNeeded(alert);
        } catch (err) {
            console.error('[AlertService] Critical email failed:', err.message);
        }
    }

    return alert;
}

const AlertService = {
    /**
     * Create or dedupe an alert (non-blocking).
     */
    create(payload) {
        setImmediate(() => {
            createAlertInternal(payload).catch((err) => {
                console.error('[AlertService] create failed:', err.message);
            });
        });
    },

    async acknowledge(alertId, adminUserId) {
        const alert = await Alert.findByIdAndUpdate(
            alertId,
            {
                status: 'ACKNOWLEDGED',
                acknowledgedAt: new Date(),
                acknowledgedBy: adminUserId || null,
            },
            { new: true }
        );
        return alert;
    },

    async resolve(alertId, adminUserId) {
        const alert = await Alert.findByIdAndUpdate(
            alertId,
            {
                status: 'RESOLVED',
                resolvedAt: new Date(),
                resolvedBy: adminUserId || null,
            },
            { new: true }
        );
        return alert;
    },

    async reopen(alertId) {
        const alert = await Alert.findByIdAndUpdate(
            alertId,
            {
                status: 'ACTIVE',
                resolvedAt: null,
                resolvedBy: null,
                acknowledgedAt: null,
                acknowledgedBy: null,
            },
            { new: true }
        );
        return alert;
    },

    buildDedupeKey,
    createAlertInternal,
};

module.exports = AlertService;
