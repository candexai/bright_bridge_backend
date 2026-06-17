const crypto = require('crypto');
const LeadInsight = require('../models/LeadInsight');
const { extractTourDetails, mergeParentQuestionsFromExtraction } = require('../utils/openai');
const { getCallerPhoneFromWebhook, getCallDurationSeconds, getCallerNameFromWebhook } = require('../utils/webhookHelpers');
const { resolveWebhookSummary, resolveCachedSummary } = require('../utils/currentFamilyTransfer');

const HOT_LEAD_AI_TAG_PATTERNS = [
    /hot lead/i,
    /parent requested callback/i,
    /callback requested/i,
    /enrollment inquiry/i,
    /admission/i,
    /urgent follow[- ]?up/i,
    /follow[- ]?up needed/i,
    /urgency:\s*immediate/i,
    /urgency:\s*high/i,
    /tour requested/i,
    /price (concern|sensitive)/i,
    /price inquiry/i,
];

/** New-parent enrollment / tour intent — word boundaries so "enrolled" does not match. */
const NEW_PARENT_INTENT_PATTERNS = [
    /\benroll(?:ment|ing)?\b/i,
    /\badmission\b/i,
    /\btour\b/i,
    /\bvisit(?:ing)?\b|\bschedule\b|\bbook(?:ing)?\b/i,
    /tuition|price|cost|fee|afford|financial aid/i,
    /callback|call (?:me )?back|speak (?:to|with) (?:someone|staff|a person)/i,
    /urgent|as soon as possible|starting (?:next week|soon)/i,
    /program|curriculum|classroom|hours|pickup|drop.?off|meal|food|ratio|teacher|camera|security|summer camp|after.?school/i,
];

/** Current-family calls only count as hot when they ask about something substantive. */
const CURRENT_FAMILY_INQUIRY_PATTERNS = [
    /tuition|price|cost|fee|billing|payment|invoice/i,
    /hours|schedule|pickup|drop.?off|holiday|closure|\bopen\b|\bclose\b/i,
    /meal|food|allerg|lunch|snack/i,
    /teacher|ratio|classroom|director|staff/i,
    /camera|security|safety|incident/i,
    /bus|transportation|field trip/i,
    /summer camp|after.?school|extended care/i,
    /sick|absence|attendance/i,
];

function hashTranscript(transcriptText) {
    return crypto.createHash('sha256').update(String(transcriptText || '')).digest('hex');
}

function getTranscriptText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript.map(t => `${t.role}: ${t.message || t.text}`).join('\n');
}

function getCallerText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript
        .filter((entry) => {
            const role = String(entry.role || '').toLowerCase();
            return role === 'user' || role === 'parent' || role === 'caller' || role === 'customer' || role === 'human';
        })
        .map((entry) => entry.message || entry.text || '')
        .join(' ');
}

function getAgentText(webhook) {
    if (!Array.isArray(webhook?.transcript)) return '';
    return webhook.transcript
        .filter((entry) => {
            const role = String(entry.role || '').toLowerCase();
            return role === 'agent' || role === 'assistant' || role === 'mia' || role === 'nora';
        })
        .map((entry) => entry.message || entry.text || '')
        .join(' ');
}

/** Nora only offers front-desk transfer after the caller identifies as a current family. */
const AGENT_CURRENT_FAMILY_TRANSFER_PATTERNS = [
    /connect you to the front desk/i,
    /connect you to (?:the )?team/i,
    /connect you (?:right )?now/i,
    /i will connect you/i,
    /transfer you to/i,
    /transfer you (?:to|now)/i,
    /front desk (?:line|lines) (?:is|are) (?:all )?busy/i,
    /not able to transfer you/i,
    /transfer did not go through/i,
    /unable to transfer/i,
];

function safeStr(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
}

function dedupeTags(tags) {
    const seen = new Set();
    const out = [];
    for (const tag of Array.isArray(tags) ? tags : []) {
        const label = String(tag || '').trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
    }
    return out;
}

function isTransferBoilerplateSummary(summary) {
    return /current enrolled family member|transferred to the front desk|familia actual/i.test(String(summary || ''));
}

