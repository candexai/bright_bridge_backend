const crypto = require('crypto');
const LeadInsight = require('../models/LeadInsight');
const { extractTourDetails, mergeParentQuestionsFromExtraction, filterSchoolQuestions } = require('../utils/openai');
const { getCallerPhoneFromWebhook, getCallDurationSeconds, getCallerNameFromWebhook } = require('../utils/webhookHelpers');
const { resolveWebhookSummary, resolveCachedSummary, isNoMeaningfulInteractionSummary, isCurrentFamilyCall } = require('../utils/currentFamilyTransfer');

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

const TOUR_BOOKED_TAG = 'Tour booked';
const TOUR_BOOKED_EMAIL_MISSING_TAG = 'Tour booked - email missing';

const TOUR_DETAILS_BY_PHONE_PATTERN = /(?:we(?:'|')?ll\s+)?make sure you have your tour details by phone|confirm your tour details by phone|tour details by phone/i;

const EMAIL_SKIPPED_AGENT_PATTERNS = [
    TOUR_DETAILS_BY_PHONE_PATTERN,
    /email as not collected/i,
    /skip(?:ped)? email/i,
    /without (?:an? )?email/i,
    /proceed without email/i,
];

const EMAIL_FLOW_PROMPT_PATTERN = /(?:email|e-mail|spell.*email|@gmail|@yahoo|@hotmail|@outlook|\.com)/i;
const EMAIL_CONFIRM_PATTERN = /did i get that correct|is that correct|did i get it right|is that right/i;
const EMAIL_RETRY_PATTERN = /spell your email.*again|email for me again/i;
const EMAIL_SKIP_PATTERN = /no problem|without email|email as not collected|skip email|make sure you have your tour details by phone|tour details by phone/i;
const USER_EMAIL_NO_PATTERN = /^(no|nope|nah|incorrect|wrong|that's wrong|that is wrong|not correct|that's not|that isn't)\.?$/i;
const USER_EMAIL_YES_PATTERN = /^(yes|yeah|yep|yup|correct|that's right|that is right|that's correct)\.?$/i;

function isValidConfirmedEmail(email) {
    const t = String(email || '').trim();
    if (!t) return false;
    if (/^(not provided|n\/a|none|unknown)$/i.test(t)) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(t);
}

function normalizeEmailForCompare(email) {
    return String(email || '').trim().toLowerCase();
}

/** Collect the first valid email from webhook extraction, tour booking, or other sources. */
function getValidEmailFromSources(webhook, comprehensiveResult = null, extraEmails = []) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    const candidates = [
        resolved?.parent_email,
        resolved?.one_pager?.header?.email,
        webhook?.tour_booking_extracted?.email,
        ...(Array.isArray(extraEmails) ? extraEmails : [extraEmails]),
    ];
    for (const email of candidates) {
        if (isValidConfirmedEmail(email)) return String(email).trim();
    }
    return '';
}

function isAgentRole(role) {
    const r = String(role || '').toLowerCase();
    return r === 'agent' || r === 'assistant' || r === 'mia' || r === 'nora' || r.includes('assistant');
}

function isCallerRole(role) {
    const r = String(role || '').toLowerCase();
    return r === 'user' || r === 'parent' || r === 'caller' || r === 'customer' || r === 'human' || r.includes('caller');
}

/** Nora confirmed tour by phone instead of email — mandatory email-missing when tour is booked. */
function agentConfirmedTourDetailsByPhone(webhook, comprehensiveResult = null) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    if (!isTourBooked(webhook, resolved)) return false;

    const summary = String(resolved?.summary || webhook?.summary || '');
    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(summary)) return true;

    const agentText = getAgentText(webhook);
    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(agentText)) return true;

    if (Array.isArray(webhook?.transcript)) {
        for (const raw of webhook.transcript) {
            if (!isAgentRole(raw.role)) continue;
            const text = String(raw.message || raw.text || '').trim();
            if (text && TOUR_DETAILS_BY_PHONE_PATTERN.test(text)) return true;
        }
    }

    return false;
}

