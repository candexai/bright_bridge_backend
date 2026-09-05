#!/usr/bin/env node
/**
 * Clear stale/custom humanTransferCondition values on all schools so they fall back
 * to the current HUMAN_TRANSFER_TOOL_CONDITION default in src/utils/elevenlabs.js.
 * Usage:
 *   node scripts/clear-custom-human-transfer-conditions.js [--dry-run]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const School = require('../src/models/School');

async function clearCustomHumanTransferConditions() {
    const dryRun = process.argv.includes('--dry-run');

    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not set');
    }

    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Connected to MongoDB${dryRun ? ' (dry run)' : ''}`);

    const schools = await School.find({})
        .select('name humanTransferCondition')
        .sort({ name: 1 })
        .lean();

    let cleared = 0;
    let alreadyDefault = 0;

    for (const school of schools) {
        const current = String(school.humanTransferCondition || '').trim();
        if (!current) {
            alreadyDefault += 1;
            console.log(`[skip] ${school.name}: already default`);
            continue;
        }

        console.log(`[${dryRun ? 'would clear' : 'clear'}] ${school.name}: had ${current.length} chars`);
        if (!dryRun) {
            await School.updateOne({ _id: school._id }, { $set: { humanTransferCondition: '' } });
        }
        cleared += 1;
    }

    console.log(`Done. Cleared: ${cleared}, already default: ${alreadyDefault}.`);
    await mongoose.disconnect();
}

clearCustomHumanTransferConditions().catch((err) => {
    console.error('Clear failed:', err);
    process.exit(1);
});
