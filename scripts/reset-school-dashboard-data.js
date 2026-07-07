#!/usr/bin/env node
/**
 * Reset dashboard/operational data for a school while preserving settings (AI number, integrations, users, etc.).
 *
 * Usage:
 *   node scripts/reset-school-dashboard-data.js --schoolId=<id> [--dry-run]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const School = require('../src/models/School');
const ElevenLabsWebhook = require('../src/models/ElevenLabsWebhook');
const LeadInsight = require('../src/models/LeadInsight');
const TourBooking = require('../src/models/TourBooking');
const Followup = require('../src/models/Followup');
const CallLog = require('../src/models/CallLog');
const MinuteLedger = require('../src/models/MinuteLedger');
const Alert = require('../src/models/Alert');
const InquirySubmission = require('../src/models/InquirySubmission');
const { getPlanDef } = require('../src/config/billingPlans');

function normalizePhone(p) {
    return String(p || '').replace(/\D/g, '');
}

async function resetSchoolDashboardData(schoolId, { dryRun = false } = {}) {
    if (!mongoose.Types.ObjectId.isValid(schoolId)) {
        throw new Error(`Invalid schoolId: ${schoolId}`);
    }

    const objectId = new mongoose.Types.ObjectId(schoolId);
    const school = await School.findById(objectId);
    if (!school) {
        throw new Error(`School not found: ${schoolId}`);
    }

    const planDef = getPlanDef(school.subscriptionPlanKey);
    const includedMinutes = planDef?.includedMinutesPerMonth ?? 0;

    const collections = [
        ['ElevenLabsWebhook', ElevenLabsWebhook],
        ['LeadInsight', LeadInsight],
        ['TourBooking', TourBooking],
        ['Followup', Followup],
        ['CallLog', CallLog],
        ['MinuteLedger', MinuteLedger],
        ['Alert', Alert],
        ['InquirySubmission', InquirySubmission],
    ];

    const counts = {};
    for (const [name, Model] of collections) {
        counts[name] = await Model.countDocuments({ schoolId: objectId });
    }

    const aiDigits = normalizePhone(school.aiNumber);
    const voiceAiParticipantId = aiDigits ? `sip_+${aiDigits}` : null;
    let voiceAiCount = 0;
    if (voiceAiParticipantId) {
        try {
            const bennyDb = mongoose.connection.useDb('benny');
            voiceAiCount = await bennyDb.collection('voiceAI').countDocuments({ participant_id: voiceAiParticipantId });
        } catch (err) {
            console.warn('[reset] VoiceAI count warning:', err.message);
        }
    }

    console.log(`\nSchool: ${school.name} (${school._id})`);
    console.log(`AI number (preserved): ${school.aiNumber || '(none)'}`);
    console.log(`Plan: ${school.subscriptionPlanKey || 'none'} → reset minutes to ${includedMinutes}`);
    console.log(`Current minuteBalance: ${school.minuteBalance}`);
    console.log('\nRecords to delete:');
    for (const [name, count] of Object.entries(counts)) {
        console.log(`  ${name}: ${count}`);
    }
    if (voiceAiCount > 0) {
        console.log(`  VoiceAI (benny): ${voiceAiCount}`);
    }

    if (dryRun) {
        console.log('\n[DRY RUN] No changes made.');
        return { dryRun: true, school: school.name, counts, includedMinutes };
    }

    for (const [name, Model] of collections) {
        const result = await Model.deleteMany({ schoolId: objectId });
        console.log(`Deleted ${name}: ${result.deletedCount}`);
    }

    if (voiceAiParticipantId && voiceAiCount > 0) {
        try {
            const bennyDb = mongoose.connection.useDb('benny');
            const voiceResult = await bennyDb.collection('voiceAI').deleteMany({ participant_id: voiceAiParticipantId });
            console.log(`Deleted VoiceAI (benny): ${voiceResult.deletedCount}`);
        } catch (err) {
            console.warn('[reset] VoiceAI purge warning:', err.message);
        }
    }

    school.wordCloud = [];
    school.minuteBalance = includedMinutes;
    school.aiNumberAssignedAt = new Date();
    await school.save();

    if (includedMinutes > 0) {
        await MinuteLedger.create({
            schoolId: objectId,
            deltaMinutes: includedMinutes,
            balanceAfter: includedMinutes,
            reason: 'admin_adjustment',
            meta: { note: 'Fresh start reset — dashboard data cleared' },
        });
    }

    console.log(`\nReset complete. minuteBalance set to ${includedMinutes}, aiNumberAssignedAt updated.`);
    return { school: school.name, counts, includedMinutes };
}

async function main() {
    const schoolIdArg = process.argv.find((arg) => arg.startsWith('--schoolId='));
    const dryRun = process.argv.includes('--dry-run');
    const schoolId = schoolIdArg ? schoolIdArg.split('=')[1] : null;

    if (!schoolId) {
        console.error('Usage: node scripts/reset-school-dashboard-data.js --schoolId=<id> [--dry-run]');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    try {
        await resetSchoolDashboardData(schoolId, { dryRun });
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { resetSchoolDashboardData };
