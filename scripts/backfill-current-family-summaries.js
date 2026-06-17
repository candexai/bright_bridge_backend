#!/usr/bin/env node
/**
 * Fix summaries wrongly marked "No meaningful interaction" for current-family transfer calls.
 * Usage: node scripts/backfill-current-family-summaries.js [--schoolId=<id>] [--dry-run]
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ElevenLabsWebhook = require('../src/models/ElevenLabsWebhook');
const {
    isCurrentFamilyCall,
    buildCurrentFamilyTransferResult,
    isNoMeaningfulInteractionSummary,
    resolveWebhookSummary,
} = require('../src/utils/currentFamilyTransfer');
const { mapComprehensiveResult, upsertLeadInsight } = require('../src/services/leadInsightService');

async function backfillCurrentFamilySummaries() {
    const dryRun = process.argv.includes('--dry-run');
    const schoolIdArg = process.argv.find((arg) => arg.startsWith('--schoolId='));
    const schoolIdFilter = schoolIdArg ? schoolIdArg.split('=')[1] : null;

    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`Connected to MongoDB${dryRun ? ' (dry run)' : ''}`);

    const query = {
        type: 'post_call_transcription',
        ...(schoolIdFilter ? { schoolId: new mongoose.Types.ObjectId(schoolIdFilter) } : {}),
    };

    const webhooks = await ElevenLabsWebhook.find(query)
        .select('_id schoolId conversation_id summary comprehensive_result transcript ai_processed')
        .lean();

    let updated = 0;
    let scanned = 0;

    for (const webhook of webhooks) {
        scanned += 1;
        const transcript = Array.isArray(webhook.transcript) ? webhook.transcript : [];
        if (transcript.length === 0) continue;

        const mislabeledCurrentFamily = /the caller identified as a current enrolled family/i.test(webhook.summary || '')
            && !isCurrentFamilyCall(transcript);
        if (mislabeledCurrentFamily) {
            const fallback = String(webhook.comprehensive_result?.summary || '').trim();
            const nextSummary = fallback && !isNoMeaningfulInteractionSummary(fallback)
                ? fallback
                : 'No meaningful interaction. The call was interrupted or the caller did not engage.';
            console.log(`[revert] ${webhook.conversation_id || webhook._id}: mislabeled current-family summary`);
            if (!dryRun) {
                await ElevenLabsWebhook.findByIdAndUpdate(webhook._id, { summary: nextSummary });
            }
            updated += 1;
            continue;
        }

        const badSummary = !webhook.summary?.trim()
            || isNoMeaningfulInteractionSummary(webhook.summary)
            || webhook.comprehensive_result?.call_state === 'no_interaction'
            || /you are nora|virtual scheduling assistant|knowledge base/i.test(webhook.summary || '');
        const isCurrentFamily = isCurrentFamilyCall(transcript);
        const resolved = resolveWebhookSummary(webhook);

        if (!isCurrentFamily && !badSummary) continue;
        if (!isCurrentFamily) continue;
        if (resolved === webhook.summary) continue;

        const comprehensiveResult = buildCurrentFamilyTransferResult(transcript);
        const summary = comprehensiveResult.summary;

        console.log(`[fix] ${webhook.conversation_id || webhook._id}: ${summary}`);

        if (!dryRun) {
            const updatedWebhook = await ElevenLabsWebhook.findByIdAndUpdate(
                webhook._id,
                {
                    summary,
                    comprehensive_result: comprehensiveResult,
                    ai_processed: true,
                },
                { new: true }
            ).lean();

            if (updatedWebhook?.schoolId) {
                const insightData = mapComprehensiveResult(comprehensiveResult, updatedWebhook);
                await upsertLeadInsight({
                    schoolId: updatedWebhook.schoolId,
                    webhook: updatedWebhook,
                    insightData,
                });
            }
        }

        updated += 1;
    }

    console.log(`Scanned ${scanned} webhooks. ${dryRun ? 'Would update' : 'Updated'}: ${updated}.`);
    await mongoose.disconnect();
}

backfillCurrentFamilySummaries().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