function wasEmailSkippedOrRejectedInTranscript(webhook, comprehensiveResult = null, options = {}) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;

    if (agentConfirmedTourDetailsByPhone(webhook, resolved)) {
        return true;
    }

    const summary = String(resolved?.summary || webhook?.summary || '').trim();

    if (TOUR_DETAILS_BY_PHONE_PATTERN.test(summary)) {
        return true;
    }
    if (
        /email.{0,40}(?:not collected|not captured|not confirmed|skipped|could not confirm|without email)/i.test(summary)
        || /(?:skipped|without).{0,20}email/i.test(summary)
    ) {
        return true;
    }

    const missingDetails = Array.isArray(resolved?.missing_details) ? resolved.missing_details : [];
    if (
        missingDetails.some((item) => /parent email|email address/i.test(String(item)))
        && isTourBooked(webhook, resolved)
    ) {
        return true;
    }

    const onePagerEmail = safeStr(resolved?.one_pager?.header?.email);
    if (/not provided/i.test(onePagerEmail) && isTourBooked(webhook, resolved)) {
        return true;
    }

    const rawEmail = safeStr(resolved?.parent_email) || safeStr(webhook?.tour_booking_extracted?.email);
    if (isTourBooked(webhook, resolved) && rawEmail.trim() && !isValidConfirmedEmail(rawEmail)) {
        return true;
    }

    if (!Array.isArray(webhook?.transcript) || webhook.transcript.length === 0) {
        return false;
    }

    const agentText = getAgentText(webhook);
    if (EMAIL_SKIPPED_AGENT_PATTERNS.some((pattern) => pattern.test(agentText))) {
        return true;
    }

    let inEmailFlow = false;
    let awaitingConfirm = false;
    let rejections = 0;
    let emailConfirmedInCall = false;

    for (const raw of webhook.transcript) {
        const role = String(raw.role || '').toLowerCase();
        const text = String(raw.message || raw.text || '').trim();
        if (!text) continue;

        const isAgent = isAgentRole(role);
        const isUser = isCallerRole(role);

        if (isAgent) {
            if (inEmailFlow && EMAIL_SKIP_PATTERN.test(text) && rejections >= 1) {
                return true;
            }
            if (EMAIL_FLOW_PROMPT_PATTERN.test(text)) {
                inEmailFlow = true;
            }
            if (inEmailFlow && EMAIL_CONFIRM_PATTERN.test(text)) {
                awaitingConfirm = true;
            }
            if (inEmailFlow && EMAIL_RETRY_PATTERN.test(text)) {
                awaitingConfirm = false;
            }
            if (inEmailFlow && (/what is your child'?s name/i.test(text) || /just to confirm/i.test(text)) && rejections >= 1) {
                return true;
            }
        }

        if (isUser && awaitingConfirm) {
            const lower = text.toLowerCase();
            if (USER_EMAIL_NO_PATTERN.test(lower) || /\b(no|nope|wrong|incorrect)\b/i.test(lower)) {
                rejections += 1;
                awaitingConfirm = false;
                if (rejections >= 1) return true;
            } else if (USER_EMAIL_YES_PATTERN.test(lower)) {
                emailConfirmedInCall = true;
                inEmailFlow = false;
                awaitingConfirm = false;
                rejections = 0;
            }
        }
    }

    if (emailConfirmedInCall) return false;
    return rejections >= 1;
}

function resolveParentEmail(webhook, comprehensiveResult = null, options = {}) {
    const extraEmails = options.extraEmails || [];
    const fromSources = getValidEmailFromSources(webhook, comprehensiveResult, extraEmails);
    if (fromSources) return fromSources;
    if (wasEmailSkippedOrRejectedInTranscript(webhook, comprehensiveResult, options)) {
        return '';
    }
    return '';
}

