const Integration = require('../models/Integration');

function normalizeMsalCache(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
        try {
            return JSON.stringify(raw);
        } catch {
            return null;
        }
    }
    return null;
}

function logOutlookCacheAlert(schoolId, title, message, metadata = {}) {
    try {
        const AlertService = require('../services/alertService');
        if (typeof AlertService?.create === 'function') {
            AlertService.create({
                type: 'OUTLOOK_ERROR',
                severity: 'WARNING',
                schoolId,
                title,
                message,
                source: 'msalTokenCache',
                metadata,
            });
        }
    } catch (alertErr) {
        console.error('[MSAL Cache] Failed to create alert:', alertErr.message);
    }
}

/**
 * MSAL Token Cache Plugin for MongoDB persistence.
 * This plugin ensures that MSAL tokens (including refresh tokens) are stored in the Integration model.
 */
function createMsalCachePlugin(schoolId) {
    return {
        beforeCacheAccess: async (cacheContext) => {
            try {
                const integration = await Integration.findOne({ schoolId, type: 'outlook' }).lean();
                const msalCache = normalizeMsalCache(integration?.config?.msalCache);
                if (msalCache) {
                    cacheContext.tokenCache.deserialize(msalCache);
                    console.log(`[MSAL Cache] Loaded cache for school ${schoolId} (length: ${msalCache.length})`);
                } else if (integration?.config?.msalCache) {
                    console.warn(`[MSAL Cache] Ignoring invalid cache for school ${schoolId}; starting fresh`);
                    await Integration.updateOne(
                        { schoolId, type: 'outlook' },
                        { $unset: { 'config.msalCache': '' } }
                    );
                }
            } catch (err) {
                console.error(`[MSAL Cache] Error reading cache for school ${schoolId}:`, err.message);
            }
        },
        afterCacheAccess: async (cacheContext) => {
            if (!cacheContext.cacheHasChanged) return;

            try {
                const msalCache = cacheContext.tokenCache.serialize();
                if (typeof msalCache !== 'string') {
                    throw new Error('MSAL serialize did not return a string');
                }
                await Integration.updateOne(
                    { schoolId, type: 'outlook' },
                    { $set: { 'config.msalCache': msalCache } }
                );
                console.log(`[MSAL Cache] Cache persisted for school ${schoolId} (length: ${msalCache.length})`);
            } catch (err) {
                console.error(`[MSAL Cache] Error writing cache for school ${schoolId}:`, err.message);
                logOutlookCacheAlert(
                    schoolId,
                    'Outlook MSAL cache persist failed',
                    err.message,
                    { stack: err.stack }
                );
            }
        },
    };
}

module.exports = { createMsalCachePlugin, normalizeMsalCache };
