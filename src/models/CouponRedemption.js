const mongoose = require('mongoose');

const couponRedemptionSchema = new mongoose.Schema(
    {
        couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
        couponCode: { type: String, required: true, index: true },
        schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, index: true },
        orderType: { type: String, enum: ['onboarding', 'topup', 'subscription'], required: true },
        planKey: { type: String, default: '' },
        paypalOrderId: { type: String, default: '' },
        paypalCaptureId: { type: String, default: '' },
        paypalSubscriptionId: { type: String, default: '' },
        originalAmountUsd: { type: Number, required: true },
        discountAmountUsd: { type: Number, required: true },
        finalAmountUsd: { type: Number, required: true },
        status: { type: String, enum: ['completed', 'voided'], default: 'completed' },
        meta: { type: Object, default: {} },
    },
    { timestamps: true }
);

couponRedemptionSchema.index({ couponId: 1, schoolId: 1, createdAt: -1 });
couponRedemptionSchema.index({ paypalOrderId: 1 }, { unique: true, sparse: true });
couponRedemptionSchema.index({ paypalCaptureId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