function isTourBooked(webhook, comprehensiveResult = null) {
    if (comprehensiveResult?.tour_booked === true) return true;
    return webhook?.tour_booking_detected === true;
}

function getStoredEmailNorms(webhook, comprehensiveResult = null) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    return [
        resolved?.parent_email,
        webhook?.tour_booking_extracted?.email,
    ]
        .map((email) => normalizeEmailForCompare(email))
        .filter(Boolean);
}

function isTourBookedEmailMissing(webhook, comprehensiveResult = null, options = {}) {
    const resolved = comprehensiveResult ?? webhook?.comprehensive_result ?? null;
    if (!isTourBooked(webhook, resolved)) return false;

    // Hard rule: Nora said tour details will be confirmed by phone → email was not collected.
    if (agentConfirmedTourDetailsByPhone(webhook, resolved)) {
        return true;
    }

    const skipped = wasEmailSkippedOrRejectedInTranscript(webhook, resolved, options);
    const validTourEmail = (options.extraEmails || [])
        .map((email) => String(email || '').trim())
        .find(isValidConfirmedEmail);

    if (skipped) {
        const tourNorm = validTourEmail ? normalizeEmailForCompare(validTourEmail) : '';
        const storedNorms = getStoredEmailNorms(webhook, resolved);
        // Tour record copied the same AI-hallucinated email from this failed call — still missing.
        if (tourNorm && storedNorms.includes(tourNorm)) return true;
        // Tour record has a different valid email than this call's failed extraction.
        if (tourNorm) return false;
        return true;
    }

    if (getValidEmailFromSources(webhook, resolved, options.extraEmails || [])) return false;
    return true;
}

