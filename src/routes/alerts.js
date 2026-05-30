const express = require('express');
const mongoose = require('mongoose');
const Alert = require('../models/Alert');
const AlertService = require('../services/alertService');
const { ALERT_TYPES, ALERT_SEVERITIES, ALERT_STATUSES } = require('../models/Alert');

const router = express.Router();

// GET /api/admin/alerts/stats
router.get('/stats', async (req, res) => {
    try {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [activeCritical, activeWarnings, last24h, topSchools] = await Promise.all([
            Alert.countDocuments({ severity: 'CRITICAL', status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } }),
            Alert.countDocuments({ severity: 'WARNING', status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } }),
            Alert.countDocuments({ createdAt: { $gte: since24h } }),
            Alert.aggregate([
                { $match: { schoolId: { $ne: null }, status: { $in: ['ACTIVE', 'ACKNOWLEDGED'] } } },
                { $group: { _id: '$schoolId', schoolName: { $first: '$schoolName' }, count: { $sum: '$occurrenceCount' } } },
                { $sort: { count: -1 } },
                { $limit: 5 },
                {
                    $project: {
                        schoolId: '$_id',
                        schoolName: 1,
                        count: 1,
                        _id: 0,
                    },
                },
            ]),
        ]);

        res.json({
            activeCritical,
            activeWarnings,
            last24h,
            topSchools,
        });
    } catch (err) {
        console.error('[alerts/stats]', err);
        res.status(500).json({ error: 'Failed to load alert stats' });
    }
});

// GET /api/admin/alerts
router.get('/', async (req, res) => {
    try {
        const {
            severity,
            type,
            status,
            schoolId,
            search,
            page = '1',
            limit = '25',
        } = req.query;

        const filter = {};
        if (severity && ALERT_SEVERITIES.includes(severity)) filter.severity = severity;
        if (type && ALERT_TYPES.includes(type)) filter.type = type;
        if (status && ALERT_STATUSES.includes(status)) filter.status = status;
        if (schoolId && mongoose.Types.ObjectId.isValid(schoolId)) {
            filter.schoolId = new mongoose.Types.ObjectId(schoolId);
        }
        if (search && String(search).trim()) {
            const q = String(search).trim();
            filter.$or = [
                { title: { $regex: q, $options: 'i' } },
                { message: { $regex: q, $options: 'i' } },
                { schoolName: { $regex: q, $options: 'i' } },
                { source: { $regex: q, $options: 'i' } },
            ];
        }

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
        const skip = (pageNum - 1) * limitNum;

        const [alerts, total] = await Promise.all([
            Alert.find(filter)
                .sort({ lastOccurredAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Alert.countDocuments(filter),
        ]);

        res.json({
            alerts,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum),
            },
        });
    } catch (err) {
        console.error('[alerts/list]', err);
        res.status(500).json({ error: 'Failed to load alerts' });
    }
});

// GET /api/admin/alerts/:id
router.get('/:id', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid alert id' });
        }
        const alert = await Alert.findById(req.params.id)
            .populate('schoolId', 'name aiNumber status')
            .lean();
        if (!alert) return res.status(404).json({ error: 'Alert not found' });
        res.json(alert);
    } catch (err) {
        console.error('[alerts/detail]', err);
        res.status(500).json({ error: 'Failed to load alert' });
    }
});

// PATCH /api/admin/alerts/:id/status
router.patch('/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!ALERT_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ error: 'Invalid alert id' });
        }

        const adminUserId = req.user?.id;
        let alert;

        if (status === 'ACKNOWLEDGED') {
            alert = await AlertService.acknowledge(req.params.id, adminUserId);
        } else if (status === 'RESOLVED') {
            alert = await AlertService.resolve(req.params.id, adminUserId);
        } else if (status === 'ACTIVE') {
            alert = await AlertService.reopen(req.params.id);
        }

        if (!alert) return res.status(404).json({ error: 'Alert not found' });
        res.json(alert);
    } catch (err) {
        console.error('[alerts/status]', err);
        res.status(500).json({ error: 'Failed to update alert status' });
    }
});

module.exports = router;
