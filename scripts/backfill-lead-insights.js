#!/usr/bin/env node
/**
 * Backfill LeadInsight cache from existing ElevenLabs webhooks.
 * Usage: node scripts/backfill-lead-insights.js [--schoolId=<id>]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ElevenLabsWebhook = require('../src/models/ElevenLabsWebhook');
const {
    mapComprehensiveResult,
    mapWebhookExtractedFields,
    mapSummaryFallback,
    upsertLeadInsight,
    hashTranscript,
    getTranscriptText,
} = require('../src/services/leadInsightService');

async function backfillLeadInsights() {
    const schoolIdArg = process.argv.find((arg) => arg.startsWith('--schoolId='));
    const schoolIdFilter = schoolIdArg ? schoolIdArg.split('=')[1] : null;

    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const query = {
        type: 'post_call_transcription',
        ...(schoolIdFilter ? { schoolId: new mongoose.Types.ObjectId(schoolIdFilter) } : {}),
    };

    const webhooks = await ElevenLabsWebhook.find(query)
        .select('_id conversation_id schoolId received_at metadata summary comprehensive_result extractedTags extractedChildName extractedChildAge extractedLanguage extractedMissingDetails tour_booking_extracted ai_processed tour_booking_detected actionTaken actionTakenFeedback actionTakenAt user_id transcript')
        .lean();

    console.log(`Found ${webhooks.length} webhooks to backfill`);

    let created = 0;
    let skipped = 0;

    for (const webhook of webhooks) {
        if (!webhook.schoolId) {
            skipped += 1;
            continue;
        }

        let insightData;
        if (webhook.comprehensive_result) {
            insightData = mapComprehensiveResult(webhook.comprehensive_result, webhook);
        } else if (webhook.ai_processed && Array.isArray(webhook.extractedTags)) {
            insightData = mapWebhookExtractedFields(webhook);
        } else {
            insightData = mapSummaryFallback(webhook);
        }

        await upsertLeadInsight({
            schoolId: webhook.schoolId,
            webhook,
            insightData,
            transcriptHash: hashTranscript(getTranscriptText(webhook)),
        });
        created += 1;

        if (created % 50 === 0) {
            console.log(`Processed ${created}/${webhooks.length}...`);
        }
    }

    console.log(`Backfill complete. Upserted: ${created}, skipped: ${skipped}`);
    await mongoose.disconnect();
}

backfillLeadInsights().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