function ensureTourBookedEmailMissingTag(tags, { tourBooked, parentEmail, emailMissing } = {}) {
    const next = dedupeTags(Array.isArray(tags) ? tags : []);
    if (!tourBooked) return next;

    const hasTourBookedOnly = next.some((tag) => {
        const lower = String(tag).toLowerCase();
        return lower === 'tour booked' || (lower.includes('tour booked') && !lower.includes('email'));
    });
    if (!hasTourBookedOnly) {
        next.unshift(TOUR_BOOKED_TAG);
    }

    const missing = emailMissing !== undefined
        ? emailMissing
        : !String(parentEmail || '').trim();
    if (missing) {
        if (!next.some((tag) => tag.toLowerCase().includes('email missing'))) {
            next.push(TOUR_BOOKED_EMAIL_MISSING_TAG);
        }
    } else {
        return dedupeTags(next.filter((tag) => !String(tag).toLowerCase().includes('email missing')));
    }
    return dedupeTags(next);
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

function getCallerSchoolQuestions(callerText) {
    const caller = String(callerText || '').trim();
    if (!caller) return [];
    const chunks = caller
        .split(/\s*\|\s*|\n+/)
        .flatMap((line) => line.split(/(?<=[.!?])\s+/))
        .map((s) => s.trim())
        .filter((s) => s.length > 8);
    return filterSchoolQuestions(chunks);
}

function hasSchoolKbInquiry({
    questionsAsked = [],
    callerText = '',
    comprehensiveResult = null,
} = {}) {
    if (filterSchoolQuestions(questionsAsked).length > 0) return true;
    if (comprehensiveResult && mergeParentQuestionsFromExtraction(comprehensiveResult).length > 0) {
        return true;
    }
    return getCallerSchoolQuestions(callerText).length > 0;
}

function detectHotLead({
    tags = [],
    summary = '',
    callerText = '',
    parentSegment = 'new_parent',
    questionsAsked = [],
    missingDetails = [],
    comprehensiveResult = null,
} = {}) {
    const summaryText = String(summary || '').toLowerCase();
    const schoolInquiry = hasSchoolKbInquiry({ questionsAsked, callerText, comprehensiveResult });

    if (/no meaningful interaction|did not engage|call was interrupted|caller did not/i.test(summaryText)) {
        return false;
    }

    // Partial / early hang-ups with no school questions are not hot leads.
    // Callers who asked about tuition, programs, meals, etc. still qualify even if
    // the call ended before all contact details were collected (e.g. Arjun).
    if (!schoolInquiry) {
        if (
            /ended before any additional information|before any .{0,40}(?:could be )?collected/i.test(summaryText)
            || /no questions (?:were )?asked/i.test(summaryText)
            || /call ended before/i.test(summaryText)
        ) {
            return false;
        }
    }

    if (parentSegment === 'unknown') {
        return false;
    }

    if (!schoolInquiry) {
        return false;
    }

    if (parentSegment === 'current_family') {
        const inquiryHaystack = `${callerText} ${filterSchoolQuestions(questionsAsked).join(' ')}`.trim();
        return CURRENT_FAMILY_INQUIRY_PATTERNS.some((pattern) => pattern.test(inquiryHaystack));
    }

    return true;
}

// Reliable current/existing-family self-identification only. Generic human-routing
// ("front desk", "representative", "talk to the director") is intentionally excluded —
// new families ask for a human too — and is instead covered by the guarded LLM tag.
const CALLER_CURRENT_FAMILY_PATTERNS = [
    /^currents?\.?$/i,
    /^current family\.?$/i,
    /\b(i(?:'m| am)|we(?:'re| are))(?: a)? current family\b/i,
    /\bcurrent family\b/i,
    /\bcurrent(?:ly)? enrolled\b/i,
    /\benrolled family\b/i,
    /\b(i(?:'m| am)|we(?:'re| are))(?: an?)? enrolled\b/i,
    /\balready enrolled\b/i,
    /\bexisting (?:family|parent)\b/i,
    /\balready go(?:es)? (?:there|here)\b/i,
    /\bfamilia actual\b/i,
    /\bfamilia inscrita\b/i,
    /\b(?:ya\s+)?(?:est[aá]\s+)?inscrit[oa]s?\b/i,
    /^front desk\??$/i,
];

function callerIdentifiedAsCurrentFamily(callerText) {
    const callerHaystack = String(callerText || '').toLowerCase().trim();
    if (!callerHaystack) return false;

    const callerLines = callerHaystack.split(/\s*\|\s*|\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of callerLines) {
        if (CALLER_CURRENT_FAMILY_PATTERNS.some((pattern) => pattern.test(line))) {
            return true;
        }
    }

    return CALLER_CURRENT_FAMILY_PATTERNS.some((pattern) => pattern.test(callerHaystack));
}

function agentTriggeredCurrentFamilyTransfer(agentText) {
    const agentHaystack = String(agentText || '').toLowerCase();
    if (!agentHaystack) return false;
    return AGENT_CURRENT_FAMILY_TRANSFER_PATTERNS.some((pattern) => pattern.test(agentHaystack));
}

function hasSchoolRelatedIntent({
    summary = '',
    callerText = '',
    questionsAsked = [],
    comprehensiveResult = null,
    tags = [],
} = {}) {
    const topics = Array.isArray(comprehensiveResult?.topics_of_interest)
        ? comprehensiveResult.topics_of_interest.join(' ')
        : '';
    const inquiryHaystack = `${callerText} ${(questionsAsked || []).join(' ')} ${topics}`.toLowerCase();
    const summaryText = String(summary || '').toLowerCase();
    const tagHaystack = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();

    if (/tour requested|hot lead|urgency:/i.test(tagHaystack)) return true;
    if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(inquiryHaystack))) return true;
    if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(summaryText))) return true;

    const realQuestions = (questionsAsked || []).filter((q) => String(q || '').trim().length > 8);
    if (realQuestions.length > 0) {
        const qHaystack = realQuestions.join(' ').toLowerCase();
        if (NEW_PARENT_INTENT_PATTERNS.some((pattern) => pattern.test(qHaystack))) return true;
    }

    return false;
}

