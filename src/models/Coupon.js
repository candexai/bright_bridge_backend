const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, unique: true, index: true },
        name: { type: String, default: '' },
        description: { type: String, default: '' },
        discountType: { type: String, enum: ['percent', 'fixed'], required: true },
        discountValue: { type: Number, required: true },
        appliesTo: {
            type: [String],
            enum: ['onboarding', 'topup', 'subscription'],
            default: ['onboarding', 'topup'],
        },
        planKeys: {
            type: [String],
            enum: ['starter', 'growth', 'full_enrollment', 'demo'],
            default: [],
        },
        minAmountUsd: { type: Number, default: 0 },
        maxTotalUses: { type: Number, default: null },
        maxUsesPerSchool: { type: Number, default: 1 },
        validFrom: { type: Date, default: null },
        validUntil: { type: Date, default: null },
        active: { type: Boolean, default: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { timestamps: true }
);

couponSchema.pre('save', function normalizeCode(next) {
    if (this.code) {
        this.code = String(this.code).trim().toUpperCase();
    }
    next();
});

module.exports = mongoose.model('Coupon', couponSchema);
