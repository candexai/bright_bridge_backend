const axios = require('axios');
const FormData = require('form-data');
const AlertService = require('../services/alertService');

function reportElevenLabsAlert(err, context = {}) {
    const status = err?.response?.status;
    const detail = err?.response?.data?.detail || err?.response?.data?.message || err?.message || 'Unknown error';
    let severity = 'WARNING';
    let type = 'ELEVENLABS_ERROR';

    if (status === 401 || status === 403) {
        severity = 'CRITICAL';
    } else if (status === 429) {
        severity = 'CRITICAL';
        type = 'RATE_LIMIT_ERROR';
    } else if (err?.code === 'ECONNABORTED' || /timeout/i.test(String(detail))) {
        severity = 'WARNING';
    } else if (status >= 500) {
        severity = 'CRITICAL';
    }

    AlertService.create({
        type,
        severity,
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        title: context.title || 'ElevenLabs API failure',
        message: typeof detail === 'object' ? JSON.stringify(detail) : String(detail),
        source: context.source || 'elevenlabs',
        metadata: {
            status,
            stack: err?.stack,
            ...context.metadata,
        },
    });
}

const APPOINTMENT_AGENT_PROMPT = ``;

const GLOBAL_TIME_TOOL_ID = "tool_1801kmyr9pdpemts5qr0f1xys3yy";

/**
 * ElevenLabs built_in_tools.transfer_to_number `condition` — gates when the
 * transfer tool may fire. Synced via patchAgentHumanTransfer when Human Transfer is enabled.
 */
const HUMAN_TRANSFER_TOOL_CONDITION = `TRANSFER RULES — STRICT INTENT ONLY

Transfers are ONLY permitted at the start of a call or before a tour time has been confirmed. Once the caller has confirmed a tour time, transfers are FORBIDDEN — finish the booking on the call (steps 10-13: final questions, confirm name/phone/email, verbal "You're all set…", then close). There is no book_appointment tool and no in-call calendar tool.

WHEN TO TRANSFER

Transfer ONLY when the caller clearly and explicitly does ONE of the following:

A) Identifies as a CURRENT / EXISTING enrolled family
Must be direct self-identification, not a passing mention.
Accepted: "Current family" / "I'm a current family" / "I'm an existing parent" / "My child is already enrolled or attends here" / "We already go there" / Spanish: "Familia actual", "Soy una familia actual", "Mi hijo ya asiste"

B) Explicitly requests a human / front desk / office
Must be a direct request, not a reference.
Accepted: "Transfer me" / "Connect me to the office" / "Can I speak with the front desk, a representative, or someone?" / "I need a staff member, operator, or reception" / Spanish: "Quiero hablar con recepción", "Pásame con alguien", "Necesito hablar con la oficina"

WHEN NOT TO TRANSFER

Never transfer in these cases:

- Tour date AND time have been confirmed (booking flow lock — step 9 onward)
- Caller is a prospective parent booking a tour or asking about enrollment
- Caller said no to "Any quick questions before I lock it in?" — continue with name/phone/email confirm and verbal tour confirmation, not transfer
- After name/phone/email confirmation — give verbal "You're all set for [day] at [time]", not transfer
- To finish, finalize, lock in, or complete a tour booking
- Isolated keywords ("front desk", "current", "family") without clear intent
- Contextual mentions: talked to front desk yesterday, friend is current family, "currently looking" for childcare, visited before, spoke with someone before
- Questions answerable from the knowledge base
- Tool failed or you are unsure — use TECHNICAL FALLBACK (callback offer), not transfer

CONFIDENCE THRESHOLD

Transfer only when confidence is >=95% that intent matches A or B.
If below 95%, ask exactly ONE clarification:
"Just to confirm — are you a current enrolled family, or are you calling for enrollment information?"
OR: "Would you like me to connect you with the front desk?"
Transfer only after affirmative: Yes, Correct, That's right, Please do, Connect me, Si, Correcto.

CRITICAL: BOOKING FLOW LOCK

Once the caller has confirmed a tour time (step 9 onward), NO transfers under any circumstances. Only permitted actions:

- Step 10: Final question check (once)
- Step 12: Confirm name, phone, email only
- Step 13: Verbal confirmation — "You're all set for [day] at [time]. We'll send details to your email."
- Step 14: Close

Never transfer to finish a tour. Never say you will connect the caller to the front desk or a team member to complete the booking. Nora completes the conversation on the call; the system records the booking after the call ends.`;

/** Uses school condition when set; otherwise the default HUMAN_TRANSFER_TOOL_CONDITION. */
function buildHumanTransferToolCondition(schoolCondition = '') {
    const custom = String(schoolCondition || '').trim();
    return custom || HUMAN_TRANSFER_TOOL_CONDITION;
}

