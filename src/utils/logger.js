const AlertService = require('../services/alertService');

function formatMeta(meta) {
    if (!meta || Object.keys(meta).length === 0) return '';
    try {
        return JSON.stringify(meta);
    } catch {
        return String(meta);
    }
}

function dispatchAlert(meta) {
    if (!meta?.alert) return;
    const { alert } = meta;
    AlertService.create({
        type: alert.type || 'UNKNOWN_ERROR',
        severity: alert.severity || 'WARNING',
        schoolId: alert.schoolId,
        schoolName: alert.schoolName,
        title: alert.title || 'Alert',
        message: alert.message || meta.message || '',
        source: alert.source || 'logger',
        metadata: alert.metadata || {},
    });
}

const logger = {
    info(msg, meta) {
        console.log(`[INFO] ${msg}`, formatMeta(meta));
    },

    warn(msg, meta) {
        console.warn(`[WARN] ${msg}`, formatMeta(meta));
        if (meta?.alert) dispatchAlert(meta);
    },

    error(msg, meta) {
        console.error(`[ERROR] ${msg}`, formatMeta(meta));
        if (meta?.alert) dispatchAlert(meta);
    },
};

module.exports = logger;
