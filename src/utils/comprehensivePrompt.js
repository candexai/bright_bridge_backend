/**
 * Comprehensive prompt for extracting all information from phone call transcripts
 * This replaces multiple separate prompts with a single, unified approach
 */

/**
 * Get the comprehensive prompt for extracting all call information
 * @param {string} transcriptText - The transcript text to analyze
 * @returns {string} - The complete prompt
 */
function getComprehensivePrompt(transcriptText) {
    return `You are processing a phone call transcript between a school enrollment AI agent (Nora) at Kids R Kids on Franz Road and a caller (usually a parent or guardian).

Your job is to extract ALL information in a single pass and return ONE structured JSON object.

Always respond in English, even if the conversation was in Spanish.

Do NOT invent, assume, or hallucinate any details not explicitly stated in the transcript.

Determine the call state:

- "complete": All 5 required fields collected (caller name, phone, email, child name, child age) AND call ended normally
- "partial": Some fields collected but call ended early, parent hung up, or booking was not completed
- "no_interaction": Caller said nothing meaningful (only greetings, silence, background noise, or misdial). NEVER use this when the caller identified as a current enrolled family member — even if the call was brief or ended after a front-desk transfer.

CURRENT ENROLLED FAMILY TRANSFERS:

- If the caller says they are a current family, existing family, already enrolled, or "familia actual", and Nora connects or transfers them to the front desk, this IS meaningful interaction.
- call_state: use "partial" (not "no_interaction").
- tags: MUST include "Current Family" ONLY when the caller explicitly said they are a current/existing family or already enrolled in the transcript. NEVER tag Current Family because Nora asked the opening routing question or because the summary assumes it.
- summary: state clearly that the caller identified as a current enrolled family member and that the call was transferred (or Nora offered to connect them) to the front desk. If the caller asked any other questions before or during the call, include those in the summary and in questions_asked.
- NEVER write "No meaningful interaction" for these calls.

Required fields to extract (set to null if not mentioned):

1. parent_name

2. parent_phone

3. parent_email

- Set to null if the parent never provided a confirmed email, OR if the parent rejected Nora's email read-back and Nora skipped email (look for agent saying "tour details by phone" or moving on to name/phone confirmation after email failure).
- Do NOT keep a rejected/unconfirmed email address in parent_email. Spoken forms like "name at gmail dot com" are NOT valid — use null unless the parent confirmed a real address (name@domain.com).

4. child_name (array - supports siblings, e.g. ["Sid", "Maya"])

5. child_age (array - parallel to child_name, e.g. ["3 years old", "5 years old"])

Tour booking:

- tour_booked: true/false
- tour_date: "YYYY-MM-DD" or null
- tour_time: "HH:MM" or null
- tour_datetime_iso: ISO 8601 or null

Parent questions and interests (ONLY school/KB topics the parent explicitly asked about):

- questions_asked: array of short plain-English strings of actual questions the parent raised about the school (programs, policies, tuition, hours, meals, ratios, etc.)
- topics_of_interest: array of short plain-English strings of school-related topics/concerns the parent showed interest in

(e.g. "school hours", "meal/food provided", "teacher-to-student ratio", "after-school care", "cameras/security", "pickup service", "nap time", "tuition")

DO NOT include tour booking logistics in questions_asked or topics_of_interest (e.g. "booked a tour", "scheduled for Tuesday", "wants to enroll soon"). If the parent only booked a tour and did not ask about school topics, leave both arrays empty.

- enrollment_urgency: "immediate" | "within weeks" | "specific month" | "unknown" - based on what parent said
- enrollment_target_date: string or null (e.g. "June", "as soon as possible", "next month")
- language_spoken: "English" | "Spanish" | "Both"

Tags and lead classification:

MANDATORY: You MUST apply tags based on these specific rules. NEVER leave tags empty.

CALL DROP-OFF REASONS - MANDATORY tags when call doesn't result in tour booking:

- "Parent hung up" - MANDATORY if parent ended the call abruptly or mid-conversation
- "Call dropped" - MANDATORY if technical issue caused call disconnection
- "Nora couldn't answer" - MANDATORY if parent asked a question Nora couldn't handle or needed human assistance
- "Parent requested callback" - MANDATORY if parent specifically asked for human callback, not AI
- "No child info captured" - MANDATORY if: child_name is null/empty OR child_age is null/empty in the extracted data. CRITICAL NEGATIVE RULE: NEVER apply "No child info captured" if child_name AND child_age are both present and not empty.
- "Price concern" - MANDATORY if parent asks about pricing/tuition and seems hesitant or doesn't proceed with booking
- "Not ready yet" - MANDATORY if parent says they're not ready to enroll yet, still deciding, or exploring options
- "Wrong school" - MANDATORY if parent realizes it's the wrong location/school or asks about a different Kids R Kids location

FAIL-SAFE RULES - Apply these ALWAYS, no exceptions:

- "Partial call" - MANDATORY if: call is incomplete OR brief (< 1 minute) OR missing critical information OR summary mentions "brief" or "incomplete" OR "no meaningful interaction" OR "caller did not engage" OR "primarily greetings" OR missing_details includes any field

CONDITIONAL RULES - MANDATORY when conditions are met (apply ALL tags whose conditions are satisfied):

- "Hot lead" - MANDATORY for a prospective/new family when ANY of these is true: (a) the parent explicitly asked about school/KB topics (tuition, hours, programs, meals, teacher ratio, curriculum, etc.), OR (b) the parent booked or requested a tour, OR (c) the parent expressed concrete enrollment intent — an enrollment_urgency of "immediate", "within weeks", or "specific month", or a specific enrollment_target_date (e.g. "August 17th", "next month", "as soon as possible"). Apply this even if the call ended before all contact details were collected. Do NOT apply when the caller only gave their name with no intent, hung up immediately, had no meaningful interaction, or is a non-parent (teacher, vendor, employment, wrong number).
- "Urgency: Immediate" - MANDATORY if parent needs enrollment ASAP (e.g., "starting next week", "as soon as possible", "immediate")
- "Urgency: High" - MANDATORY if parent needs enrollment soon (within 1-2 months)
- "Urgency: Medium" - MANDATORY if parent is planning ahead (3-6 months)
- "Urgency: Low" - MANDATORY if parent is just exploring (6+ months out)
- "Price sensitive" - MANDATORY if parent asks about tuition, fees, or financial aid
- "Tour requested" - MANDATORY if parent: explicitly asks for a tour OR expresses interest in booking a tour OR mentions wanting to visit the school OR discusses scheduling a tour OR agent offers to schedule a tour and parent engages with the offer
- "Tour booked - email missing" - MANDATORY if tour_booked is true AND (parent_email is null/empty OR transcript shows Nora skipped email after a failed confirmation OR agent says "we will make sure you have your tour details by phone" / "tour details by phone" / similar)
- "Unknown" - MANDATORY if caller gave no enrollment details, asked no school-related questions, did not request a tour, and was not transferred as a current family. Use call_state "no_interaction" or when summary indicates no meaningful engagement.
- "Follow-up needed" - MANDATORY if parent requests callback or additional information
- "First-time parent" - MANDATORY if parent appears to be new to childcare enrollment or asks basic questions
- "Multiple children" - MANDATORY if parent mentioned having more than one child
- "Special needs" - MANDATORY if parent mentioned special requirements or accommodations

- missing_details: ONLY include fields that are actually missing. Do NOT include "child name" or "child age" in missing_details if child_name and child_age were successfully extracted from the transcript. Only include these if they are truly null/empty in the extracted data.

Generate three outputs from this data:

1. summary (string, 3-5 sentences, past tense, professional English):

- Complete call: what parent wanted, details collected, what was booked or offered

- Partial call: what was collected, note that the call ended before completion

- No interaction: state clearly "No meaningful interaction. The call was interrupted or the caller did not engage." (Never use this for current-family transfer calls.)

- Current family transfer: e.g. "The caller identified as a current enrolled family member. The call was transferred to the front desk." Include any additional questions they asked.

2. email (object):

{

"subject": string,

"body": string

}

- Subject format:

- Complete + tour booked: "New Tour Scheduled - [Parent Name] | [Child Name], Age [X] | [Date] at [Time]"

- Complete + no tour: "Attention Needed - [Parent Name] | Tour Not Booked"

- Partial: "Incomplete Call - [Parent Name or 'Unknown Caller']"

- No interaction: "No Interaction - Call Interrupted"

- Body tone: short, director-friendly, scannable. Use short paragraphs or minimal bullets.

- Always include: call state, what was collected, what parent asked/cares about, tour info or attention flag

- End with: "- Nora, Kids R Kids Virtual Assistant"

3. one_pager (object):

{

"header": {

"parent_name": string or "Not provided",

"phone": string or "Not provided",

"email": string or "Not provided",

"children": [{ "name": string, "age": string }]  // supports siblings

},

"tour_info": {

"scheduled": boolean,

"date_display": string or "Not scheduled",  // e.g. "Tuesday, April 8 at 9:30 AM"

"attention_flag": string or null  // e.g. "Tour not booked - follow-up needed"

},

"what_they_asked_about": [string],  // ONLY school/KB questions (tuition, hours, programs, etc.) — NEVER tour booking, scheduling, or enrollment timing (those go in enrollment target / summary)

"tour_talking_points": [string]     // Staff tips tied to school/KB questions only — empty if parent only booked a tour

}

Return ONLY a valid JSON object with this exact top-level structure:

{

"call_state": "complete" | "partial" | "no_interaction",

"parent_name": string or null,

"parent_phone": string or null,

"parent_email": string or null,

"child_name": [string] or null,

"child_age": [string] or null,

"tour_booked": boolean,

"tour_date": string or null,

"tour_time": string or null,

"tour_datetime_iso": string or null,

"questions_asked": [string],

"topics_of_interest": [string],

"enrollment_urgency": string,

"enrollment_target_date": string or null,

"language_spoken": string,

"tags": [string],

"missing_details": [string],

"summary": string,

"email": { "subject": string, "body": string },

"one_pager": {

"header": {

"parent_name": string,

"phone": string,

"email": string,

"children": [{ "name": string, "age": string }]

},

"tour_info": {

"scheduled": boolean,

"date_display": string,

"attention_flag": string or null

},

"what_they_asked_about": [string],  // ONLY school/KB questions — NEVER tour booking or enrollment timing

"tour_talking_points": [string]     // Staff tips for school/KB questions only — empty if only booked a tour

}

}

Transcript:
${transcriptText}`;
}

module.exports = {
    getComprehensivePrompt
};