const NORA_SYSTEM_PROMPT_TEMPLATE = `You are Nora, a warm and friendly virtual scheduling assistant for a school
tour booking system. Your job is to collect parent information and book a
school tour as smoothly and naturally as possible.

VOICE CONSISTENCY

Speak in a calm, steady, and natural tone throughout the entire call.
Avoid sudden changes in pitch, speed, or emphasis.
Do not sound overly excited, robotic, or overly formal.
Maintain the same warm, conversational tone from start to finish.

BILINGUAL OPENING

Greet every caller in both English and Spanish:

Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant.
You can speak in English or Spanish — si prefiere, puede hablar en español, Le puedo ayudar en algo. How can I help you today?"

LANGUAGE HANDLING

If the caller speaks Spanish, continue the entire conversation in Spanish.
If the caller speaks English, continue in English.
Do not ask which language they prefer — detect and adapt naturally.
Do not switch languages unless the caller does.

CONVERSATION PRIORITY

Always prioritize a smooth, natural conversation.
Do not let tool rules interrupt conversational flow.
Only use tools when required for scheduling.
Do not mention tools, delays, or system activity to the caller.

---

AVAILABLE TOOLS

1. get_current_datetime_cst

- Call once at the start of the first user interaction, before
scheduling any appointments.
- Store the result for the entire session. Never call again.
- Use the returned date and day_of_week as the anchor for all
date calculations.

2. get_booked_slots

- Call once per date, only after the user has verbally confirmed
the exact date you state out loud (day name + full date).
- Required parameter: date in YYYY-MM-DD format.
- Never call for a date the user has not confirmed.
- Never re-call for a date already fetched, unless the user
explicitly requests a different date.
- Only fetch slots for weekdays (Monday–Friday). If a date falls
on Saturday or Sunday, do not fetch — instead say: "We only
offer tours Monday through Friday. The next available weekday
is [date]. Does that work for you?"
- If the tool fails, retry once. If it fails again, say:
"I'm having a little trouble on my end — give me just a moment."
Then stop retrying.

3. transfer_to_number (human transfer — built-in, rare)

- Use ONLY for current enrolled families or explicit human requests
BEFORE any tour time is confirmed. See HUMAN TRANSFER section.
- NEVER use to complete, finalize, or "lock in" a tour booking.
- After tour time is confirmed (step 9+), this tool is FORBIDDEN.

TOOL DISCIPLINE

- Every tool runs at most once per logical step.
- Never re-call get_current_datetime_cst after the session opening.
- Never call get_booked_slots without prior verbal date confirmation.
- Never call get_booked_slots for a date already fetched.
- Never call get_booked_slots on a Saturday or Sunday.
- Once a time is confirmed and final question check is done,
complete steps 12–13 verbally — never transfer_to_number.
- Retry any failed tool exactly once, then stop and inform the caller
gracefully.
- Never call transfer_to_number after step 9 under any circumstance.
- There is NO in-call tool to create the calendar event. Do not invent one.

---

EXECUTION ORDER (each step runs exactly once)

1. On first user message — call get_current_datetime_cst silently.
2. Greet with the bilingual opening.
3. If caller asks questions, answer first using knowledge base.
4. Collect required details one at a time (see below).
5. Acknowledge enrollment timeline. Pivot to scheduling earliest tour.
6. Calculate the earliest available weekday. State day name + full
date. Ask the user to confirm.
7. After confirmation — call get_booked_slots (weekdays only).
8. Identify the single earliest available slot from the response.
9. Suggest ONLY that one slot to the user. Get verbal confirmation.
   BOOKING FLOW LOCK: From this step onward, transfer_to_number is
   FORBIDDEN. Complete the booking conversation yourself (steps 10–14).
10. Final question check (say this exactly once, never repeat):
"I'll get that reserved for you. Any quick questions before
I lock it in?"
11. If the user has questions — answer them briefly, then proceed.
If the user says no — proceed immediately.
12. Quick confirmation of name, email, and phone only.
13. Verbal tour confirmation (see CONFIRM TOUR) — no transfer, no
extra tools. The calendar booking is created automatically after the call.
14. Close the call.
15. If you cannot complete the conversation — use TECHNICAL FALLBACK
(callback offer only — do not use transfer_to_number).

---

HUMAN TRANSFER (transfer_to_number)

Transfers are ONLY permitted before a tour time is confirmed, or at
the very start of the call before the booking flow begins.

WHEN TO TRANSFER (≥95% confidence, intent A or B only):

A) Caller identifies as a CURRENT / EXISTING enrolled family
(self-identification, not a passing mention).

B) Caller explicitly requests a human, front desk, office, or staff.

If below 95% confidence, ask exactly ONE clarification:
"Just to confirm — are you a current enrolled family, or are you
calling for enrollment information?"
OR: "Would you like me to connect you with the front desk?"
Transfer only after affirmative: Yes, Correct, Please do, Connect me,
Sí, Correcto.

WHEN NOT TO TRANSFER:

- After tour time is confirmed (step 9 onward) — LOCKED to booking path.
- Prospective parents booking tours or asking enrollment questions.
- Isolated keywords without clear intent.
- Tool failures or uncertainty — use TECHNICAL FALLBACK, not transfer.
- Never transfer to "finish" or "lock in" a tour — you complete it
verbally on the call (steps 12–13).

FORBIDDEN PHRASES (never say these during booking completion):

- "I will connect you to a team member / front desk / office"
- "Please stay on the line while I transfer you"
- "Someone will finalize your tour"
- "Let me transfer you to finish booking"

After step 10, if the caller has no more questions, your ONLY next
actions are: pre-booking confirmation (step 12) → verbal tour
confirmation (step 13) → close. Do not offer or perform a transfer.

---

TOUR BOOKING (no in-call booking tool)

This agent does NOT have a tool to create calendar events during the call.
The only scheduling tools are get_current_datetime_cst and get_booked_slots.
After you collect and confirm all details on the call, the backend creates
the tour from the transcript when the call ends.

On the call you MUST still:
- Collect parent name, phone, email, child name, child age, date, time.
- Confirm date before get_booked_slots.
- Confirm time before the final question check.
- Confirm name, phone, email before the verbal confirmation.

Never wait for a booking tool result. Never say you are transferring
someone to complete the booking.

---

FIRST RESPONSE HANDLING

If the caller asks a question:
- Answer it clearly using the knowledge base.
- Keep it natural and helpful.

If the caller asks multiple questions:
"Great questions, I can definitely help with all of that."
"This will just take a minute. Let me grab a couple quick details
first in case we get disconnected, and then I'll answer your
questions and help get your tour scheduled."
Then begin collecting information.

If the caller is looking for childcare:
"I can help with that. I'll grab a few quick details and then
we'll get your tour set."

---

COLLECT INFORMATION

Ask one question at a time.

If the caller has already provided any detail earlier in the
conversation, do not ask for it again. Skip to the next question.

"May I have your name?"

After receiving the parent's name, always greet them:
"Nice to meet you, [Parent Name]. What's the best phone number
for you?"

This greeting must always be included. Never skip it.

"And could you please spell your email for me?"

EMAIL CAPTURE

After parent spells email, read it back slowly, one character
at a time:

Say: "Let me make sure I have that right…"

Spell each character individually with a pause between each.
Do not spell common domains character by character like
@gmail.com, @yahoo.com, etc.

Example: "A. M. A. R. C. eight. three. nine. nine. @gmail.com"

Then ask:

"Did I get that correct?"

Wait for confirmation before proceeding.
Do not move on until the email is confirmed.
Never skip this step.

If the caller corrects you, update only the specific characters
they corrected — do not re-read the entire email from scratch.
Then re-confirm the corrected version once more.

Continue:

"What is your child's name?"

Accept whatever name the caller gives. Do not ask for a full name
or last name. If they give a first name only, use that.

"How old is [Child Name]?"

Optional:

"That's a great age, we have a wonderful program for that group."

"When are you hoping to enroll [Child Name]?"

REASSURANCE

"Great, that lines up well with our current availability."

---

MOVE TO TOUR

"The best next step is a quick tour so you can see the classrooms
and meet the team."

"Our earliest opening is [earliest available time]. Would that
work for you?"

If hesitation:

"I also have [option 2] or [option 3]. Do you prefer morning
or afternoon?"

---

QUESTION HANDLING

If the parent asks a question:
- Answer clearly using the knowledge base.
- Keep response concise — 1 to 2 sentences, max 3.
- Do not expand beyond what was asked.
- Do not introduce new topics.

After answering:

"I'll go ahead and lock in your tour for [time]."

(This means you will finish steps 12–13 on the call — not transfer.)

If the parent says they have more questions:

"Of course, I'll make sure we cover everything."
"Let me just finish getting your details, and then I'll go
through your questions with you."

If the parent continues asking multiple detailed questions
or resists booking:

"Our team can walk you through everything in more detail
during a tour."
"If you'd prefer, I can have someone from our team give you
a quick call to go over your questions as well."

Only offer callback if needed.

---

FINAL QUESTION CHECK

After they agree to a time, say this exactly once:

"I'll get that reserved for you. Any quick questions before
I lock it in?"

Do NOT say this line more than once. If you have already said it,
do not repeat it. Move forward.

---

PRE-BOOKING CONFIRMATION

Before the verbal tour confirmation, confirm only these three details:

"Just to confirm — I have your name as [Parent Name], phone as
[phone], and email as [email]. Is that correct?"

Do NOT read back the child's name, child's age, enrollment
timeline, date, or time in this confirmation.
Do NOT list all collected details.
Only name, phone, and email.

Once the user confirms, proceed immediately to CONFIRM TOUR.
Do not say you are connecting or transferring anyone.
Do not call transfer_to_number.

---

CONFIRM TOUR

After the user confirms name, phone, and email, give the verbal
confirmation right away. State the agreed day and time clearly.

"You're all set for [day] at [time]."
"We'll send your tour details to your email."
"Our team is excited to meet you and [Child Name]."

Do not wait for a tool. Do not transfer. The system records the
booking after the call ends.

---

CLOSE

"We'll see you soon."

---

DATE CALCULATION RULES

Always use the date returned by get_current_datetime_cst as today.
TODAY: Use the exact date from the tool.
TOMORROW: today + 1 day.
NEXT [WEEKDAY]: The first occurrence of that weekday in the calendar
week after the current one (Mon–Sun block).
- Current week = the Mon–Sun block that contains today.
- "Next week" starts on the Monday after this Sunday.
- Example: Today = Saturday Mar 21 → next week = Mar 23–29 →
"next Monday" = Mar 23, "next Thursday" = Mar 26.
NEXT TO NEXT [WEEKDAY] / WEEK AFTER NEXT: Two calendar weeks ahead.
- Example: Today = Saturday Mar 21 → week after next = Mar 30–Apr 5
→ "next to next Thursday" = Apr 2.
NEXT WEEK (no day specified): Ask "Which day next week works for you?"
Do not assume a day or fetch slots.
EARLIEST AVAILABLE: Calculate the next upcoming weekday (Mon–Fri)
starting from tomorrow. State it and confirm before fetching slots.
Rules:
- Never pick a past date.
- Never pick a Saturday or Sunday.
- Always verify the day name matches the date before stating it.
- Always say both the day name and full date out loud
(e.g., "Monday, March twenty-third").
- Always ask the user to confirm the date before calling
get_booked_slots.
- If the user disputes your date, politely verify:
"Let me double-check — today is [day, date], so that would put
[their day] on [your calculation]. I want to make sure we get
the right date — shall I check [your date] or [their date]?"
Then fetch whichever the user confirms.

---

SLOT PRESENTATION — EARLIEST ONLY

After calling get_booked_slots, identify the SINGLE earliest
available slot from the availableSlots array.

Present ONLY that one slot:

"The earliest I have on [day] is [time]. Does that work for you?"

Do NOT list multiple available times.
Do NOT say "We have openings from X to Y."
Do NOT mention which slots are booked or taken.

If the user accepts — proceed to final question check (step 10).
Complete steps 10–13 before ending the call.

If the user declines — ask: "What time works better for you?"

Then check if their requested time exists in availableSlots.

If available — confirm the time and continue to step 10.

If NOT available — find the next earliest slot AFTER their
requested time and suggest only that one:

"That one is not available. The next opening is [time].
Does that work?"

Never list all slots. Always suggest one at a time.

---

GENERAL BEHAVIOR

- Ask one question at a time. Never stack questions.
- Keep all responses short, warm, and natural.
- Never mention tool names, system activity, or internal processes.
- Never offer or perform a human transfer after tour time is confirmed.
- Completing a booking on the call means verbal confirmation (steps 12–13), never transfer.
- Never say "I am still under development" or anything that
undermines caller trust.
- Never confirm a tour before the caller has confirmed the time and
their name, phone, and email.
- Never claim a calendar event exists until you have stated the verbal confirmation.
- Never hallucinate dates, times, or slot availability.
- If the user complains about an error, acknowledge briefly and
move forward. Do not over-apologize or make excuses.
- Remember everything already collected — never ask for it again.
- Never repeat a line or phrase you have already said in the
conversation. If you have already said something, move forward.
- If a caller goes silent, gently check in once:
"Are you still there? Take your time."

---

TECHNICAL FALLBACK

If unable to schedule:

"I'm having a little trouble locking that in right now, but I
can have someone from our team call you shortly to confirm
everything."

This is a callback promise only — do NOT use transfer_to_number.
Confirm contact details.

Close politely.
`;

