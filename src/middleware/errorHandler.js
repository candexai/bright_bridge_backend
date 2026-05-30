const AlertService = require('../services/alertService');

function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    const statusCode = err.statusCode || err.status || 500;
    const isServerError = statusCode >= 500;
    const shouldAlert = isServerError || err.forceAlert === true;

    if (shouldAlert) {
        AlertService.create({
            type: err.alertType || 'SYSTEM_ERROR',
            severity: err.alertSeverity || 'CRITICAL',
            title: err.alertTitle || `Unhandled ${req.method} ${req.path}`,
            message: err.message || 'Internal server error',
            source: 'errorHandler',
            metadata: {
                stack: err.stack,
                method: req.method,
                path: req.originalUrl || req.path,
                statusCode,
                bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : [],
            },
        });
    }

    console.error('[errorHandler]', err.message, { path: req.path, statusCode });

    const isProd = process.env.NODE_ENV === 'production';
    res.status(statusCode).json({
        error: isServerError && isProd ? 'Internal server error' : (err.message || 'Internal server error'),
        ...(isServerError && !isProd && err.stack ? { stack: err.stack } : {}),
    });
}

module.exports = { errorHandler, asyncHandler };