function hasCapturedEnrollmentData({ childName = '', childAge = '', comprehensiveResult = null } = {}) {
    if (String(childName || '').trim() || String(childAge || '').trim()) return true;
    const parentName = comprehensiveResult?.parent_name;
    const parentEmail = comprehensiveResult?.parent_email;
    const parentPhone = comprehensiveResult?.parent_phone;
    if (parentName && String(parentName).trim() && !/^parent$/i.test(String(parentName).trim())) return true;
    if (parentEmail && String(parentEmail).trim()) return true;
    if (parentPhone && String(parentPhone).trim()) return true;
    return false;
}

function isUnknownCall({
    tags = [],
    summary = '',
    callerText = '',
    questionsAsked = [],
    comprehensiveResult = null,
    childName = '',
    childAge = '',
    tourBooked = false,
} = {}) {
    if (tourBooked) return false;
    if (comprehensiveResult?.call_state === 'no_interaction') return true;

    const summaryText = String(summary || '');
    if (isNoMeaningfulInteractionSummary(summaryText)) return true;
    if (/primarily greetings|misdial|silence|background noise|only greetings/i.test(summaryText.toLowerCase())) {
        return true;
    }

    const params = {
        tags,
        summary: summaryText,
        callerText,
        questionsAsked,
        comprehensiveResult,
        childName,
        childAge,
        tourBooked,
    };

    if (hasSchoolRelatedIntent(params)) return false;
    if (hasCapturedEnrollmentData(params)) return false;

    return true;
}