function detectHotLead({
    tags = [],
    summary = '',
    callerText = '',
    parentSegment = 'new_parent',
    questionsAsked = [],
    missingDetails = [],
} = {}) {
    const tagHaystack = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();
    const summaryText = String(summary || '').toLowerCase();

    if (/no meaningful interaction|did not engage|call was interrupted|caller did not/i.test(summaryText)) {
        return false;
    }

    const questionsHaystack = (Array.isArray(questionsAsked) ? questionsAsked : []).join(' ').toLowerCase();
    const callerHaystack = String(callerText || '').toLowerCase();
    const inquiryHaystack = `${callerHaystack} ${questionsHaystack}`.trim();

    if (parentSegment === 'current_family') {
        if (!inquiryHaystack) return false;
        return CURRENT_FAMILY_INQUIRY_PATTERNS.some((pattern) => pattern.test(inquiryHaystack));
    }

    const hasNoChildInfo = tagHaystack.includes('no child info')
        || (Array.isArray(missingDetails) && missingDetails.some((m) => /child name|child age/i.test(String(m))));
    const isPartial = tagHaystack.includes('partial call');
    const hasIntent = NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(inquiryHaystack));
    const hasRealQuestions = questionsAsked.length > 0
        && inquiryHaystack.replace(/\b(current family|familia actual)\b/gi, '').trim().length > 15;

    if (isPartial && hasNoChildInfo && !hasIntent && !hasRealQuestions) {
        return false;
    }

    if (HOT_LEAD_AI_TAG_PATTERNS.some((pattern) => pattern.test(tagHaystack))) {
        return true;
    }

    if (!isTransferBoilerplateSummary(summaryText)
        && NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(summaryText))) {
        return true;
    }

    return hasIntent || hasRealQuestions;
}

function callerIdentifiedAsCurrentFamily(callerText) {
    const callerHaystack = String(callerText || '').toLowerCase().trim();
    if (!callerHaystack) return false;

    const callerLines = callerHaystack.split(/\s*\|\s*|\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of callerLines) {
        if (
            /^currents?\.?$/i.test(line)
            || /^current family\.?$/i.test(line)
            || /\b(i(?:'m| am)|we(?:'re| are))(?: a)? current family\b/i.test(line)
            || /\bcurrent family\b/i.test(line)
            || /\balready enrolled\b/i.test(line)
            || /\bexisting family\b/i.test(line)
            || /^front desk\??$/i.test(line)
        ) {
            return true;
        }
    }

    return (
        /\b(i(?:'m| am)|we(?:'re| are))(?: a)? current family\b/i.test(callerHaystack)
        || /\bcurrent family\b/i.test(callerHaystack)
        || /\balready enrolled\b/i.test(callerHaystack)
        || /\bexisting family\b/i.test(callerHaystack)
    );
}

function agentTriggeredCurrentFamilyTransfer(agentText) {
    const agentHaystack = String(agentText || '').toLowerCase();
    if (!agentHaystack) return false;
    return AGENT_CURRENT_FAMILY_TRANSFER_PATTERNS.some((pattern) => pattern.test(agentHaystack));
}

function detectParentSegment(tags, summary, webhookOrCallerText) {
    const webhook = typeof webhookOrCallerText === 'object' && webhookOrCallerText !== null
        ? webhookOrCallerText
        : null;
    const callerText = webhook ? getCallerText(webhook) : String(webhookOrCallerText || '');
    const agentText = webhook ? getAgentText(webhook) : '';

    const tagHaystack = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();
    if (/current family|existing family|already enrolled|current parent/i.test(tagHaystack)) {
        return 'current_family';
    }

    if (agentTriggeredCurrentFamilyTransfer(agentText)) {
        return 'current_family';
    }

    const summaryText = String(summary || '').toLowerCase();
    if (
        /identified (?:herself|himself|themselves)?(?: as)?(?: a)? current family/i.test(summaryText)
        || /\bas a current family\b/i.test(summaryText)
        || /\bexisting family\b/i.test(summaryText)
        || /\balready enrolled\b/i.test(summaryText)
        || /\bcurrent parent\b/i.test(summaryText)
        || /\bcurrent enrolled family\b/i.test(summaryText)
        || /\bcurrent family\b/i.test(summaryText)
        || /connect(?:ed)? (?:them |(?:the )?caller )?to the front desk/i.test(summaryText)
        || /requested (?:to speak with |)the front desk/i.test(summaryText)
    ) {
        return 'current_family';
    }

    if (callerIdentifiedAsCurrentFamily(callerText)) {
        return 'current_family';
    }

    return 'new_parent';
}

