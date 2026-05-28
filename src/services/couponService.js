const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normalizeCouponCode(code) {
    return String(code || '').trim().toUpperCase();
}

function parseCouponMetaFromCustomId(customId) {
    const text = String(customId || '');
    const couponMatch = text.match(/coupon:([^;]+)/);
    const discountMatch = text.match(/disc:([0-9]+(?:\.[0-9]{1,2})?)/);
    return {
        couponCode: couponMatch ? couponMatch[1].trim().toUpperCase() : '',
        discountUsd: discountMatch ? round2(parseFloat(discountMatch[1])) : 0,
    };
}

function appendCouponMeta(customId, couponCode, discountUsd) {
    if (!couponCode || discountUsd <= 0) return customId;
    return `${customId};coupon:${normalizeCouponCode(couponCode)};disc:${round2(discountUsd).toFixed(2)}`;
}

async function computeCouponDiscount({
    schoolId,
    couponCode,
    orderType,
    amountUsd,
    planKey = '',
}) {
    const normalizedCode = normalizeCouponCode(couponCode);
    if (!normalizedCode) {
        return {
            ok: true,
            applied: false,
            couponCode: '',
            originalAmountUsd: round2(amountUsd),
            discountAmountUsd: 0,
            finalAmountUsd: round2(amountUsd),
            reason: '',
        };
    }

    const coupon = await Coupon.findOne({ code: normalizedCode }).lean();
    if (!coupon) return { ok: false, error: 'Coupon not found.' };
    if (!coupon.active) return { ok: false, error: 'Coupon is inactive.' };

    const now = new Date();
    if (coupon.validFrom && now < new Date(coupon.validFrom)) {
        return { ok: false, error: 'Coupon is not active yet.' };
    }
    if (coupon.validUntil && now > new Date(coupon.validUntil)) {
        return { ok: false, error: 'Coupon has expired.' };
    }
    if (Array.isArray(coupon.appliesTo) && !coupon.appliesTo.includes(orderType)) {
        return { ok: false, error: `Coupon does not apply to ${orderType} payments.` };
    }
    if (Array.isArray(coupon.planKeys) && coupon.planKeys.length && planKey && !coupon.planKeys.includes(planKey)) {
        return { ok: false, error: 'Coupon does not apply to this plan.' };
    }
    if (Number(coupon.minAmountUsd || 0) > Number(amountUsd || 0)) {
        return {
            ok: false,
            error: `Coupon requires minimum payment of $${round2(coupon.minAmountUsd).toFixed(2)}.`,
        };
    }

    const [totalUses, schoolUses] = await Promise.all([
        CouponRedemption.countDocuments({
            couponId: coupon._id,
            status: 'completed',
        }),
        CouponRedemption.countDocuments({
            couponId: coupon._id,
            schoolId,
            status: 'completed',
        }),
    ]);

    if (coupon.maxTotalUses != null && totalUses >= coupon.maxTotalUses) {
        return { ok: false, error: 'Coupon usage limit reached.' };
    }
    if (coupon.maxUsesPerSchool != null && schoolUses >= coupon.maxUsesPerSchool) {
        return { ok: false, error: 'Coupon already used for this school.' };
    }

    const base = round2(amountUsd);
    let discount = 0;
    if (coupon.discountType === 'percent') {
        discount = round2((base * Number(coupon.discountValue || 0)) / 100);
    } else {
        discount = round2(Number(coupon.discountValue || 0));
    }

    discount = Math.max(0, Math.min(discount, round2(base - 0.01)));
    const finalAmount = round2(base - discount);
    if (finalAmount < 0.01) {
        return { ok: false, error: 'Final amount is too small after coupon.' };
    }

    return {
        ok: true,
        applied: discount > 0,
        couponId: coupon._id,
        couponCode: coupon.code,
        couponName: coupon.name || coupon.code,
        originalAmountUsd: base,
        discountAmountUsd: discount,
        finalAmountUsd: finalAmount,
    };
}

async function completeCouponRedemption({
    schoolId,
    couponCode,
    orderType,
    planKey = '',
    paypalOrderId = '',
    paypalCaptureId = '',
    paypalSubscriptionId = '',
    originalAmountUsd,
    discountAmountUsd,
    finalAmountUsd,
    meta = {},
}) {
    const code = normalizeCouponCode(couponCode);
    if (!code || !discountAmountUsd || discountAmountUsd <= 0) return null;
    const coupon = await Coupon.findOne({ code }).lean();
    if (!coupon) return null;

    const query = paypalOrderId
        ? { paypalOrderId }
        : paypalCaptureId
            ? { paypalCaptureId }
            : null;
    if (query) {
        const existing = await CouponRedemption.findOne(query).lean();
        if (existing) return existing;
    }

    return CouponRedemption.create({
        couponId: coupon._id,
        couponCode: coupon.code,
        schoolId,
        orderType,
        planKey,
        paypalOrderId: paypalOrderId || '',
        paypalCaptureId: paypalCaptureId || '',
        paypalSubscriptionId: paypalSubscriptionId || '',
        originalAmountUsd: round2(originalAmountUsd),
        discountAmountUsd: round2(discountAmountUsd),
        finalAmountUsd: round2(finalAmountUsd),
        status: 'completed',
        meta,
    });
}

module.exports = {
    normalizeCouponCode,
    parseCouponMetaFromCustomId,
    appendCouponMeta,
    computeCouponDiscount,
    completeCouponRedemption,
    round2,
};