const DEFAULT_FIRST_MESSAGE_TEMPLATE = `Hi, thanks for calling {{SCHOOL_NAME}}, this is Nora, a virtual assistant. If you are a current enrolled family, just say "current family" and I will connect you. Si es una familia actual inscrita, diga "familia actual" y le conecto. For a tour or enrollment, tell me how I can help. You can speak in English or Spanish. How can I help you today?`;

async function createSchoolAgent(schoolName, knowledgeBaseId = null, toolIds = []) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Create] ELEVENLABS_API_URL not configured, skipping agent creation');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/agents`;
        const personaPrompt = NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName);
        const fullPrompt = `${personaPrompt}\n\n${APPOINTMENT_AGENT_PROMPT}`;

        const payload = {
            name: schoolName,
            first_message: DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, schoolName),
            language: "en",
            model: "gpt-5.1",
            speed: 0.95,
            system_prompt: fullPrompt,
            knowledge_base_ids: knowledgeBaseId ? [knowledgeBaseId] : [],
            voice_id: "jqcCZkN6Knx8BJ5TBdYR",// Default voice
            post_call_webhook_url: "https://montessori-enrollment-ai-backend.onrender.com/api/v1/webhook/elevenlabs",
        };

        // Only set tool_ids at create when explicitly provided. Registration uses
        // register-tool (attaches tools) then linkAgentToolIds to avoid tools + tool_ids conflict.
        if (Array.isArray(toolIds) && toolIds.length > 0) {
            payload.tool_ids = [...new Set([...toolIds, GLOBAL_TIME_TOOL_ID])];
        }

        console.log(`[Agent Create] POST ${url}`);
        console.log(`[Agent Create] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                // Assuming we might need an API key for the wrapper in the future if set
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Create] Status: ${response.status}`);
        console.log(`[Agent Create] Data:`, JSON.stringify(response.data, null, 2));

        return response.data?.agent_id || null;
    } catch (err) {
        console.error(`[Agent Create] Failed to create agent for ${schoolName}`);
        console.error(`[Agent Create] Error Status:`, err.response?.status);
        console.error(`[Agent Create] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        console.error(`[Agent Create] Error Message:`, err.message);
        AlertService.create({
            type: 'AGENT_ERROR',
            severity: 'CRITICAL',
            schoolName,
            title: `Agent creation failed: ${schoolName}`,
            message: err.message || 'createSchoolAgent failed',
            source: 'elevenlabs.createSchoolAgent',
            metadata: { stack: err.stack, status: err.response?.status },
        });
        return null;
    }
}

async function importSipTrunk(payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/sip-trunk`;
        console.log(`[Agent SIP] POST ${url}`);

        // Construct the correct ElevenLabs SIP payload
        const sipPayload = {
            phone_number: payload.phone_number,
            label: payload.label || 'Imported SIP Number',
            provider: 'sip_trunk',
            supports_inbound: true,
            inbound_trunk_config: {
                address: payload.sip_address || 'sip.rtc.elevenlabs.io:5060'
            }
        };

        console.log(`[Agent SIP] Payload:`, JSON.stringify(sipPayload, null, 2));

        const response = await axios.post(url, sipPayload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP] Status: ${response.status}`);
        return { phone_number_id: response.data?.phone_number_id || null };
    } catch (err) {
        if (err.response?.status === 409) {
            console.warn(`[Agent SIP] Phone number already exists in ElevenLabs`);
            return { alreadyExists: true };
        }
        console.error(`[Agent SIP] Failed to import SIP trunk`);
        console.error(`[Agent SIP] Error Status:`, err.response?.status);
        console.error(`[Agent SIP] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function updatePhoneNumber(phoneNumberId, payload) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Phone Update] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent Phone Update] PATCH ${url}`);
        console.log(`[Agent Phone Update] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.patch(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Phone Update] Status: ${response.status}`);
        console.log(`[Agent Phone Update] Response Data:`, JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (err) {
        console.error(`[Agent Phone Update] Failed to update phone number`);
        console.error(`[Agent Phone Update] Error Status:`, err.response?.status);
        console.error(`[Agent Phone Update] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function deletePhoneNumber(phoneNumberId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent SIP Delete] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/phone-numbers/${phoneNumberId}`;
        console.log(`[Agent SIP Delete] DELETE ${url}`);

        const response = await axios.delete(url, {
            headers: {
                'accept': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent SIP Delete] Status: ${response.status}`);
        return response.data; // { success: true, message: "..." }
    } catch (err) {
        console.error(`[Agent SIP Delete] Failed to delete phone number`);
        console.error(`[Agent SIP Delete] Error Status:`, err.response?.status);
        console.error(`[Agent SIP Delete] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw new Error(err.response?.data?.detail?.[0]?.msg || err.message);
    }
}

async function registerTool(schoolId, agentId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[Agent Tool Register] ELEVENLABS_API_URL not configured');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/register-tool`;
        const payload = { school_id: schoolId, agent_id: agentId };
        console.log(`[Agent Tool Register] POST ${url}`);
        console.log(`[Agent Tool Register] Payload:`, JSON.stringify(payload, null, 2));

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[Agent Tool Register] Status: ${response.status}`);
        console.log(`[Agent Tool Register] Response:`, JSON.stringify(response.data, null, 2));
        return response.data?.tool_id || null; // Return ONLY the ID string
    } catch (err) {
        console.error(`[Agent Tool Register] Failed to register tool for school ${schoolId}`);
        console.error(`[Agent Tool Register] Error Status:`, err.response?.status);
        console.error(`[Agent Tool Register] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return null;
    }
}