function enrichTags(tags, isHotLead, parentSegment) {
    let next = dedupeTags(Array.isArray(tags) ? tags : []);
    const hasTag = (label) => next.some((tag) => tag.toLowerCase() === label.toLowerCase());

    next = next.filter((tag) => tag.toLowerCase() !== 'hot lead');
    if (isHotLead && !hasTag('Hot Lead')) {
        next.unshift('Hot Lead');
    }

    if (parentSegment === 'current_family' && !hasTag('Current Family')) {
        next.push('Current Family');
    } else if (parentSegment === 'new_parent' && !hasTag('New Parent')) {
        next.push('New Parent');
    }

    return dedupeTags(next);
}

function applyTagPostProcessing(comprehensiveData) {
    const data = { ...comprehensiveData };
    data.tags = [...(data.tags || [])];

    if (data.childName && data.childAge) {
        data.tags = data.tags.filter((tag) => !tag.toLowerCase().includes('no child info'));
    }

    if ((!data.childName || !data.childAge) && Array.isArray(data.missingDetails)) {
        const missingChild = data.missingDetails.some((m) => {
            const lower = String(m).toLowerCase();
            return lower.includes('child name') || lower.includes('child age');
        });
        if (missingChild && !data.tags.some((tag) => tag.toLowerCase().includes('no child info'))) {
            data.tags.push('No child info captured');
        }
    }

    if (Array.isArray(data.missingDetails) && data.missingDetails.length > 0) {
        if (!data.tags.some((tag) => tag.toLowerCase().includes('partial call'))) {
            data.tags.push('Partial call');
        }
    }

    data.tags = dedupeTags(data.tags);
    if (!data.isHotLead) {
        data.tags = data.tags.filter((tag) => tag.toLowerCase() !== 'hot lead');
    }

    return data;
}

function mapInsightFields(webhook, { tags = [], comprehensiveResult = null, summaryText = '' } = {}) {
    const callerText = getCallerText(webhook);
    const resolvedSummary = summaryText || comprehensiveResult?.summary || resolveWebhookSummary(webhook);
    const parentSegment = detectParentSegment(tags, resolvedSummary, webhook);
    const questionsAsked = mergeParentQuestionsFromExtraction(comprehensiveResult, {
        summaryText: resolvedSummary,
    });
    const missingDetails = Array.isArray(comprehensiveResult?.missing_details)
        ? comprehensiveResult.missing_details
        : (Array.isArray(webhook?.extractedMissingDetails) ? webhook.extractedMissingDetails : []);

    const isHotLead = detectHotLead({
        tags,
        summary: resolvedSummary,
        callerText,
        parentSegment,
        questionsAsked,
        missingDetails,
    });

    return applyTagPostProcessing({
        tags: enrichTags(tags, isHotLead, parentSegment),
        childName: safeStr(comprehensiveResult?.child_name)
            || webhook?.extractedChildName
            || webhook?.tour_booking_extracted?.childName
            || '',
        childAge: safeStr(comprehensiveResult?.child_age)
            || webhook?.extractedChildAge
            || webhook?.tour_booking_extracted?.childAge
            || '',
        language: comprehensiveResult?.language_spoken || webhook?.extractedLanguage || '',
        missingDetails,
        questionsAsked,
        isHotLead,
        parentSegment,
    });
}

function mapComprehensiveResult(comprehensiveResult, webhook) {
    return mapInsightFields(webhook, {
        tags: comprehensiveResult?.tags || [],
        comprehensiveResult,
        summaryText: comprehensiveResult?.summary || resolveWebhookSummary(webhook),
    });
}

function mapWebhookExtractedFields(webhook) {
    return mapInsightFields(webhook, {
        tags: webhook?.extractedTags || [],
        comprehensiveResult: webhook?.comprehensive_result || null,
        summaryText: resolveWebhookSummary(webhook),
    });
}

function mapSummaryFallback(webhook) {
    return mapInsightFields(webhook, {
        tags: [],
        comprehensiveResult: webhook?.comprehensive_result || null,
        summaryText: resolveWebhookSummary(webhook),
    });
}

