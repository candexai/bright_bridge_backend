const axios = require('axios');
const { getComprehensivePrompt } = require('../utils/comprehensivePrompt');
const {
    isCurrentFamilyTransferCall,
    isCurrentFamilyCall,
    buildCurrentFamilyTransferResult,
    isNoMeaningfulInteractionSummary,
    callerIdentifiedAsCurrentFamily,
    getCallerTextFromTranscript,
} = require('../utils/currentFamilyTransfer');
const AlertService = require('./alertService');

function reportOpenAIAlert(err, context = {}) {
    const status = err?.response?.status;
    let severity = 'WARNING';
    let type = 'OPENAI_ERROR';
    if (status === 401) severity = 'CRITICAL';
    if (status === 429) {
        severity = 'CRITICAL';
        type = 'RATE_LIMIT_ERROR';
    }
    if (err?.code === 'ECONNABORTED') severity = 'WARNING';
    AlertService.create({
        type,
        severity,
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        title: context.title || 'OpenAI API failure',
        message: err?.response?.data?.error?.message || err?.message || 'OpenAI request failed',
        source: context.source || 'openaiService',
        metadata: { status, stack: err?.stack },
    });
}

/**
 * Format transcript array into readable text
 */
function formatTranscript(transcriptArray) {
    if (!Array.isArray(transcriptArray) || transcriptArray.length === 0) {
        return '';
    }
    
    return transcriptArray
        .map(entry => {
            const role = entry.role || entry.speaker || 'unknown';
            const text = entry.text || entry.content || entry.message || '';
            const toolCalls = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0 
                ? entry.tool_calls.map(tc => `[Tool Call: ${tc.tool_name}(${tc.params_as_json || ''})]`).join('\n')
                : '';
            const toolResults = Array.isArray(entry.tool_results) && entry.tool_results.length > 0
                ? entry.tool_results.map(tr => `[Tool Result: ${tr.tool_name} -> ${tr.result_value}]`).join('\n')
                : '';
                
            let result = '';
            if (role) result += `${role}: `;
            if (text) result += text;
            if (toolCalls) result += (text ? '\n' : '') + toolCalls;
            if (toolResults) result += (text || toolCalls ? '\n' : '') + toolResults;
            
            return result;
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * Process transcript with comprehensive prompt to extract all information
 */
async function processTranscriptComprehensive(transcriptArray) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.warn('[OpenAI] OPENAI_API_KEY not configured, skipping comprehensive processing');
        return null;
    }

    try {
        const transcriptText = formatTranscript(transcriptArray);
        if (!transcriptText || transcriptText.trim().length === 0) {
            console.warn('[OpenAI] Empty transcript, cannot process');
            return null;
        }

        // Check if transcript is too short to extract meaningful insights
        const wordCount = transcriptText.split(/\s+/).filter(word => word.length > 0).length;
        const transcriptLength = transcriptText.length;
        
        if (isCurrentFamilyCall(transcriptArray)) {
            console.log('[OpenAI] Current family call detected. Returning transfer summary.');
            return buildCurrentFamilyTransferResult(transcriptArray);
        }

        // If transcript is very short, return minimal information without calling AI
        if (transcriptLength < 50 || wordCount < 10) {
            if (isCurrentFamilyCall(transcriptArray)) {
                console.log('[OpenAI] Short current-family call detected. Returning transfer summary.');
                return buildCurrentFamilyTransferResult(transcriptArray);
            }
            console.log(`[OpenAI] Transcript too short (${wordCount} words, ${transcriptLength} chars). Returning minimal response.`);
            return {
                call_state: "no_interaction",
                parent_name: null,
                parent_phone: null,
                parent_email: null,
                child_name: null,
                child_age: null,
                tour_booked: false,
                tour_date: null,
                tour_time: null,
                tour_datetime_iso: null,
                questions_asked: [],
                topics_of_interest: [],
                enrollment_urgency: "unknown",
                enrollment_target_date: null,
                language_spoken: "English",
                summary: "No meaningful interaction. The call was interrupted or the caller did not engage.",
                email: {
                    subject: "No Interaction - Call Interrupted",
                    body: "No meaningful interaction occurred during this call. The call was interrupted or the caller did not engage.\n\n- Nora, Kids R Kids Virtual Assistant"
                },
                one_pager: {
                    header: {
                        parent_name: "Not provided",
                        phone: "Not provided",
                        email: "Not provided",
                        children: []
                    },
                    tour_info: {
                        scheduled: false,
                        date_display: "Not scheduled",
                        attention_flag: "No interaction - call interrupted"
                    },
                    what_they_asked_about: [],
                    tour_talking_points: []
                }
            };
        }

        const prompt = getComprehensivePrompt(transcriptText);

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 2000,
                temperature: 0.1,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const content = response.data?.choices?.[0]?.message?.content?.trim();
        if (!content) {
            console.warn('[OpenAI] No content returned from comprehensive processing');
            return null;
        }

        // Parse JSON response
        const result = JSON.parse(content);
        if (
            (result.call_state === 'no_interaction' || isNoMeaningfulInteractionSummary(result.summary))
            && isCurrentFamilyCall(transcriptArray)
        ) {
            console.log('[OpenAI] Overriding no-interaction result for current family transfer call.');
            return buildCurrentFamilyTransferResult(transcriptArray);
        }
        console.log('[OpenAI] Comprehensive processing completed successfully');
        return result;

    } catch (err) {
        console.error('[OpenAI] Error in comprehensive processing:', err.response?.data || err.message);
        reportOpenAIAlert(err, {
            title: 'OpenAI transcript processing failed',
            source: 'openaiService.processTranscriptComprehensive',
        });
        return null;
    }
}

/**
 * Extract tour booking information from comprehensive result (legacy compatibility)
 */
function extractTourBookingFromComprehensive(comprehensiveResult) {
    if (!comprehensiveResult) {
        return null;
    }

    return {
        tour_booked: comprehensiveResult.tour_booked || false,
        name: comprehensiveResult.parent_name || null,
        phone: comprehensiveResult.parent_phone || null,
        email: comprehensiveResult.parent_email || null,
        childName: comprehensiveResult.child_name ? (Array.isArray(comprehensiveResult.child_name) ? comprehensiveResult.child_name[0] : comprehensiveResult.child_name) : null,
        childAge: comprehensiveResult.child_age ? (Array.isArray(comprehensiveResult.child_age) ? comprehensiveResult.child_age[0] : comprehensiveResult.child_age) : null,
        reason: comprehensiveResult.topics_of_interest ? comprehensiveResult.topics_of_interest.join(', ') : null,
        date: comprehensiveResult.tour_date || null,
        time: comprehensiveResult.tour_time || null,
        datetime: comprehensiveResult.tour_datetime_iso || null,
        notes: comprehensiveResult.summary || null,
        raw_response: comprehensiveResult
    };
}

/**
 * Extract summary from comprehensive result (legacy compatibility)
 */
function extractSummaryFromComprehensive(comprehensiveResult) {
    return comprehensiveResult?.summary || null;
}

/**
 * Process transcript with comprehensive prompt (main function)
 */
async function processTranscript(transcriptArray) {
    try {
        console.log('[OpenAI] Starting comprehensive transcript processing...');
        
        const comprehensiveResult = await processTranscriptComprehensive(transcriptArray);
        
        if (!comprehensiveResult) {
            console.warn('[OpenAI] Comprehensive processing failed, returning empty result');
            return {
                summary: '',
                tour_booking_detected: false,
                tour_booking_date: null,
                tour_booking_extracted: null,
                comprehensive_result: null
            };
        }

        // Extract legacy format for backward compatibility
        const summary = extractSummaryFromComprehensive(comprehensiveResult);
        const tourBooking = extractTourBookingFromComprehensive(comprehensiveResult);

        const result = {
            summary: summary || '',
            tour_booking_detected: tourBooking?.tour_booked || false,
            tour_booking_date: tourBooking?.datetime || null,
            tour_booking_extracted: tourBooking || null,
            comprehensive_result: comprehensiveResult
        };

        console.log('[OpenAI] Comprehensive transcript processing complete:', {
            has_summary: !!result.summary,
            tour_detected: result.tour_booking_detected,
            tour_date: result.tour_booking_date,
            call_state: comprehensiveResult.call_state
        });

        return result;

    } catch (err) {
        console.error('[OpenAI] Error in comprehensive transcript processing:', err);
        return {
            summary: '',
            tour_booking_detected: false,
            tour_booking_date: null,
            tour_booking_extracted: null,
            comprehensive_result: null
        };
    }
}

module.exports = {
    generateTranscriptSummary: extractSummaryFromComprehensive, // Legacy compatibility
    extractTourBooking: extractTourBookingFromComprehensive, // Legacy compatibility
    processTranscript,
    processTranscriptComprehensive,
    formatTranscript
};

