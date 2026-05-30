const Integration = require('../models/Integration');
const AlertService = require('../services/alertService');

/**
 * MSAL Token Cache Plugin for MongoDB persistence.
 * This plugin ensures that MSAL tokens (including refresh tokens) are stored in the Integration model.
 */
function createMsalCachePlugin(schoolId) {
    return {
        beforeCacheAccess: async (cacheContext) => {
            try {
                const integration = await Integration.findOne({ schoolId, type: 'outlook' }).lean();
                if (integration?.config?.msalCache) {
                    cacheContext.tokenCache.deserialize(integration.config.msalCache);
                    console.log(`[MSAL Cache] Successfully loaded cache for school ${schoolId} (length: ${integration.config.msalCache.length})`);
                } else {
                    console.warn(`[MSAL Cache] No cache found for school ${schoolId}`);
                }
            } catch (err) {
                console.error(`[MSAL Cache] Error reading cache for school ${schoolId}:`, err.message);
            }
        },
        afterCacheAccess: async (cacheContext) => {
            if (cacheContext.cacheHasChanged) {
                try {
                    const msalCache = cacheContext.tokenCache.serialize();
                    await Integration.updateOne(
                        { schoolId, type: 'outlook' },
                        { $set: { 'config.msalCache': msalCache } }
                    );
                    console.log(`[MSAL Cache] Cache updated and persisted for school ${schoolId} (new length: ${msalCache.length})`);
                } catch (err) {
                    console.error(`[MSAL Cache] Error writing cache for school ${schoolId}:`, err.message);
                    AlertService.create({
                        type: 'OUTLOOK_ERROR',
                        severity: 'WARNING',
                        schoolId,
                        title: 'Outlook MSAL cache persist failed',
                        message: err.message,
                        source: 'msalTokenCache.afterCacheAccess',
                        metadata: { stack: err.stack },
                    });
                }
            }
        }
    };
}

module.exports = { createMsalCachePlugin };