function sanitizeCachedInsight(doc) {
    const parentSegment = doc.parentSegment || 'new_parent';
    const tags = doc.tags || [];
    const questionsAsked = doc.questionsAsked || [];
    const missingDetails = doc.missingDetails || [];
    const isHotLead = detectHotLead({
        tags,
        summary: doc.summary || '',
        callerText: '',
        parentSegment,
        questionsAsked,
        missingDetails,
    });
    return {
        tags: enrichTags(tags.filter((t) => t.toLowerCase() !== 'hot lead'), isHotLead, parentSegment),
        isHotLead,
        parentSegment,
    };
}

function mapLeadInsightDoc(doc) {
    if (!doc) return null;
    const sanitized = sanitizeCachedInsight(doc);
    return {
        tags: sanitized.tags,
        childName: doc.childName || '',
        childAge: doc.childAge || '',
        language: doc.language || '',
        missingDetails: doc.missingDetails || [],
        questionsAsked: doc.questionsAsked || [],
        isHotLead: sanitized.isHotLead,
        parentSegment: sanitized.parentSegment,
        aiProcessed: Boolean(doc.aiProcessed),
    };
}

function buildInsightSnapshot(webhook) {
    return {
        callerName: getCallerNameFromWebhook(webhook),
        callerPhone: getCallerPhoneFromWebhook(webhook, 'Unknown'),
        summary: resolveWebhookSummary(webhook),
        callTimestamp: webhook.metadata?.start_time_unix_secs
            ? new Date(webhook.metadata.start_time_unix_secs * 1000)
            : (webhook.received_at || new Date()),
        durationSeconds: getCallDurationSeconds(webhook),
        actionNeededEligible: !webhook.tour_booking_detected && !webhook.actionTaken,
        actionTakenFeedback: webhook.actionTakenFeedback || '',
        actionTakenAt: webhook.actionTakenAt || null,
    };
}

function buildLeadInsightPersistPayload(schoolId, webhook, insightData, transcriptHash) {
    const snapshot = buildInsightSnapshot(webhook);
    return {
        schoolId,
        webhookId: webhook._id,
        conversationId: webhook.conversation_id || '',
        aiProcessed: true,
        transcriptHash: transcriptHash || hashTranscript(getTranscriptText(webhook)),
        tags: insightData.tags || [],
        childName: insightData.childName || '',
        childAge: insightData.childAge || '',
        language: insightData.language || '',
        missingDetails: insightData.missingDetails || [],
        questionsAsked: insightData.questionsAsked || [],
        isHotLead: Boolean(insightData.isHotLead),
        parentSegment: insightData.parentSegment || 'new_parent',
        processedAt: new Date(),
        ...snapshot,
    };
}

