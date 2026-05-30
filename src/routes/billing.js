const express = require('express');
const School = require('../models/School');
const BillingTransaction = require('../models/BillingTransaction');
const MinuteLedger = require('../models/MinuteLedger');
const { authMiddleware, schoolOnly } = require('../middleware/auth');
const { listPlansPublic, getPlanDef, resolvePaypalPlanId, paypalPlansConfigured } = require('../config/billingPlans');
const {
    computeTopupUsd,
    getTopupPricingForClient,
    validateTopupMinutes,
} = require('../config/topupPricing');
const {
    appendCouponMeta,
    completeCouponRedemption,
    computeCouponDiscount,
    parseCouponMetaFromCustomId,
    round2,
} = require('../services/couponService');
const AlertService = require('../services/alertService');

function formatPayPalApiError(err) {
    const d = err.response?.data;
    if (!d) return err.message || 'Failed to create subscription';
    if (typeof d === 'string') return d;
    if (d.message) return d.message;
    if (Array.isArray(d.details) && d.details.length) {
        const parts = d.details
            .map((x) => x.description || x.issue || (typeof x === 'string' ? x : ''))
            .filter(Boolean);
        if (parts.length) return parts.join(' ');
    }
    if (d.name && d.message) return `${d.name}: ${d.message}`;
    return err.message || 'Failed to create subscription';
}
const {
    createSubscription,
    createOrder,
    getSubscription,
} = require('../services/paypalService');
const { grantMinutes, recordTransaction } = require('../services/billingService');

const router = express.Router();

