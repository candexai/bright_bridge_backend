const express = require('express');
const mongoose = require('mongoose');
const School = require('../models/School');
const BillingTransaction = require('../models/BillingTransaction');
const { verifyWebhookSignature, getSubscription } = require('../services/paypalService');
const {
    grantMinutes,
    applyMonthlyPlanAllocation,
    recordTransaction,
} = require('../services/billingService');
const { getPlanDef } = require('../config/billingPlans');
const {
    completeCouponRedemption,
    parseCouponMetaFromCustomId,
} = require('../services/couponService');
const AlertService = require('../services/alertService');

const router = express.Router();

function parseSchoolIdFromCustom(customId) {
    if (!customId || typeof customId !== 'string') return null;
    const m = customId.match(/school:([^;]+)/);
    if (!m) return null;
    const id = m[1].trim();
    return mongoose.Types.ObjectId.isValid(id) ? id : null;
}

function parsePlanKeyFromCustom(customId) {
    if (!customId || typeof customId !== 'string') return null;
    const m = customId.match(/plan:([^;]+)/);
    return m ? m[1].trim() : null;
}

router.post('/', async (req, res) => {
    try {
        const rawBody = req.body;
        const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(JSON.stringify(rawBody));

        const ok = await verifyWebhookSignature(buf, req.headers);
        if (!ok) {
            console.warn('[PayPal Webhook] Signature verification failed');
            AlertService.create({
                type: 'WEBHOOK_ERROR',
                severity: 'CRITICAL',
                title: 'PayPal webhook signature verification failed',
                message: 'Invalid webhook signature',
                source: 'paypalWebhook.verify',
            });
            return res.status(401).send('Invalid signature');
        }

        const event = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString('utf8')) : rawBody;
        const eventType = event.event_type;
        const eventId = event.id || '';

        if (eventId) {
            const dup = await BillingTransaction.findOne({ paypalEventId: eventId }).lean();
            if (dup) {
                return res.status(200).json({ received: true, duplicate: true });
            }
        }

        const resource = event.resource || {};

        if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
            const subId = resource.id;
            const customId = resource.custom_id || '';
            const schoolId = parseSchoolIdFromCustom(customId);
            const planKey = parsePlanKeyFromCustom(customId);

            if (schoolId) {
                const school = await School.findById(schoolId);
                if (school) {
                    school.paypalSubscriptionId = subId;
                    school.subscriptionStatus = 'active';
                    school.billingMode = 'metered';
                    if (planKey && getPlanDef(planKey)) {
                        school.subscriptionPlanKey = planKey;
                    }
                    if (typeof school.minuteBalance !== 'number') {
                        school.minuteBalance = 0;
                    }
                    await school.save();
                }
            }

            await recordTransaction({
                schoolId: schoolId ? new mongoose.Types.ObjectId(schoolId) : null,
                type: 'subscription_activated',
                amount: 0,
                status: 'completed',
                paypalEventId: eventId,
                paypalSubscriptionId: subId,
                planKey: planKey || '',
                description: 'Subscription activated',
                rawEventType: eventType,
            });

            return res.status(200).json({ received: true });
        }

        if (eventType === 'PAYMENT.SALE.COMPLETED') {
            const billingAgreementId =
                resource.billing_agreement_id || resource.billing_agreement_ids?.[0];
            const saleId = resource.id;
            const amount = parseFloat(resource.amount?.total || resource.amount?.value || '0', 10);
            const currency = resource.amount?.currency || 'USD';

            if (!billingAgreementId) {
                await recordTransaction({
                    schoolId: null,
                    type: 'other',
                    amount,
                    currency,
                    status: 'completed',
                    paypalEventId: eventId,
                    paypalSaleId: saleId,
                    description: 'Sale without subscription id',
                    rawEventType: eventType,
                });
                return res.status(200).json({ received: true });
            }

            let school = await School.findOne({ paypalSubscriptionId: billingAgreementId });
            if (!school) {
                console.warn('[PayPal Webhook] No school for subscription', billingAgreementId);
                await recordTransaction({
                    schoolId: null,
                    type: 'subscription_payment',
                    amount,
                    currency,
                    status: 'completed',
                    paypalEventId: eventId,
                    paypalSubscriptionId: billingAgreementId,
                    paypalSaleId: saleId,
                    description: 'Subscription payment — school not linked',
                    rawEventType: eventType,
                });
                return res.status(200).json({ received: true });
            }

            if (!school.subscriptionPlanKey) {
                try {
                    const sub = await getSubscription(billingAgreementId);
                    const pk = parsePlanKeyFromCustom(sub.custom_id || '');
                    if (pk && getPlanDef(pk)) {
                        school.subscriptionPlanKey = pk;
                        await school.save();
                    }
                } catch (e) {
                    console.warn('[PayPal Webhook] Could not sync plan from PayPal:', e.message);
                }
            }

            if (saleId) {
                const dupSale = await BillingTransaction.findOne({
                    paypalSaleId: saleId,
                    type: 'subscription_payment',
                }).lean();
                if (dupSale) {
                    return res.status(200).json({ received: true, duplicate: true });
                }
            }

            await applyMonthlyPlanAllocation(school._id);
            school.lastBillingCyclePaymentAt = new Date();
            school.paypalLastPaymentId = saleId || '';
            await school.save();

            await recordTransaction({
                schoolId: school._id,
                type: 'subscription_payment',
                amount,
                currency,
                status: 'completed',
                paypalEventId: eventId,
                paypalSubscriptionId: billingAgreementId,
                paypalSaleId: saleId || '',
                planKey: school.subscriptionPlanKey || '',
                description: 'Monthly subscription payment (minutes added with rollover)',
                rawEventType: eventType,
            });

            return res.status(200).json({ received: true });
        }

        if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
            const customId =
                resource.custom_id ||
                resource.supplementary_data?.related_ids?.order_id ||
                '';
            const schoolId = parseSchoolIdFromCustom(customId);
            const captureId = resource.id;
            const amount = parseFloat(resource.amount?.value || '0', 10);
            const currency = resource.amount?.currency_code || 'USD';
            const couponMeta = parseCouponMetaFromCustomId(customId);

            if (!schoolId) {
                await recordTransaction({
                    schoolId: null,
                    type: 'other',
                    amount,
                    currency,
                    status: 'completed',
                    paypalEventId: eventId,
                    paypalSaleId: captureId,
                    description: 'Capture — no school in custom_id',
                    rawEventType: eventType,
                });
                return res.status(200).json({ received: true });
            }

            if (captureId) {
                const dupCap = await BillingTransaction.findOne({ paypalSaleId: captureId }).lean();
                if (dupCap) {
                    return res.status(200).json({ received: true, duplicate: true });
                }
            }

            const school = await School.findById(schoolId);
            if (!school) {
                return res.status(200).json({ received: true });
            }

            if (customId.includes('type:topup')) {
                const m = customId.match(/minutes:(\d+)/);
                const minutes = m ? parseInt(m[1], 10) : 0;
                if (!minutes) {
                    await recordTransaction({
                        schoolId: school._id,
                        type: 'other',
                        amount,
                        currency,
                        status: 'completed',
                        paypalEventId: eventId,
                        paypalSaleId: captureId,
                        description: 'Top-up capture missing minutes in custom_id',
                        rawEventType: eventType,
                    });
                    return res.status(200).json({ received: true });
                }
                await grantMinutes(school._id, minutes, 'topup', { captureId });
                await recordTransaction({
                    schoolId: school._id,
                    type: 'topup',
                    amount,
                    currency,
                    status: 'completed',
                    paypalEventId: eventId,
                    paypalSaleId: captureId,
                    description: couponMeta.couponCode
                        ? `Top-up ${minutes} minutes (coupon ${couponMeta.couponCode} -$${couponMeta.discountUsd.toFixed(2)})`
                        : `Top-up ${minutes} minutes`,
                    rawEventType: eventType,
                });
                if (couponMeta.couponCode && couponMeta.discountUsd > 0) {
                    await completeCouponRedemption({
                        schoolId: school._id,
                        couponCode: couponMeta.couponCode,
                        orderType: 'topup',
                        planKey: school.subscriptionPlanKey || '',
                        paypalCaptureId: captureId,
                        originalAmountUsd: amount + couponMeta.discountUsd,
                        discountAmountUsd: couponMeta.discountUsd,
                        finalAmountUsd: amount,
                        meta: { eventId },
                    });
                }
            } else if (customId.includes('type:onboarding')) {
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
                    paypalEventId: eventId,
                    paypalSaleId: captureId,
                    description: couponMeta.couponCode
                        ? `Onboarding fee (coupon ${couponMeta.couponCode} -$${couponMeta.discountUsd.toFixed(2)})`
                        : 'Onboarding fee',
                    rawEventType: eventType,
                });
                if (couponMeta.couponCode && couponMeta.discountUsd > 0) {
                    await completeCouponRedemption({
                        schoolId: school._id,
                        couponCode: couponMeta.couponCode,
                        orderType: 'onboarding',
                        planKey,
                        paypalCaptureId: captureId,
                        originalAmountUsd: amount + couponMeta.discountUsd,
                        discountAmountUsd: couponMeta.discountUsd,
                        finalAmountUsd: amount,
                        meta: { eventId },
                    });
                }
            } else {
                await recordTransaction({
                    schoolId: school._id,
                    type: 'other',
                    amount,
                    currency,
                    status: 'completed',
                    paypalEventId: eventId,
                    paypalSaleId: captureId,
                    description: 'PayPal capture',
                    rawEventType: eventType,
                });
            }

            return res.status(200).json({ received: true });
        }

        if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') {
            const subId = resource.id;
            await School.updateMany(
                { paypalSubscriptionId: subId },
                { $set: { subscriptionStatus: 'cancelled' } }
            );
            await recordTransaction({
                schoolId: null,
                type: 'other',
                amount: 0,
                status: 'completed',
                paypalEventId: eventId,
                paypalSubscriptionId: subId,
                description: 'Subscription cancelled',
                rawEventType: eventType,
            });
            return res.status(200).json({ received: true });
        }

        await recordTransaction({
            schoolId: null,
            type: 'other',
            amount: 0,
            status: 'completed',
            paypalEventId: eventId,
            description: `Unhandled: ${eventType}`,
            rawEventType: eventType,
        });
        return res.status(200).json({ received: true });
    } catch (err) {
        console.error('[PayPal Webhook]', err);
        return res.status(500).json({ error: 'Webhook handler error' });
    }
});

module.exports = router;