async function upsertLeadInsight({ schoolId, webhook, insightData, transcriptHash }) {
    if (!schoolId || !webhook?._id) return null;

    const payload = buildLeadInsightPersistPayload(schoolId, webhook, insightData, transcriptHash);

    return LeadInsight.findOneAndUpdate(
        { schoolId, webhookId: webhook._id },
        { $set: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
}

async function buildInsightDataForWebhook(webhook, { allowOpenAI = false } = {}) {
    const transcriptText = getTranscriptText(webhook);
    const transcriptHash = hashTranscript(transcriptText);

    if (webhook?.comprehensive_result) {
        return { ...mapComprehensiveResult(webhook.comprehensive_result, webhook), transcriptHash };
    }

    if (webhook?.ai_processed && Array.isArray(webhook?.extractedTags)) {
        return { ...mapWebhookExtractedFields(webhook), transcriptHash };
    }

    if (allowOpenAI && transcriptText) {
        try {
            const extracted = await extractTourDetails(transcriptText, {
                childName: webhook?.tour_booking_extracted?.childName || '',
                childAge: webhook?.tour_booking_extracted?.childAge || '',
                purpose: webhook?.summary || '',
            });
            const callerText = getCallerText(webhook);
            const parentSegment = detectParentSegment(extracted.tags, webhook?.summary, webhook);
            const questionsAsked = mergeParentQuestionsFromExtraction(extracted, {
                summaryText: webhook?.summary || '',
            });
            const isHotLead = detectHotLead({
                tags: extracted.tags || [],
                summary: webhook?.summary,
                callerText,
                parentSegment,
                questionsAsked,
                missingDetails: extracted.missingDetails || [],
            });
            const data = applyTagPostProcessing({
                ...extracted,
                questionsAsked,
                tags: enrichTags(extracted.tags || [], isHotLead, parentSegment),
                isHotLead,
                parentSegment,
            });
            return { ...data, transcriptHash };
        } catch (err) {
            console.error('[LeadInsight] OpenAI extraction failed:', err.message);
        }
    }

    return { ...mapSummaryFallback(webhook), transcriptHash };
}

async function resolveInsightsForWebhooks(webhooks, schoolId, options = {}) {
    const { allowOpenAI = false, persist = false } = options;
    if (!Array.isArray(webhooks) || webhooks.length === 0) {
        return new Map();
    }

    const webhookIds = webhooks.map((wh) => wh._id);
    const existingInsights = await LeadInsight.find({
        schoolId,
        webhookId: { $in: webhookIds },
        aiProcessed: true,
    }).lean();

    const insightMap = new Map(existingInsights.map((doc) => [String(doc.webhookId), doc]));
    const resolved = new Map();
    const toPersist = [];

    for (const webhook of webhooks) {
        const key = String(webhook._id);
        const cached = insightMap.get(key);

        if (cached) {
            resolved.set(key, mapLeadInsightDoc(cached));
            continue;
        }

        if (!persist) {
            // Fast read path for page loads — never block on OpenAI or DB writes.
            resolved.set(key, mapSummaryFallback(webhook));
            continue;
        }

        const transcriptHash = hashTranscript(getTranscriptText(webhook));
        const insightData = await buildInsightDataForWebhook(webhook, { allowOpenAI });
        resolved.set(key, insightData);
        toPersist.push({ webhook, insightData, transcriptHash: insightData.transcriptHash || transcriptHash });
    }

    if (!persist || toPersist.length === 0) {
        return resolved;
    }

    const bulkOps = toPersist.map(({ webhook, insightData, transcriptHash }) => ({
        updateOne: {
            filter: { schoolId, webhookId: webhook._id },
            update: {
                $set: buildLeadInsightPersistPayload(
                    schoolId,
                    webhook,
                    insightData,
                    insightData.transcriptHash || transcriptHash
                ),
            },
            upsert: true,
        },
    }));

    await LeadInsight.bulkWrite(bulkOps, { ordered: false })
        .catch((err) => console.error('[LeadInsight] Bulk persist failed:', err.message));

    return resolved;
}

function buildActionNeededCallFromInsight(row, backendUrl, userToken, webhook = null) {
    const conversationId = row.conversationId || '';
    const sanitized = sanitizeCachedInsight(row);
    const summary = resolveCachedSummary(row, webhook);
    return {
        id: String(row.webhookId),
        conversationId: conversationId || null,
        callerName: webhook
            ? getCallerNameFromWebhook(webhook, row.callerName || 'Parent')
            : (row.callerName || 'Parent'),
        callerPhone: row.callerPhone || 'Unknown',
        summary,
        timestamp: row.callTimestamp || row.processedAt || new Date(),
        recordingUrl: conversationId
            ? `${backendUrl}/api/school/calls/${conversationId}/audio?token=${userToken}`
            : null,
        duration: row.durationSeconds || 0,
        questionsAsked: row.questionsAsked || [],
        actionTaken: row.actionNeededEligible === false,
        actionTakenAt: row.actionTakenAt || null,
        actionTakenFeedback: row.actionTakenFeedback || '',
        feedbackHistory: undefined,
        tags: sanitized.tags,
        childName: row.childName || '',
        childAge: row.childAge || '',
        language: row.language || '',
        missingDetails: row.missingDetails || [],
        isHotLead: sanitized.isHotLead,
        parentSegment: sanitized.parentSegment,
        aiProcessed: Boolean(row.aiProcessed ?? true),
    };
}

async function loadActionNeededCalls(schoolObjectId, backendUrl, userToken, options = {}) {
    const since = options.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ElevenLabsWebhook = require('../models/ElevenLabsWebhook');
    const listProjection = [
        'webhookId', 'conversationId', 'callerName', 'callerPhone', 'summary',
        'callTimestamp', 'durationSeconds', 'actionNeededEligible', 'actionTakenFeedback',
        'actionTakenAt', 'questionsAsked', 'tags', 'childName', 'childAge', 'language',
        'missingDetails', 'isHotLead', 'parentSegment', 'aiProcessed', 'processedAt',
    ].join(' ');

    const cachedRows = await LeadInsight.find({
        schoolId: schoolObjectId,
        actionNeededEligible: true,
        callTimestamp: { $gte: since },
    })
        .select(listProjection)
        .sort({ callTimestamp: -1 })
        .lean();

    if (cachedRows.length > 0) {
        const webhookIds = cachedRows.map((row) => row.webhookId).filter(Boolean);
        const webhooks = await ElevenLabsWebhook.find({ _id: { $in: webhookIds } })
            .select('_id conversation_id summary transcript comprehensive_result tour_booking_extracted metadata received_at user_id')
            .lean();
        const webhookMap = new Map(webhooks.map((wh) => [String(wh._id), wh]));

        return cachedRows.map((row) =>
            buildActionNeededCallFromInsight(
                row,
                backendUrl,
                userToken,
                webhookMap.get(String(row.webhookId)) || null
            )
        );
    }

    const webhooks = await ElevenLabsWebhook.find({
        type: 'post_call_transcription',
        received_at: { $gte: since },
        tour_booking_detected: { $ne: true },
        actionTaken: { $ne: true },
        schoolId: schoolObjectId,
    })
        .select('_id conversation_id received_at metadata summary tour_booking_extracted comprehensive_result user_id actionTakenFeedback actionTakenAt feedbackHistory')
        .sort({ received_at: -1 })
        .lean();

    const insightMap = await resolveInsightsForWebhooks(webhooks, schoolObjectId, {
        allowOpenAI: false,
        persist: false,
    });

    return webhooks.map((wh) =>
        buildActionNeededCall(wh, insightMap.get(String(wh._id)), backendUrl, userToken)
    );
}

async function markLeadInsightActionTaken(webhookId, feedback = '') {
    await LeadInsight.updateOne(
        { webhookId },
        {
            $set: {
                actionNeededEligible: false,
                actionTakenFeedback: feedback || '',
                actionTakenAt: new Date(),
            },
        }
    );
}

async function removeLeadInsightForWebhook(webhookId) {
    await LeadInsight.deleteOne({ webhookId });
}

function buildActionNeededCall(webhook, insight, backendUrl, userToken) {
    const data = insight || mapSummaryFallback(webhook);

    return {
        id: webhook._id.toString(),
        conversationId: webhook.conversation_id,
        callerName: getCallerNameFromWebhook(webhook),
        callerPhone: getCallerPhoneFromWebhook(webhook, 'Unknown'),
        summary: resolveWebhookSummary(webhook),
        timestamp: webhook.metadata?.start_time_unix_secs
            ? new Date(webhook.metadata.start_time_unix_secs * 1000)
            : webhook.received_at,
        recordingUrl: webhook.conversation_id
            ? `${backendUrl}/api/school/calls/${webhook.conversation_id}/audio?token=${userToken}`
            : null,
        duration: getCallDurationSeconds(webhook),
        questionsAsked: data.questionsAsked || [],
        actionTaken: webhook.actionTaken || false,
        actionTakenAt: webhook.actionTakenAt || null,
        actionTakenFeedback: webhook.actionTakenFeedback || '',
        feedbackHistory: webhook.feedbackHistory || undefined,
        tags: data.tags || [],
        childName: data.childName || '',
        childAge: data.childAge || '',
        language: data.language || '',
        missingDetails: data.missingDetails || [],
        isHotLead: Boolean(data.isHotLead),
        parentSegment: data.parentSegment || 'new_parent',
        aiProcessed: Boolean(data.aiProcessed ?? true),
    };
}

module.exports = {
    hashTranscript,
    getTranscriptText,
    detectHotLead,
    detectParentSegment,
    enrichTags,
    mapComprehensiveResult,
    mapWebhookExtractedFields,
    mapSummaryFallback,
    upsertLeadInsight,
    buildInsightDataForWebhook,
    resolveInsightsForWebhooks,
    buildActionNeededCall,
    buildActionNeededCallFromInsight,
    loadActionNeededCalls,
    markLeadInsightActionTaken,
    removeLeadInsightForWebhook,
    buildInsightSnapshot,
    buildLeadInsightPersistPayload,
};