// Helper function to format Q&A pairs into text for knowledge base ingestion
function formatQAPairsForKB(qaPairs) {
    if (!Array.isArray(qaPairs) || qaPairs.length === 0) {
        return '';
    }

    return qaPairs
        .filter(pair => pair.question && pair.answer)
        .map((pair, index) => {
            return `Q${index + 1}: ${pair.question}\nA${index + 1}: ${pair.answer}`;
        })
        .join('\n\n');
}

// Helper function to ingest a knowledge base document to ElevenLabs
async function ingestKnowledgeBaseDocument(text, schoolName) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl) {
        console.warn('[KB] ELEVENLABS_API_URL not configured, skipping KB ingestion');
        return null;
    }

    try {
        const url = `${baseUrl}/api/v1/knowledge-base/ingest`;

        // Generate document name on backend
        const documentName = `${schoolName} - Knowledge Base`;

        // Create FormData
        const formData = new FormData();
        formData.append('source_type', 'text');
        formData.append('text', text);
        formData.append('name', documentName);

        console.log(`[KB POST] Request URL: ${url}`);
        const response = await axios.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
                ...(process.env.ELEVENLABS_API_KEY && { 'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}` })
            }
        });

        console.log(`[KB POST] Response Status: ${response.status}`);
        const documentId = response.data?.document_id || response.data?.id;
        console.log(`[KB] Successfully ingested document: ${documentId}`);
        return documentId;
    } catch (err) {
        console.error(`[KB POST] Failed to ingest document`);
        console.error(`[KB POST] Error Status:`, err.response?.status);
        console.error(`[KB POST] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        throw err;
    }
}

function normalizeToolIds(toolIds) {
    const ids = Array.isArray(toolIds)
        ? toolIds.filter(Boolean).map((id) => String(id).trim()).filter(Boolean)
        : [];
    return [...new Set([...ids, GLOBAL_TIME_TOOL_ID])];
}

function isToolsToolIdsConflict(err) {
    const detail = JSON.stringify(err?.response?.data || {});
    return err?.response?.status === 400 && /both tools and tool IDs/i.test(detail);
}

function elevenLabsHeaders() {
    return {
        'Content-Type': 'application/json',
        ...(process.env.ELEVENLABS_API_KEY && { Authorization: `Bearer ${process.env.ELEVENLABS_API_KEY}` }),
    };
}

function resolveAgentBranchId(snapshot) {
    if (!snapshot) return null;
    return snapshot.branch_id || snapshot.main_branch_id || null;
}

function agentsUrlFor(baseUrl, agentId, branchId = null) {
    let url = `${baseUrl}/api/v1/agents/${agentId}`;
    if (branchId) {
        url += `?branch_id=${encodeURIComponent(branchId)}`;
    }
    return url;
}

function promptUrlFor(baseUrl, agentId, branchId = null) {
    return `${agentsUrlFor(baseUrl, agentId, branchId)}/prompt`;
}

/** Read agent fields from nested conversation_config (ElevenLabs native) or flat wrapper shape. */
function extractConversationAgent(snapshot) {
    if (!snapshot) return {};
    const nested = snapshot.conversation_config?.agent;
    if (nested && typeof nested === 'object') {
        return nested;
    }
    return {
        first_message: snapshot.first_message,
        language: snapshot.language,
        prompt: {
            prompt: snapshot.system_prompt,
            tool_ids: snapshot.tool_ids,
        },
    };
}

function getAgentFirstMessage(snapshot) {
    const agent = extractConversationAgent(snapshot);
    return agent.first_message ?? snapshot?.first_message ?? '';
}

function getAgentPromptText(snapshot) {
    const agent = extractConversationAgent(snapshot);
    return agent.prompt?.prompt ?? snapshot?.system_prompt ?? '';
}

function normalizePromptForCompare(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
}

/** PATCH /agents/:id/prompt — tool_ids only (registration repair path). */
function buildPromptSubresourcePayload({ fullPrompt, knowledgeBaseId }) {
    const kbId = knowledgeBaseId && String(knowledgeBaseId).trim();
    return {
        system_prompt: fullPrompt,
        knowledge_base_ids: kbId ? [kbId] : [],
        language: 'en',
    };
}

/** PATCH /agents/:id — conversation_config.agent.prompt (ElevenLabs UI source of truth). */
function buildSystemPromptAgentsPayload(fullPrompt, knowledgeBaseId, existingAgent = {}) {
    const existingPrompt = existingAgent?.prompt || {};
    const prompt = {
        llm: existingPrompt.llm || 'gemini-2.5-flash',
        prompt: fullPrompt,
    };
    if (Array.isArray(existingPrompt.tool_ids) && existingPrompt.tool_ids.length > 0) {
        prompt.tool_ids = existingPrompt.tool_ids;
    }

    const kbId = knowledgeBaseId && String(knowledgeBaseId).trim();
    if (kbId) {
        const existingKb = Array.isArray(existingPrompt.knowledge_base)
            ? existingPrompt.knowledge_base.find((doc) => doc?.id === kbId)
            : null;
        // ElevenLabs requires type, id, and name on each knowledge_base entry.
        prompt.knowledge_base = [{
            type: existingKb?.type || 'file',
            id: kbId,
            name: existingKb?.name || 'School knowledge base',
            usage_mode: existingKb?.usage_mode || 'auto',
        }];
    }

    return {
        conversation_config: {
            agent: { prompt },
        },
    };
}

function buildFirstMessageAgentsPayload(firstMessage) {
    return {
        conversation_config: {
            agent: {
                first_message: firstMessage || '',
            },
        },
    };
}

function logElevenLabsExchange(label, { method, url, payload, response, error }) {
    const preview = (text, max = 400) => {
        const s = String(text || '');
        return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
    };
    console.log(`[ElevenLabs] ========== ${label} ==========`);
    console.log(`[ElevenLabs] ${method} ${url}`);
    if (payload) {
        const nestedPrompt = payload?.conversation_config?.agent?.prompt?.prompt;
        console.log('[ElevenLabs] Request payload:', JSON.stringify({
            ...payload,
            system_prompt: payload.system_prompt
                ? preview(payload.system_prompt, 500)
                : payload.system_prompt,
            conversation_config: payload.conversation_config
                ? {
                    ...payload.conversation_config,
                    agent: payload.conversation_config.agent
                        ? {
                            ...payload.conversation_config.agent,
                            prompt: payload.conversation_config.agent.prompt
                                ? {
                                    ...payload.conversation_config.agent.prompt,
                                    prompt: nestedPrompt
                                        ? preview(nestedPrompt, 500)
                                        : payload.conversation_config.agent.prompt.prompt,
                                }
                                : undefined,
                        }
                        : undefined,
                }
                : payload.conversation_config,
        }, null, 2));
    }
    if (response) {
        console.log(`[ElevenLabs] Response status: ${response.status}`);
        const data = response.data;
        console.log('[ElevenLabs] Response data:', JSON.stringify(data, null, 2));
    }
    if (error) {
        console.log(`[ElevenLabs] Error status: ${error?.response?.status}`);
        console.log('[ElevenLabs] Error data:', JSON.stringify(error?.response?.data || {}, null, 2));
        console.log('[ElevenLabs] Error message:', error.message);
    }
    console.log(`[ElevenLabs] ========== end ${label} ==========`);
}

async function fetchAgentSnapshot(agentId, label = 'GET agent', branchId = null) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) return null;
    const url = agentsUrlFor(baseUrl, agentId, branchId);
    try {
        const response = await axios.get(url, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'GET', url, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'GET', url, error: err });
        return null;
    }
}

/**
 * Set agent tools by ID only. register-tool attaches full tool objects first;
 * we normalize to tool_ids via /agents (preferred) then /prompt.
 */
async function linkAgentToolIds(agentId, toolIds, { branchId = null } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Link Tools] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const finalToolIds = normalizeToolIds(toolIds);
    const agentsUrl = agentsUrlFor(baseUrl, agentId, branchId);
    const promptUrl = `${agentsUrl}/prompt`;
    const agentsPayload = {
        conversation_config: {
            agent: {
                prompt: {
                    tool_ids: finalToolIds,
                    // Clear inline tools left by register-tool so /prompt updates do not 400.
                    tools: [],
                    built_in_tools: {
                        transfer_to_number: null,
                    },
                },
            },
        },
    };
    const promptPayload = { tool_ids: finalToolIds };

    console.log('[Agent Link Tools] agent:', agentId, 'tool_ids:', finalToolIds);

    // Prefer /agents — avoids conflicting with inline tools left by register-tool.
    try {
        const response = await axios.patch(agentsUrl, agentsPayload, { headers: elevenLabsHeaders() });
        console.log('[Agent Link Tools] /agents status:', response.status);
        return response.data;
    } catch (agentsErr) {
        if (!isToolsToolIdsConflict(agentsErr)) {
            console.warn('[Agent Link Tools] /agents failed:', agentsErr.response?.status, agentsErr.response?.data || agentsErr.message);
        }
    }

    try {
        const response = await axios.patch(promptUrl, promptPayload, { headers: elevenLabsHeaders() });
        console.log('[Agent Link Tools] /prompt status:', response.status);
        return response.data;
    } catch (promptErr) {
        console.error('[Agent Link Tools] Failed for agent', agentId);
        console.error('[Agent Link Tools] Error Status:', promptErr.response?.status);
        console.error('[Agent Link Tools] Error Data:', JSON.stringify(promptErr.response?.data || {}, null, 2));
        if (isToolsToolIdsConflict(promptErr)) {
            console.warn(
                '[Agent Link Tools] register-tool already attached tools on this agent; '
                + 'tool_ids could not be set. Voice agent may still work — fix agent in ElevenLabs or recreate the school.'
            );
        }
        return null;
    }
}

/**
 * PATCH /agents/:id — system prompt only (conversation_config.agent.prompt.prompt).
 */
async function patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId = '', {
    branchId = null,
    label = 'PATCH /agents system_prompt',
    existingAgent = null,
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch System Prompt] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    let agentConfig = existingAgent;
    if (!agentConfig) {
        const snapshot = await fetchAgentSnapshot(agentId, 'load agent for system_prompt', branchId);
        agentConfig = extractConversationAgent(snapshot);
    }

    const url = agentsUrlFor(baseUrl, agentId, branchId);
    const payload = buildSystemPromptAgentsPayload(fullPrompt, knowledgeBaseId, agentConfig);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        const detail = JSON.stringify(err?.response?.data || {});
        if (err?.response?.status === 400 && /field required/i.test(detail)) {
            console.warn('[Agent Patch System Prompt] nested PATCH failed — retry via /prompt');
            const fallback = buildPromptSubresourcePayload({ fullPrompt, knowledgeBaseId });
            return patchAgentPrompt(agentId, fallback, { branchId, label: `${label} (/prompt fallback)` });
        }
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * PATCH /agents/:id — first_message only (lives on conversation_config.agent, not /prompt).
 */
async function patchAgentFirstMessage(agentId, firstMessage, { branchId = null, label = 'PATCH /agents first_message' } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch First Message] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const url = agentsUrlFor(baseUrl, agentId, branchId);
    const payload = buildFirstMessageAgentsPayload(firstMessage);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * PATCH /agents/:id/prompt — system prompt + KB. Never send tool_ids or first_message here.
 */
async function patchAgentPrompt(agentId, payload, { branchId = null, label = 'PATCH /prompt' } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Patch Prompt] ELEVENLABS_API_URL or agentId not configured');
        return null;
    }

    const url = promptUrlFor(baseUrl, agentId, branchId);
    try {
        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        logElevenLabsExchange(label, { method: 'PATCH', url, payload, response });
        return response.data;
    } catch (err) {
        logElevenLabsExchange(`${label} (failed)`, { method: 'PATCH', url, payload, error: err });
        throw err;
    }
}

/**
 * Admin: system prompt via PATCH /agents (prompt.prompt); greeting via PATCH /agents (first_message).
 */
async function patchAgentPromptContent(agentId, {
    firstMessage = '',
    systemPrompt = '',
    knowledgeBaseId = '',
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        console.warn('[Agent Prompt Content] missing ELEVENLABS_API_URL or agentId');
        return null;
    }

    const baseSystem = String(systemPrompt || '').trim();
    const fullPrompt = baseSystem.includes('EXECUTION ORDER')
        ? baseSystem
        : `${baseSystem}\n\n${APPOINTMENT_AGENT_PROMPT}`;

    console.log('[Agent Prompt Content] agentId:', agentId);
    console.log('[Agent Prompt Content] PATCH /agents (prompt.prompt + first_message), no tools');

    const before = await fetchAgentSnapshot(agentId, 'BEFORE patch');
    const branchId = resolveAgentBranchId(before);
    const agentsUrl = agentsUrlFor(baseUrl, agentId, branchId);
    if (branchId) {
        console.log('[Agent Prompt Content] branch_id:', branchId);
    }

    const existingAgent = extractConversationAgent(before);
    const promptPatchResponse = await patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId, {
        branchId,
        label: 'admin system_prompt',
        existingAgent,
    });

    const firstMessagePatchResponse = await patchAgentFirstMessage(agentId, firstMessage, {
        branchId,
        label: 'admin first_message',
    });

    const after = await fetchAgentSnapshot(agentId, 'AFTER patch', branchId);
    const beforeMsg = getAgentFirstMessage(before);
    const afterMsg = getAgentFirstMessage(after);
    const beforePrompt = getAgentPromptText(before);
    const afterPrompt = getAgentPromptText(after);
    const expectedMsg = firstMessage || '';
    const verifyFirstMessageChanged = afterMsg !== beforeMsg;
    const verifyFirstMessageMatches = afterMsg.trim() === expectedMsg.trim();
    const verifyPromptChanged = normalizePromptForCompare(afterPrompt) !== normalizePromptForCompare(beforePrompt);
    const verifyPromptMatches = normalizePromptForCompare(afterPrompt) === normalizePromptForCompare(fullPrompt);
    const verifyChanged = verifyFirstMessageChanged || verifyPromptChanged;
    const verifyMatches = verifyFirstMessageMatches && verifyPromptMatches;

    console.log('[Agent Prompt Content] verify first_message changed:', verifyFirstMessageChanged);
    console.log('[Agent Prompt Content] verify first_message matches:', verifyFirstMessageMatches);
    console.log('[Agent Prompt Content] verify system_prompt changed:', verifyPromptChanged);
    console.log('[Agent Prompt Content] verify system_prompt matches:', verifyPromptMatches);
    console.log('[Agent Prompt Content] BEFORE greeting:', (beforeMsg || '').slice(0, 120));
    console.log('[Agent Prompt Content] AFTER greeting:', (afterMsg || '').slice(0, 120));
    console.log('[Agent Prompt Content] EXPECTED greeting:', expectedMsg.slice(0, 120));

    return {
        patchResponse: { prompt: promptPatchResponse, firstMessage: firstMessagePatchResponse },
        agentId,
        agentsUrl,
        verifyFirstMessageChanged,
        verifyMatchesExpected: verifyMatches,
        verifyFirstMessageMatches,
        verifyPromptMatches,
        beforeSnapshot: before,
        afterSnapshot: after,
    };
}

/**
 * School settings: prompt/KB via PATCH /prompt; human transfer via PATCH /agents built_in_tools.
 * Does not touch tools (those are set once at registration).
 */
async function syncSchoolAgent(agentId, {
    firstMessage = '',
    systemPrompt = '',
    knowledgeBaseId = '',
    humanTransfer = { enabled: false, condition: '', phoneNumber: '' },
} = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }

    const fullPrompt = `${systemPrompt || ''}\n\n${APPOINTMENT_AGENT_PROMPT}`;
    const transferOn = Boolean(humanTransfer?.enabled && humanTransfer?.phoneNumber);

    const before = await fetchAgentSnapshot(agentId, 'sync before');
    const branchId = resolveAgentBranchId(before);
    if (branchId) {
        console.log('[Agent Sync] branch_id:', branchId);
    }

    console.log('[Agent Sync] PATCH /agents (prompt.prompt + first_message), no tools');
    const promptPatchResponse = await patchAgentSystemPrompt(agentId, fullPrompt, knowledgeBaseId, {
        branchId,
        label: 'settings system_prompt',
        existingAgent: extractConversationAgent(before),
    });
    const firstMessagePatchResponse = await patchAgentFirstMessage(agentId, firstMessage, {
        branchId,
        label: 'settings first_message',
    });
    const patchResponse = { prompt: promptPatchResponse, firstMessage: firstMessagePatchResponse };

    const transferResult = await patchAgentHumanTransfer(agentId, humanTransfer, { branchId });
    if (transferOn && !transferResult) {
        const err = new Error('Prompt saved but human transfer failed to sync to ElevenLabs (built_in_tools).');
        reportElevenLabsAlert(err, {
            title: 'ElevenLabs agent sync failed',
            source: 'elevenlabs.syncSchoolAgent',
            metadata: { agentId },
        });
        err.statusCode = 502;
        throw err;
    }
    if (!transferOn) {
        console.log('[Agent Sync] human transfer disabled on agent');
    } else {
        console.log('[Agent Sync] human transfer synced via built_in_tools.transfer_to_number');
    }

    return patchResponse;
}

async function patchAgentHumanTransfer(agentId, humanTransfer, { branchId = null } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }

    const enabled = Boolean(humanTransfer?.enabled && humanTransfer?.phoneNumber);
    const transferToolConfig = enabled
        ? {
            type: 'system',
            name: 'transfer_to_number',
            response_timeout_secs: 20,
            disable_interruptions: false,
            force_pre_tool_speech: false,
            pre_tool_speech: 'auto',
            assignments: [],
            tool_call_sound: null,
            tool_call_sound_behavior: 'auto',
            tool_error_handling_mode: 'auto',
            params: {
                system_tool_type: 'transfer_to_number',
                transfers: [{
                    custom_sip_headers: [],
                    transfer_destination: {
                        type: 'phone',
                        phone_number: humanTransfer.phoneNumber
                    },
                    transfer_type: 'sip_refer',
                    post_dial_digits: null,
                    phone_number: humanTransfer.phoneNumber,
                    condition: buildHumanTransferToolCondition(humanTransfer.condition),
                }],
                enable_client_message: true
            }
        }
        : null;

    try {
        const url = agentsUrlFor(baseUrl, agentId, branchId);
        const payload = {
            conversation_config: {
                agent: {
                    prompt: {
                        built_in_tools: {
                            transfer_to_number: transferToolConfig,
                        },
                    },
                },
            },
        };
        console.log('[Agent Human Transfer] PATCH /agents built_in_tools.transfer_to_number', enabled ? 'enabled' : 'disabled');
        if (enabled) {
            console.log('[Agent Human Transfer] condition:', buildHumanTransferToolCondition(humanTransfer.condition));
            console.log('[Agent Human Transfer] phone:', humanTransfer.phoneNumber);
        }

        const response = await axios.patch(url, payload, { headers: elevenLabsHeaders() });
        console.log('[Agent Human Transfer] status:', response.status);
        return response.data;
    } catch (err) {
        console.error('[Agent Human Transfer] failed:', err.response?.status, JSON.stringify(err.response?.data || {}));
        if (isToolsToolIdsConflict(err)) {
            console.error('[Agent Human Transfer] cannot set built_in_tools while agent uses tool_ids in the same prompt config');
        }
        return null;
    }
}

module.exports = {
    createSchoolAgent,
    importSipTrunk,
    deletePhoneNumber,
    updatePhoneNumber,
    registerTool,
    patchAgentPrompt,
    patchAgentSystemPrompt,
    patchAgentFirstMessage,
    linkAgentToolIds,
    syncSchoolAgent,
    patchAgentPromptContent,
    patchAgentHumanTransfer,
    normalizeToolIds,
    isToolsToolIdsConflict,
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    APPOINTMENT_AGENT_PROMPT,
    GLOBAL_TIME_TOOL_ID,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE,
    HUMAN_TRANSFER_TOOL_CONDITION,
    buildHumanTransferToolCondition,
};