function resolveFrontendBaseUrl(req) {
    // Keep backwards compatibility: prefer explicit FRONTEND_BASE_URL if set,
    // otherwise reuse FORM_BASE_URL so production only needs one frontend URL env.
    const envUrl = String(process.env.FRONTEND_BASE_URL || process.env.FORM_BASE_URL || '').trim();
    if (envUrl) return envUrl.replace(/\/+$/, '');
    const origin = String(req.get('origin') || '').trim();
    if (origin) return origin.replace(/\/+$/, '');
    const referer = String(req.get('referer') || '').trim();
    if (referer) {
        try {
            const u = new URL(referer);
            return `${u.protocol}//${u.host}`.replace(/\/+$/, '');
        } catch (err) {
            // ignore malformed referer
        }
    }
    return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

/** Public plan catalog (for pricing page) */
router.get('/plans', (req, res) => {
    try {
        res.json({ plans: listPlansPublic() });
    } catch (err) {
        console.error('[billing/plans]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.use(authMiddleware, schoolOnly);

// POST /api/billing/coupon/preview { orderType, minutes?, planKey?, amountUsd?, couponCode }
router.post('/coupon/preview', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { orderType, planKey, minutes, amountUsd, couponCode } = req.body || {};
        if (!couponCode) return res.status(400).json({ error: 'couponCode is required' });
        if (!['topup', 'onboarding', 'subscription'].includes(orderType)) {
            return res.status(400).json({ error: 'orderType must be topup, onboarding, or subscription' });
        }
        let baseAmount = Number(amountUsd || 0);
        if (orderType === 'topup') {
            const mins = parseInt(minutes, 10);
            const valid = validateTopupMinutes(mins);
            if (!valid.ok) return res.status(400).json({ error: valid.error });
            baseAmount = computeTopupUsd(mins);
        } else if (orderType === 'subscription') {
            const def = getPlanDef(planKey || '');
            if (!def) return res.status(400).json({ error: 'Invalid planKey for subscription preview' });
            baseAmount = def.monthlyUsd;
        }
        if (!Number.isFinite(baseAmount) || baseAmount < 0.01) {
            return res.status(400).json({ error: 'Invalid amount for coupon preview' });
        }
        const result = await computeCouponDiscount({
            schoolId,
            couponCode,
            orderType,
            amountUsd: baseAmount,
            planKey: planKey || '',
        });
        if (!result.ok) {
            return res.status(400).json({ error: result.error || 'Invalid coupon' });
        }
        return res.json({
            couponApplied: result.applied,
            couponCode: result.couponCode,
            couponName: result.couponName || '',
            originalAmountUsd: result.originalAmountUsd,
            discountAmountUsd: result.discountAmountUsd,
            finalAmountUsd: result.finalAmountUsd,
        });
    } catch (err) {
        console.error('[billing/coupon/preview]', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/billing/status
router.get('/status', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        if (!schoolId) {
            return res.status(400).json({ error: 'No school associated with this account' });
        }
        const school = await School.findById(schoolId).lean();
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }
        const plan = school.subscriptionPlanKey ? getPlanDef(school.subscriptionPlanKey) : null;
        const minuteAgg = await MinuteLedger.aggregate([
            { $match: { schoolId: school._id, reason: { $in: ['topup', 'monthly_allocation'] } } },
            {
                $group: {
                    _id: '$reason',
                    total: { $sum: '$deltaMinutes' },
                },
            },
        ]);
        const minuteMap = minuteAgg.reduce((acc, row) => {
            acc[row._id] = Number(row.total || 0);
            return acc;
        }, {});
        const includedPlanMinutes = plan?.includedMinutesPerMonth || 0;
        const topupFromLedger = Math.max(0, Math.round(minuteMap.topup || 0));
        // Fallback: for legacy schools where top-up ledger entries may be missing,
        // infer top-up purchased from current positive balance.
        const inferredTopup = typeof school.minuteBalance === 'number'
            ? Math.max(0, Math.round(school.minuteBalance))
            : 0;
        const topupMinutesPurchased = topupFromLedger > 0 ? topupFromLedger : inferredTopup;
        const totalPurchasedMinutes = includedPlanMinutes + topupMinutesPurchased;

        res.json({
            billingMode: school.billingMode || 'none',
            subscriptionPlanKey: school.subscriptionPlanKey || '',
            subscriptionStatus: school.subscriptionStatus || 'none',
            minuteBalance: typeof school.minuteBalance === 'number' ? school.minuteBalance : null,
            foundingPartner: Boolean(school.foundingPartner),
            onboardingFeePaid: Boolean(school.onboardingFeePaid),
            paypalSubscriptionId: school.paypalSubscriptionId || '',
            lastBillingCyclePaymentAt: school.lastBillingCyclePaymentAt || null,
            planDetails: plan
                ? {
                      monthlyUsd: plan.monthlyUsd,
                      onboardingUsd: plan.onboardingUsd,
                      includedMinutesPerMonth: plan.includedMinutesPerMonth,
                  }
                : null,
            minuteBreakdown: {
                includedPlanMinutes,
                topupMinutesPurchased,
                totalAvailable: totalPurchasedMinutes,
            },
            topupPricing: getTopupPricingForClient(),
            paypalPlansConfigured: paypalPlansConfigured({
                foundingPartner: Boolean(school.foundingPartner),
            }),
        });
    } catch (err) {
        console.error('[billing/status]', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/billing/subscribe  { planKey: 'starter'|'growth'|'full_enrollment'|'demo', returnUrl, cancelUrl }
router.post('/subscribe', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { planKey, returnUrl, cancelUrl, couponCode } = req.body || {};
        if (!planKey || !getPlanDef(planKey)) {
            return res.status(400).json({ error: 'Invalid planKey' });
        }
        if (!returnUrl || !cancelUrl) {
            return res.status(400).json({ error: 'returnUrl and cancelUrl are required' });
        }

        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        // If a subscription is already active, avoid duplicate subscribe flows.
        if (school.subscriptionStatus === 'active' && school.subscriptionPlanKey === planKey) {
            return res.json({
                alreadyActive: true,
                message: 'Subscription is already active for this plan.',
                subscriptionId: school.paypalSubscriptionId || '',
            });
        }

        // If a subscription is pending approval, create a fresh approval subscription with current
        // return/cancel URLs (old pending ones may contain stale callback hosts like :5001).
        // This does not create another discounted first-payment charge; it only refreshes approval.
        if (school.subscriptionStatus === 'approval_pending' && school.paypalSubscriptionId) {
            try {
                const pending = await getSubscription(school.paypalSubscriptionId);
                const st = String(pending.status || '').toUpperCase();
                if (st === 'APPROVAL_PENDING' || st === 'APPROVED') {
                    const refreshCustomId = `school:${school._id.toString()};plan:${planKey}`;
                    const refreshedSub = await createSubscription({
                        planId: resolvePaypalPlanId(planKey, { foundingPartner: school.foundingPartner }),
                        customId: refreshCustomId,
                        returnUrl,
                        cancelUrl,
                        brandName: process.env.PAYPAL_BRAND_NAME || 'Nora',
                    });
                    school.paypalSubscriptionId = refreshedSub.id || school.paypalSubscriptionId;
                    school.subscriptionPlanKey = planKey;
                    school.subscriptionStatus = 'approval_pending';
                    await school.save();
                    const approve = Array.isArray(refreshedSub.links)
                        ? refreshedSub.links.find((l) => l.rel === 'approve' && l.href)
                        : null;
                    if (approve?.href) {
                        return res.json({
                            pendingApproval: true,
                            refreshed: true,
                            subscriptionId: refreshedSub.id || school.paypalSubscriptionId,
                            status: refreshedSub.status || 'APPROVAL_PENDING',
                            approvalUrl: approve.href,
                        });
                    }
                }
            } catch (e) {
                console.warn('[billing/subscribe] could not fetch pending subscription:', e.message);
            }
        }

        const couponResult = await computeCouponDiscount({
            schoolId: school._id,
            couponCode,
            orderType: 'subscription',
            amountUsd: getPlanDef(planKey).monthlyUsd,
            planKey,
        });
        if (!couponResult.ok) {
            return res.status(400).json({ error: couponResult.error || 'Invalid coupon' });
        }

        const planId = resolvePaypalPlanId(planKey, { foundingPartner: school.foundingPartner });
        if (!planId) {
            return res.status(503).json({
                error:
                    'PayPal plan is not configured for this tier. Set the matching PAYPAL_PLAN_* env var in the server.',
            });
        }

        // If coupon applies to subscription, charge discounted first payment as one-time order.
        // After capture, backend will create normal recurring subscription at full plan price.
        if (couponResult.applied && couponResult.discountAmountUsd > 0) {
            let customId = `school:${school._id.toString()};type:subscription_first;plan:${planKey}`;
            customId = appendCouponMeta(customId, couponResult.couponCode, couponResult.discountAmountUsd);
            const order = await createOrder({
                amountUsd: couponResult.finalAmountUsd,
                currency: 'USD',
                customId,
                description: `Nora first payment — ${getPlanDef(planKey).tier}`,
                returnUrl,
                cancelUrl,
            });
            const approve = Array.isArray(order.links)
                ? order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
                : null;
            return res.json({
                requiresFirstPayment: true,
                orderId: order.id,
                status: order.status,
                approvalUrl: approve?.href || null,
                couponCode: couponResult.couponCode || '',
                originalAmountUsd: couponResult.originalAmountUsd,
                discountAmountUsd: couponResult.discountAmountUsd,
                amountUsd: couponResult.finalAmountUsd,
            });
        }

        let customId = `school:${school._id.toString()};plan:${planKey}`;
        const sub = await createSubscription({
            planId,
            customId,
            returnUrl,
            cancelUrl,
            brandName: process.env.PAYPAL_BRAND_NAME || 'Nora',
        });

        school.subscriptionPlanKey = planKey;
        school.subscriptionStatus = 'approval_pending';
        school.paypalSubscriptionId = sub.id || '';
        await school.save();

        const approve = Array.isArray(sub.links)
            ? sub.links.find((l) => l.rel === 'approve' && l.href)
            : null;

        res.json({
            subscriptionId: sub.id,
            status: sub.status,
            approvalUrl: approve?.href || null,
            couponCode: '',
            discountAmountUsd: 0,
        });
    } catch (err) {
        console.error('[billing/subscribe]', err.response?.data || err.message);
        const status = err.response?.status;
        const httpStatus = status && status >= 400 && status < 600 ? status : 500;
        res.status(httpStatus).json({
            error: formatPayPalApiError(err),
        });
    }
});

// POST /api/billing/sync-subscription  { subscriptionId } — after return from PayPal (optional; webhook is authoritative)
router.post('/sync-subscription', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { subscriptionId } = req.body || {};
        if (!subscriptionId) {
            return res.status(400).json({ error: 'subscriptionId is required' });
        }

        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const remote = await getSubscription(subscriptionId);
        if (remote.id !== school.paypalSubscriptionId && school.paypalSubscriptionId) {
            return res.status(403).json({ error: 'Subscription does not match this school' });
        }

        school.paypalSubscriptionId = remote.id;
        const st = (remote.status || '').toUpperCase();
        if (st === 'ACTIVE') {
            school.subscriptionStatus = 'active';
            school.billingMode = 'metered';
        }
        await school.save();

        res.json({
            subscriptionId: remote.id,
            status: remote.status,
            subscriptionStatus: school.subscriptionStatus,
        });
    } catch (err) {
        console.error('[billing/sync-subscription]', err.response?.data || err.message);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// POST /api/billing/onboarding-order { planKey } — one-time onboarding fee (waived for founding partners)
router.post('/onboarding-order', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { planKey } = req.body || {};
        const def = planKey ? getPlanDef(planKey) : null;
        if (!def) {
            return res.status(400).json({ error: 'Invalid planKey' });
        }

        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }
        if (school.foundingPartner) {
            return res.json({
                skipped: true,
                reason: 'founding_partner',
                message: 'Onboarding fee waived for founding partners.',
            });
        }
        if (school.onboardingFeePaid) {
            return res.json({
                skipped: true,
                reason: 'already_paid',
                message: 'Onboarding fee already recorded as paid.',
            });
        }

        const couponResult = await computeCouponDiscount({
            schoolId: school._id,
            couponCode: req.body?.couponCode,
            orderType: 'onboarding',
            amountUsd: def.onboardingUsd,
            planKey,
        });
        if (!couponResult.ok) {
            return res.status(400).json({ error: couponResult.error || 'Invalid coupon' });
        }

        let customId = `school:${school._id.toString()};type:onboarding;plan:${planKey}`;
        customId = appendCouponMeta(customId, couponResult.couponCode, couponResult.discountAmountUsd);
        const { returnUrl, cancelUrl } = req.body || {};
        const frontendBase = resolveFrontendBaseUrl(req);
        const base = (returnUrl && cancelUrl)
            ? { returnUrl, cancelUrl }
            : {
                returnUrl: `${frontendBase}/school/billing?sub=return`,
                cancelUrl: `${frontendBase}/school/billing?sub=cancel`,
            };
        const order = await createOrder({
            amountUsd: couponResult.finalAmountUsd,
            currency: 'USD',
            customId,
            description: `Nora onboarding — ${def.tier}`,
            returnUrl: base.returnUrl,
            cancelUrl: base.cancelUrl,
        });

        const approve = Array.isArray(order.links)
            ? order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
            : null;

        res.json({
            orderId: order.id,
            status: order.status,
            approvalUrl: approve?.href || null,
            amountUsd: couponResult.finalAmountUsd,
            originalAmountUsd: couponResult.originalAmountUsd,
            discountAmountUsd: couponResult.discountAmountUsd,
            couponCode: couponResult.couponCode || '',
        });
    } catch (err) {
        console.error('[billing/onboarding-order]', err.response?.data || err.message);
        res.status(500).json({
            error: err.response?.data?.message || err.message || 'Failed to create onboarding order',
        });
    }
});

// POST /api/billing/topup-order — create PayPal order for extra minutes (capture on client or separate endpoint)
router.post('/topup-order', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const topupMinutes = parseInt((req.body || {}).minutes, 10);
        const valid = validateTopupMinutes(topupMinutes);
        if (!valid.ok) {
            return res.status(400).json({ error: valid.error });
        }

        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }
        if (school.billingMode !== 'metered' || school.subscriptionStatus !== 'active') {
            return res.status(400).json({
                error: 'Top-up is available for schools with an active metered subscription.',
            });
        }

        const topupUsd = computeTopupUsd(topupMinutes);
        if (topupUsd < 0.01) {
            return res.status(400).json({ error: 'Amount too small.' });
        }

        const couponResult = await computeCouponDiscount({
            schoolId: school._id,
            couponCode: req.body?.couponCode,
            orderType: 'topup',
            amountUsd: topupUsd,
            planKey: school.subscriptionPlanKey || '',
        });
        if (!couponResult.ok) {
            return res.status(400).json({ error: couponResult.error || 'Invalid coupon' });
        }

        let customId = `school:${school._id.toString()};type:topup;minutes:${topupMinutes}`;
        customId = appendCouponMeta(customId, couponResult.couponCode, couponResult.discountAmountUsd);
        const { returnUrl, cancelUrl } = req.body || {};
        const frontendBase = resolveFrontendBaseUrl(req);
        const base = (returnUrl && cancelUrl)
            ? { returnUrl, cancelUrl }
            : {
                returnUrl: `${frontendBase}/school/billing?sub=return`,
                cancelUrl: `${frontendBase}/school/billing?sub=cancel`,
            };
        const order = await createOrder({
            amountUsd: couponResult.finalAmountUsd,
            currency: 'USD',
            customId,
            description: `Nora top-up: ${topupMinutes} minutes`,
            returnUrl: base.returnUrl,
            cancelUrl: base.cancelUrl,
        });

        const approve = Array.isArray(order.links)
            ? order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')
            : null;

        res.json({
            orderId: order.id,
            status: order.status,
            approvalUrl: approve?.href || null,
            topupMinutes,
            amountUsd: couponResult.finalAmountUsd,
            originalAmountUsd: couponResult.originalAmountUsd,
            discountAmountUsd: couponResult.discountAmountUsd,
            couponCode: couponResult.couponCode || '',
        });
    } catch (err) {
        console.error('[billing/topup-order]', err.response?.data || err.message);
        res.status(500).json({
            error: err.response?.data?.message || err.message || 'Failed to create order',
        });
    }
});

// POST /api/billing/capture-order { orderId } — after PayPal redirects back (Orders API)
router.post('/capture-order', async (req, res) => {
    try {
        const schoolId = req.user.schoolId;
        const { orderId } = req.body || {};
        if (!orderId) {
            return res.status(400).json({ error: 'orderId is required' });
        }

        const school = await School.findById(schoolId);
        if (!school) {
            return res.status(404).json({ error: 'School not found' });
        }

        const { captureOrder } = require('../services/paypalService');
        const captured = await captureOrder(orderId);

        const purchaseUnit = captured.purchase_units && captured.purchase_units[0];
        const cap = purchaseUnit?.payments?.captures?.[0];
        const captureId = cap?.id || '';
        const customId = cap?.custom_id || purchaseUnit?.custom_id || '';
        const sid = customId.match(/school:([^;]+)/);
        if (!sid || sid[1] !== school._id.toString()) {
            return res.status(403).json({ error: 'Order does not belong to this school' });
        }

        if (captureId) {
            const dup = await BillingTransaction.findOne({ paypalSaleId: captureId }).lean();
            if (dup) {
                const refreshed = await School.findById(schoolId).lean();
                return res.json({
                    ok: true,
                    duplicate: true,
                    minuteBalance: refreshed?.minuteBalance ?? null,
                });
            }
        }

        const amount = cap ? parseFloat(cap.amount.value) : 0;
        const currency = cap?.amount?.currency_code || 'USD';
        const couponMeta = parseCouponMetaFromCustomId(customId);

        if (customId.includes('type:topup')) {
            let minutes = 0;
            const m = customId.match(/minutes:(\d+)/);
            if (m) minutes = parseInt(m[1], 10);
            if (!minutes || minutes < 1) {
                return res.status(400).json({ error: 'Invalid top-up minutes on order.' });
            }

            const expectedUsd = round2(computeTopupUsd(minutes) - couponMeta.discountUsd);
            if (Math.abs(amount - expectedUsd) > 0.03) {
                console.warn('[billing/capture-order] top-up amount mismatch', { minutes, expectedUsd, amount });
                AlertService.create({
                    type: 'PAYMENT_ERROR',
                    severity: 'CRITICAL',
                    schoolId: school._id,
                    schoolName: school.name,
                    title: 'PayPal top-up amount mismatch',
                    message: `Expected $${expectedUsd}, captured $${amount}`,
                    source: 'billing.capture-order',
                    metadata: { minutes, expectedUsd, amount, orderId },
                });
                return res.status(400).json({ error: 'Captured amount does not match this top-up.' });
            }

            await grantMinutes(school._id, minutes, 'topup', { orderId, captureId });
            await recordTransaction({
                schoolId: school._id,
                type: 'topup',
                amount,
                currency,
                status: 'completed',
                paypalOrderId: orderId,
                paypalSaleId: captureId,
                description: couponMeta.couponCode
                    ? `Top-up ${minutes} minutes (coupon ${couponMeta.couponCode} -$${couponMeta.discountUsd.toFixed(2)})`
                    : `Top-up ${minutes} minutes`,
                rawEventType: 'capture_order',
            });
            if (couponMeta.couponCode && couponMeta.discountUsd > 0) {
                await completeCouponRedemption({
                    schoolId: school._id,
                    couponCode: couponMeta.couponCode,
                    orderType: 'topup',
                    planKey: school.subscriptionPlanKey || '',
                    paypalOrderId: orderId,
                    paypalCaptureId: captureId || '',
                    originalAmountUsd: computeTopupUsd(minutes),
                    discountAmountUsd: couponMeta.discountUsd,
                    finalAmountUsd: amount,
                    meta: { minutes },
                });
            }

            const refreshed = await School.findById(schoolId).lean();
            return res.json({
                ok: true,
                minutesAdded: minutes,
                minuteBalance: refreshed?.minuteBalance ?? null,
            });
        }

        if (customId.includes('type:onboarding')) {
            const planMatch = customId.match(/plan:([^;]+)/);
            const planKey = planMatch ? planMatch[1] : '';
            school.onboardingFeePaid = true;
            await school.save();
            await recordTransaction({
                schoolId: school._id,
                type: 'onboarding',
                amount,
                currency,
                status: 'completed',
                paypalOrderId: orderId,
                paypalSaleId: captureId,
                planKey,
                description: couponMeta.couponCode
                    ? `Onboarding fee (coupon ${couponMeta.couponCode} -$${couponMeta.discountUsd.toFixed(2)})`
                    : 'Onboarding fee',
                rawEventType: 'capture_order',
            });
            if (couponMeta.couponCode && couponMeta.discountUsd > 0) {
                const def = getPlanDef(planKey);
                const originalAmount = def ? def.onboardingUsd : amount + couponMeta.discountUsd;
                await completeCouponRedemption({
                    schoolId: school._id,
                    couponCode: couponMeta.couponCode,
                    orderType: 'onboarding',
                    planKey,
                    paypalOrderId: orderId,
                    paypalCaptureId: captureId || '',
                    originalAmountUsd: originalAmount,
                    discountAmountUsd: couponMeta.discountUsd,
                    finalAmountUsd: amount,
                    meta: {},
                });
            }
            const refreshed = await School.findById(schoolId).lean();
            return res.json({
                ok: true,
                onboardingPaid: true,
                minuteBalance: refreshed?.minuteBalance ?? null,
            });
        }

        if (customId.includes('type:subscription_first')) {
            const planMatch = customId.match(/plan:([^;]+)/);
            const planKey = planMatch ? planMatch[1] : '';
            const def = getPlanDef(planKey);
            if (!def) {
                return res.status(400).json({ error: 'Invalid plan for subscription first payment.' });
            }

            const expectedUsd = round2(def.monthlyUsd - couponMeta.discountUsd);
            if (Math.abs(amount - expectedUsd) > 0.03) {
                console.warn('[billing/capture-order] subscription first payment mismatch', { expectedUsd, amount, planKey });
                AlertService.create({
                    type: 'PAYMENT_ERROR',
                    severity: 'CRITICAL',
                    schoolId: school._id,
                    schoolName: school.name,
                    title: 'PayPal subscription payment mismatch',
                    message: `Expected $${expectedUsd}, captured $${amount}`,
                    source: 'billing.capture-order',
                    metadata: { expectedUsd, amount, planKey, orderId },
                });
                return res.status(400).json({ error: 'Captured amount does not match this discounted first payment.' });
            }

            await recordTransaction({
                schoolId: school._id,
                type: 'subscription_payment',
                amount,
                currency,
                status: 'completed',
                paypalOrderId: orderId,
                paypalSaleId: captureId,
                planKey,
                description: couponMeta.couponCode
                    ? `First subscription payment (${planKey}) with coupon ${couponMeta.couponCode} -$${couponMeta.discountUsd.toFixed(2)}`
                    : `First subscription payment (${planKey})`,
                rawEventType: 'capture_order',
            });

            if (couponMeta.couponCode && couponMeta.discountUsd > 0) {
                await completeCouponRedemption({
                    schoolId: school._id,
                    couponCode: couponMeta.couponCode,
                    orderType: 'subscription',
                    planKey,
                    paypalOrderId: orderId,
                    paypalCaptureId: captureId || '',
                    originalAmountUsd: def.monthlyUsd,
                    discountAmountUsd: couponMeta.discountUsd,
                    finalAmountUsd: amount,
                    meta: {},
                });
            }

            const planId = resolvePaypalPlanId(planKey, { foundingPartner: school.foundingPartner });
            if (!planId) {
                return res.status(503).json({
                    error: 'PayPal plan is not configured for this tier.',
                });
            }

            const customSubId = `school:${school._id.toString()};plan:${planKey}`;
            const sub = await createSubscription({
                planId,
                customId: customSubId,
                returnUrl: `${resolveFrontendBaseUrl(req)}/school/billing?sub=return`,
                cancelUrl: `${resolveFrontendBaseUrl(req)}/school/billing?sub=cancel`,
                brandName: process.env.PAYPAL_BRAND_NAME || 'Nora',
            });
            school.subscriptionPlanKey = planKey;
            school.subscriptionStatus = 'approval_pending';
            school.paypalSubscriptionId = sub.id || '';
            await school.save();

            const approve = Array.isArray(sub.links)
                ? sub.links.find((l) => l.rel === 'approve' && l.href)
                : null;

            return res.json({
                ok: true,
                firstPaymentCaptured: true,
                requiresSubscriptionApproval: true,
                subscriptionId: sub.id || '',
                subscriptionApprovalUrl: approve?.href || null,
            });
        }

        return res.status(400).json({ error: 'Unsupported order for capture.' });
    } catch (err) {
        console.error('[billing/capture-order]', err.response?.data || err.message);
        res.status(500).json({
            error: err.response?.data?.message || err.message || 'Capture failed',
        });
    }
});

module.exports = router;