function detectParentSegment(tags, summary, webhookOrCallerText, options = {}) {
    const webhook = typeof webhookOrCallerText === 'object' && webhookOrCallerText !== null
        ? webhookOrCallerText
        : null;
    const callerText = webhook ? getCallerText(webhook) : String(webhookOrCallerText || '');

    const comprehensiveResult = options.comprehensiveResult
        ?? (typeof webhookOrCallerText === 'object' ? webhookOrCallerText?.comprehensive_result : null)
        ?? null;

    // Current family: transcript proof, OR the extractor's guarded "Current Family" tag.
    if (webhook?.transcript && isCurrentFamilyCall(webhook.transcript)) {
        return 'current_family';
    }
    if (callerIdentifiedAsCurrentFamily(callerText)) {
        return 'current_family';
    }
    // The comprehensive prompt only allows the "Current Family" tag when the caller explicitly
    // self-identified as current/existing/enrolled, so trust it (except when nothing meaningful
    // was said). This catches phrasings and ASR variance the regex above misses.
    const tagList = Array.isArray(tags) ? tags : [];
    const hasCurrentFamilyTag = tagList.some((t) => String(t).trim().toLowerCase() === 'current family');
    if (hasCurrentFamilyTag && comprehensiveResult?.call_state !== 'no_interaction') {
        return 'current_family';
    }

    const questionsAsked = options.questionsAsked || [];
    const childName = options.childName || '';
    const childAge = options.childAge || '';
    const tourBooked = options.tourBooked
        ?? (webhook ? isTourBooked(webhook, comprehensiveResult) : false);

    if (isUnknownCall({
        tags,
        summary: summary || (webhook ? resolveWebhookSummary(webhook) : ''),
        callerText,
        questionsAsked,
        comprehensiveResult,
        childName,
        childAge,
        tourBooked,
    })) {
        return 'unknown';
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
    } else if (parentSegment === 'unknown' && !hasTag('Unknown')) {
        next.push('Unknown');
    } else if (parentSegment === 'new_parent' && !hasTag('New Parent')) {
        next.push('New Parent');
    }

    if (parentSegment === 'unknown') {
        next = next.filter((tag) => tag.toLowerCase() !== 'new parent');
        next = next.filter((tag) => tag.toLowerCase() !== 'current family');
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

    data.tags = ensureTourBookedEmailMissingTag(data.tags, {
        tourBooked: data.tourBooked,
        parentEmail: data.parentEmail,
        emailMissing: data.emailMissing,
    });

    data.tags = dedupeTags(data.tags);
    if (!data.isHotLead) {
        data.tags = data.tags.filter((tag) => tag.toLowerCase() !== 'hot lead');
    }

    return data;
}

function mapInsightFields(webhook, { tags = [], comprehensiveResult = null, summaryText = '' } = {}) {
    const callerText = getCallerText(webhook);
    const resolvedSummary = summaryText || comprehensiveResult?.summary || resolveWebhookSummary(webhook);
    const questionsAsked = mergeParentQuestionsFromExtraction(comprehensiveResult, {
        summaryText: resolvedSummary,
    });
    const missingDetails = Array.isArray(comprehensiveResult?.missing_details)
        ? comprehensiveResult.missing_details
        : (Array.isArray(webhook?.extractedMissingDetails) ? webhook.extractedMissingDetails : []);
    const tourBooked = isTourBooked(webhook, comprehensiveResult);
    const parentEmail = resolveParentEmail(webhook, comprehensiveResult);
    const emailMissing = isTourBookedEmailMissing(webhook, comprehensiveResult);
    const childName = safeStr(comprehensiveResult?.child_name)
        || webhook?.extractedChildName
        || webhook?.tour_booking_extracted?.childName
        || '';
    const childAge = safeStr(comprehensiveResult?.child_age)
        || webhook?.extractedChildAge
        || webhook?.tour_booking_extracted?.childAge
        || '';
    const parentSegment = detectParentSegment(tags, resolvedSummary, webhook, {
        comprehensiveResult,
        questionsAsked,
        childName,
        childAge,
        tourBooked,
    });

    const isHotLead = detectHotLead({
        tags,
        summary: resolvedSummary,
        callerText,
        parentSegment,
        questionsAsked,
        missingDetails,
        comprehensiveResult,
    });

    return applyTagPostProcessing({
        tags: enrichTags(tags, isHotLead, parentSegment),
        childName,
        childAge,
        language: comprehensiveResult?.language_spoken || webhook?.extractedLanguage || '',
        missingDetails,
        questionsAsked,
        isHotLead,
        parentSegment,
        tourBooked,
        parentEmail,
        emailMissing,
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

function sanitizeCachedInsight(doc, webhook = null) {
    let parentSegment = doc.parentSegment || 'new_parent';
    let tags = doc.tags || [];

    if (webhook) {
        const fresh = webhook.comprehensive_result
            ? mapComprehensiveResult(webhook.comprehensive_result, webhook)
            : mapSummaryFallback(webhook);
        parentSegment = fresh.parentSegment || parentSegment;
        tags = fresh.tags || tags;
    }

    const questionsAsked = doc.questionsAsked || [];
    const missingDetails = doc.missingDetails || [];
    const isHotLead = detectHotLead({
        tags,
        summary: doc.summary || '',
        callerText: webhook ? getCallerText(webhook) : '',
        parentSegment,
        questionsAsked,
        missingDetails,
        comprehensiveResult: webhook?.comprehensive_result || null,
    });
    return {
        tags: enrichTags(tags.filter((t) => t.toLowerCase() !== 'hot lead'), isHotLead, parentSegment),
        isHotLead,
        parentSegment,
    };
}

function mapLeadInsightDoc(doc, webhook = null) {
    if (!doc) return null;
    const sanitized = sanitizeCachedInsight(doc, webhook);
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

function buildInsightSnapshot(webhook, insightData = {}) {
    const emailMissingForTour = isTourBookedEmailMissing(webhook);
    const parentSegment = insightData.parentSegment || 'new_parent';
    return {
        callerName: getCallerNameFromWebhook(webhook),
        callerPhone: getCallerPhoneFromWebhook(webhook, 'Unknown'),
        summary: resolveWebhookSummary(webhook),
        callTimestamp: webhook.metadata?.start_time_unix_secs
            ? new Date(webhook.metadata.start_time_unix_secs * 1000)
            : (webhook.received_at || new Date()),
        durationSeconds: getCallDurationSeconds(webhook),
        actionNeededEligible: emailMissingForTour
            ? !webhook.actionTaken
            : (!webhook.tour_booking_detected && !webhook.actionTaken),
        actionTakenFeedback: webhook.actionTakenFeedback || '',
        actionTakenAt: webhook.actionTakenAt || null,
    };
}

function buildLeadInsightPersistPayload(schoolId, webhook, insightData, transcriptHash) {
    const snapshot = buildInsightSnapshot(webhook, insightData);
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
                comprehensiveResult: extracted,
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
            resolved.set(key, mapLeadInsightDoc(cached, webhook));
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
    const sanitized = sanitizeCachedInsight(row, webhook);
    const tags = webhook
        ? ensureTourBookedEmailMissingTag(sanitized.tags, {
            tourBooked: isTourBooked(webhook),
            parentEmail: resolveParentEmail(webhook),
            emailMissing: isTourBookedEmailMissing(webhook),
        })
        : sanitized.tags;
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
        actionTaken: Boolean(webhook?.actionTaken),
        actionTakenAt: row.actionTakenAt || null,
        actionTakenFeedback: row.actionTakenFeedback || '',
        feedbackHistory: undefined,
        tags,
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
        callTimestamp: { $gte: since },
        $or: [
            { actionNeededEligible: true },
            { parentSegment: 'unknown' },
        ],
    })
        .select(listProjection)
        .sort({ callTimestamp: -1 })
        .lean();

    if (cachedRows.length > 0) {
        const webhookIds = cachedRows.map((row) => row.webhookId).filter(Boolean);
        const webhooks = await ElevenLabsWebhook.find({ _id: { $in: webhookIds } })
            .select('_id conversation_id summary transcript comprehensive_result tour_booking_extracted metadata received_at user_id actionTaken actionTakenFeedback actionTakenAt')
            .lean();
        const webhookMap = new Map(webhooks.map((wh) => [String(wh._id), wh]));

        return cachedRows
            .map((row) =>
                buildActionNeededCallFromInsight(
                    row,
                    backendUrl,
                    userToken,
                    webhookMap.get(String(row.webhookId)) || null
                )
            )
            .filter((call) => !call.actionTaken);
    }

    const webhooks = await ElevenLabsWebhook.find({
        type: 'post_call_transcription',
        received_at: { $gte: since },
        actionTaken: { $ne: true },
        schoolId: schoolObjectId,
    })
        .select('_id conversation_id received_at metadata summary tour_booking_detected tour_booking_extracted comprehensive_result user_id actionTakenFeedback actionTakenAt feedbackHistory')
        .sort({ received_at: -1 })
        .lean();

    const eligibleWebhooks = webhooks.filter((wh) => {
        if (!wh.tour_booking_detected) return true;
        return isTourBookedEmailMissing(wh);
    });

    const insightMap = await resolveInsightsForWebhooks(eligibleWebhooks, schoolObjectId, {
        allowOpenAI: false,
        persist: false,
    });

    return eligibleWebhooks
        .map((wh) =>
            buildActionNeededCall(wh, insightMap.get(String(wh._id)), backendUrl, userToken)
        )
        .filter((call) => !call.actionTaken);
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
    TOUR_BOOKED_TAG,
    TOUR_BOOKED_EMAIL_MISSING_TAG,
    hashTranscript,
    getTranscriptText,
    detectHotLead,
    detectParentSegment,
    enrichTags,
    resolveParentEmail,
    isTourBooked,
    isTourBookedEmailMissing,
    wasEmailSkippedOrRejectedInTranscript,
    isValidConfirmedEmail,
    getValidEmailFromSources,
    ensureTourBookedEmailMissingTag,
    isUnknownCall,
    hasSchoolRelatedIntent,
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
