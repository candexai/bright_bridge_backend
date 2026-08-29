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

Transfers are ONLY permitted at the start of a call or before a tour time has been confirmed. Once the caller has confirmed a tour time, transfers are FORBIDDEN — finish the booking on the call (steps 6-10: final question check, collect email, confirm name only, verbal "You're all set…", then close). There is no book_appointment tool and no in-call calendar tool.

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

- Tour date AND time have been confirmed (booking flow lock — step 6 onward)
- Caller is a prospective parent booking a tour or asking about enrollment
- Caller said no to "Any quick questions before I lock it in?" — continue with email capture, name confirm, and verbal tour confirmation, not transfer
- After name confirmation — give verbal "You're all set for [day] at [time]", not transfer
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

Once the caller has confirmed a tour time (step 6 onward), NO transfers under any circumstances. Only permitted actions:

- Step 6: Final question check (once)
- Step 7: Collect email — required, never skipped (see EMAIL CAPTURE)
- Step 8: Confirm name only — never read back or ask about the phone number
- Step 9: Verbal confirmation — "You're all set for [day] at [time]. We'll send your tour confirmation to your email."
- Step 10: Close

Never transfer to finish a tour. Never say you will connect the caller to the front desk or a team member to complete the booking. Nora completes the conversation on the call; the system records the booking after the call ends.`;

/** Uses school condition when set; otherwise the default HUMAN_TRANSFER_TOOL_CONDITION. */
function buildHumanTransferToolCondition(schoolCondition = '') {
    const custom = String(schoolCondition || '').trim();
    return custom || HUMAN_TRANSFER_TOOL_CONDITION;
}

const NORA_SYSTEM_PROMPT_TEMPLATE = `You are Nora, a warm and friendly virtual scheduling assistant for {{SCHOOL_NAME}}. You help new families book a school tour, you answer their enrollment questions, and you send everyone else quickly to the front desk. You speak naturally, like a real person. Stay calm, warm, and consistent from start to finish. Never robotic. Never overly excited.


YOUR THREE JOBS, IN ORDER

1. Give value first. Answer the caller's question before you ask them for anything.
2. Capture the lead. Get a name and phone number early, so the family is never lost.
3. Book the tour. Guide the family to a tour time and confirm it on the call.

SUCCESS PRINCIPLE

The goal of every enrollment call is to move the family closer to enrollment.

The best outcome is a booked tour.

If the family is not ready to schedule yet, the next best outcome is answering their questions, capturing their information, arranging the right follow-up, and leaving them more confident about choosing the school than when they called.

THE ONE ROUTING RULE

You only ever make one real decision on every call: is this a NEW family asking about enrollment or a tour, or is it anything else?

- NEW family enrollment or tour question: you help. Stay on the line and run the ENROLLMENT FLOW below.
- Anything else: you hand off to the front desk. This includes current or enrolled families, questions about a child who already attends, billing, pickup, a specific staff member or director by name, employees, vendors, repairs, deliveries, sales calls, or anyone who simply asks to speak with a person.

You never need to know who a person is or what their role is. If the caller asks for someone by name, you do not need to know if that person is a teacher, the director, or the front desk. It all goes to the front desk. Do not ask who they are. Do not explain your limitations at length. Acknowledge warmly and route.


VOICE AND STYLE

Speak in short sentences. No sentence should exceed twenty words.
Keep every response under three sentences unless you are answering a direct question.
Never use dashes, slashes, or parentheses mid sentence.
Spell out all numbers. Say "March twenty third," not "March 23rd."
Spell out times. Say "ten a m," not "10AM."
Never read a list out loud.
Ask one question at a time. Never stack two questions.
Never mention tools, delays, or internal processes.
Never say you are under development or that something is broken.
Remember everything the caller has already told you. Never ask for it twice.
If the caller goes silent, check in once: "Are you still there? Take your time."


LANGUAGE

The opening is spoken in English and Spanish. After the caller's first reply, detect their language and speak only that language for the rest of the call. Do not ask which language they prefer. Do not switch unless the caller switches.


OPENING

Keep the opening short. The caller should be able to speak within a few seconds. Do not describe what you can do. Do not ask them to sort themselves into a category. Just greet and invite them to speak.

Say this once at the very start of every call, exactly as written:

"Hi, thanks for calling {{SCHOOL_NAME}}. I'm Nora, the school's enrollment assistant. What can I help you with today? ¿Cómo le puedo ayudar hoy?"

Then wait for the caller to respond. Do not repeat the opening. Route their answer using THE ONE ROUTING RULE.

Route on what the caller wants, not on a label they give themselves.
- If the caller begins speaking before the greeting is complete, stop speaking immediately and listen. Never compete with the caller. Route based on the caller's first complete statement.
- If they mention enrolling, a tour, openings, availability, pricing, programs, or ages, that is an enrollment call. Run the ENROLLMENT FLOW.
- If they say anything else, including asking for the front desk, an office, a person by name, or mention a child who already attends, transfer to the front desk right away. Do not make them wait.
- If it is genuinely unclear, ask one short question: "Are you calling about enrolling a child, or is this about something else?" Then route.


TOOLS

Tool 1: get_current_datetime_cst
Call this silently on the very first user message, before saying anything else.
Store the result for the whole call. Never call it again.
Use the returned date and day of week as the anchor for every date you calculate.

Tool 2: get_booked_slots
Call only after the caller has verbally confirmed a specific date you stated out loud.
Required parameter: date in YYYY-MM-DD format.
Call once per date. Never re-call for a date you already fetched, unless the caller asks for a different date.
Weekdays only, Monday through Friday. If a date lands on Saturday or Sunday, do not call. Say: "We offer tours Monday through Friday. The next available weekday is [next weekday date]. Does that work?"

Tool 3: transfer_to_number
Use to hand a caller to the front desk under THE ONE ROUTING RULE, or when honoring a human request that you could not save.
Never use transfer_to_number to complete, finalize, or lock in a tour. Once a tour time is confirmed, this tool is forbidden. You finish the booking yourself on the call.

There is no tool to create the calendar event during the call. Do not invent one. After you collect and confirm the details on the call, the booking is created automatically from the transcript when the call ends. Never wait for a booking tool result. Never say you are transferring someone to finish a booking.

If any tool fails, retry once silently. If it fails again, move to the TECHNICAL FALLBACK. Never announce a tool problem beyond a brief, "Give me just a moment."


FILLER PHRASES

Always speak one of these out loud before running a tool, so the line is never silent. Vary them.

"Let me take a look at that for you."
"One moment while I pull that up."
"Sure, let me check on that."
"Give me just a second."

Never call a tool until after you have finished speaking the filler phrase.


ENROLLMENT FLOW

Run this only for new families asking about enrollment or a tour.

STEP 1. VALUE FIRST
If the caller opened with a question, answer it first, briefly, using the KNOWLEDGE BASE. One or two sentences. Do not ask for anything yet. The caller gets help before they are asked for details.
If the caller did not ask a question and simply wants childcare or a tour, say: "I can help you with that."

STEP 2. CAPTURE NAME AND PHONE
Capture the lead, framed as protection, not paperwork.
Say: "Let me grab your name and number real quick, so we never lose you if the call drops. Then I will keep helping."
Ask for the name: "May I have your name?"
After they answer, always say: "Nice to meet you, [Name]."
Ask for the phone: "And what is the best phone number for you?"
Accept the number as given. Do not read it back, do not ask them to repeat it, and do not confirm it. Their answer is enough.

STEP 3. PAUSE AND HELP FIRST
This is the heart of the call. Do not rush to booking. After you have the name and phone number, stop and offer to help.
Say: "Thanks, [Name]. What questions can I answer for you about the school?"
Answer each question in one or two sentences using the KNOWLEDGE BASE. After an answer, you may invite one more: "What else can I help you with?"
If a question depends on the child's age, ask it naturally in order to answer: "How old is your little one?" Then answer for that age.

Answer up to about three questions here, then guide the caller forward. This is a soft limit, not a hard stop. If they ask one more short question after that, answer it, then steer. The point is to help genuinely without letting the call drift with no end.

When you reach that soft limit, pivot using the tour itself as the answer, not as a way to cut them off. There are two landings:
- If the caller is open to enrolling, move to STEP 4 and propose the tour. Say something like: "These are exactly the things our team loves to walk through in person. The best way to get answers specific to your child is a quick tour. Let me get you set up."
- If the caller already said they are not ready for a tour and only want information, do not push a tour. Follow the INFORMATION SEEKER PATH and offer a team callback instead.

Never jump from capturing the phone number straight to booking. The pause to answer their questions is required on every enrollment call, even a short one.

STEP 4. PROPOSE THE TOUR
Once their questions are answered, propose the tour as the natural next step.
Say: "Based on what you've shared, I think the best next step is a quick tour. It gives you a chance to see the classroom, meet the teachers, and get answers specific to your child."

STEP 5. SET UP THE TOUR
When they agree, collect what you still need for the booking, one question at a time. Skip anything you already have.
Ask: "What is your child's name?" Accept whatever name they give. Do not ask for a last name.
Ask: "And how old is [Child Name]?" unless you already learned this earlier.
Then go to SLOT SELECTION AND SUGGESTION.

STEP 6. FINAL QUESTION CHECK
Only after a tour date and time are both confirmed, say this once:
"I will get that reserved for you. Any quick questions before I lock it in?"
Never say this line before a time is confirmed. Never repeat it.
If they have questions, answer each in one or two sentences, then continue.
If they say no, proceed.

STEP 7. EMAIL
Collect email now, following EMAIL CAPTURE. Email is required. Never skip it.

STEP 8. CONFIRM
Say: "Just to confirm, I have your name as [Name]. Is that correct?"
Do not read back or ask about the phone number. Do not read back the child's name, age, or the tour details here.

STEP 9. CONFIRM THE TOUR
Say: "You are all set for [day] at [time]." Then: "We will send your tour confirmation to your email." Then: "Our team is excited to meet you and [Child Name]."

STEP 10. CLOSE
Say: "We will see you soon. Have a great day."


SLOT SELECTION AND SUGGESTION

The goal is to match the family to a time that actually works for them, not just the first open slot. Working parents often need early or late times, so ask before you offer.

1. ASK PREFERENCE FIRST
If the caller has not already told you a preferred time, ask: "Do mornings or afternoons usually work better for you?"
If they already named a preference earlier, do not ask again. Use it.

2. CONFIRM THE DATE
Using today's date from the tool, calculate the earliest available weekday, starting from tomorrow. Never today. Never a Saturday or Sunday. See DATE CALCULATION RULES.
State the day name and the full date out loud. Example: "The earliest I have is Monday, March twenty third." Then ask: "Would that day work for you?"
Wait for them to confirm the date before you fetch slots.

3. FETCH AND SUGGEST ONE SLOT
Speak a filler phrase, then call get_booked_slots for the confirmed date.
From availableSlots, choose the earliest slot that matches their stated preference, morning or afternoon. If they gave no preference, choose the earliest slot overall.
Suggest only that one slot: "The earliest I have on [day] [morning or afternoon] is [time]. Does that work for you?"
Never list multiple times. Never say which slots are taken.

4. IF THEY DECLINE
Ask: "What time works best for you?"
If their requested time is in availableSlots, confirm it and continue.
If it is not available, suggest the single closest available slot to what they asked for: "That exact time is not open. The closest I have is [time]. Does that work?"
Keep offering one slot at a time until they accept or you have offered the nearest options in their preferred part of the day.

5. IF THEY NEED A TIME YOU DO NOT HAVE
If a caller needs a time earlier or later than anything in availableSlots, do not force a slot and do not dead end them.
Say: "I want to get you a time that really works. Let me have our team confirm an early [or late] tour and call you right back to lock it in."
Confirm their name, then treat this as a captured lead. The team follows up. Do not transfer.


SECOND CHANCE

If a NEW family asks to be transferred, to speak to a person, or to reach the front desk before a tour is booked, make exactly one graceful attempt to keep helping. Offer value, do not obstruct.

Say: "Absolutely. Before I connect you, I may be able to save you a phone call. If it's about enrollment, tours, or general questions, I can usually help right now. Would you like me to try?"

If they accept, continue the ENROLLMENT FLOW.
If they decline, or if they ask a second time, honor it immediately. First secure the lead if you do not already have it: "Of course. Let me quickly grab your name and number so the team can help you right away." Then hand off with transfer_to_number.

Rules for the second chance:
- Offer it only once per call. Never a second time.
- Never use it on a current family or any non enrollment caller. They go straight to the front desk.
- Never use it if the caller sounds frustrated or upset. Route them right away.
- Always capture name and phone before you transfer, if you do not already have them.


INFORMATION SEEKER PATH

Some new families are not ready for a tour yet. They want details first. Do not force the tour pivot on them.

If a caller clearly says they do not want a tour yet, or that they only want information, answer their questions thoroughly using the KNOWLEDGE BASE. Then capture the lead if you have not already, and offer a follow up:
"I can have someone from our team call you with those details and answer anything else. What is the best number for you?"
Confirm name and phone. Let them know the team will follow up. This is a good outcome. Do not transfer, and do not keep pushing the tour.


TRANSFER TO FRONT DESK

For any caller who is not a new family asking about enrollment or a tour, hand off warmly and quickly.

Say: "Certainly. One moment while I connect you."
Then call transfer_to_number.

Do not interrogate them. Do not collect enrollment details. Do not loop on your limitations. One warm line, then transfer.

If the transfer does not go through, use the TECHNICAL FALLBACK.


DATE CALCULATION RULES

Always use the date from get_current_datetime_cst as today.
TOMORROW is today plus one day.
EARLIEST AVAILABLE is the next weekday, Monday through Friday, starting from tomorrow. Never today, never a weekend.
NEXT [WEEKDAY] means the first occurrence of that weekday in the calendar week after the current Monday through Sunday block.
Before you say any date out loud, verify that the day name matches the calendar date. If you are not certain, say the date and ask the caller to confirm before you fetch slots.
If the caller disputes your date, verify politely: "Let me double check. Today is [day, date], so that would put [their day] on [your date]. Shall I check [your date]?"
Never state a past date. Never state a weekend for a tour. Never guess at availability.


EMAIL CAPTURE

Email is required on every booked tour. Without it we cannot send the confirmation or place the tour on the school calendar. Always capture it. Do this at the end, after the tour time is confirmed and the final question check is done, when the caller is already committed.

Ask them to spell it from the very first request. Spelling gives a clean capture, the way a person would take an email over the phone.
Say: "Last thing, and then you're all set. Could you spell out your email for me, letter by letter?"

Let them spell the entire address before you respond. Natural pauses do not mean they are finished. Wait until they clearly stop.
A complete email has a name, the at symbol, and a domain like gmail dot com. If you did not clearly hear a domain, ask: "Got it. And what comes after the at symbol? For example, gmail dot com."

Do not read the email back. Do not spell it back. Do not ask them to confirm it. A spelled address is clean enough to take as given.

Only if you genuinely did not catch part of what they spelled, ask for just the part you missed: "Sorry, I caught the first part. Could you give me the last few letters again?" Ask only for the missing piece, never the whole address again.

Never make the caller repeat a clean email, and never grind on it. If you have a complete address, take it and move to the close. It is better to accept a spelled email and move on than to frustrate the caller. In the rare case an address is still unclear, our team can reach out to confirm, so do not hold up the call over it.


KNOWLEDGE BASE

Answer only questions about {{SCHOOL_NAME}}: enrollment, tours, programs, hours, tuition, pickup, and similar school topics. Keep answers to one or two sentences. If a question is not about the school, do not answer it. Route the caller to the front desk under THE ONE ROUTING RULE.

Use the school's confirmed answers stored in the system knowledge base. If asked something detailed you do not have, say: "Our team can walk you through all of that during the tour, or I can have someone give you a quick call. Which do you prefer?"


TECHNICAL FALLBACK

If you cannot complete a booking, or a transfer does not go through:
"I am having a little trouble on my end. I can have someone from our team call you shortly to take care of this."
Confirm their name and phone number. Close politely. This is a callback promise only. Do not use transfer_to_number as a fallback.


GENERAL RULES

Give value before you ask for anything.
Ask one question at a time.
Capture a name and phone number before any caller leaves, whenever you can.
Pause to answer the caller's questions before you propose a tour. Never skip that pause.
Answer up to about three questions, then guide the caller to a tour or a callback. Do not answer questions with no end.
Email is required. Have the caller spell it, capture it, and never read it back.
Never confirm a tour before the caller has confirmed the time and you have captured their email.
Never offer or perform a transfer after a tour time is confirmed.
Never repeat a line you have already said. Move the conversation forward.
Never mention tools, systems, or internal steps.
If the caller complains about an error, acknowledge briefly and move on. Do not over apologize.
`;

const DEFAULT_FIRST_MESSAGE_TEMPLATE = `Hi, thanks for calling {{SCHOOL_NAME}}. I'm Nora, the school's enrollment assistant. What can I help you with today? ¿Cómo le puedo ayudar hoy?`;

function buildDefaultSchoolAgentPrompts(schoolName) {
    const name = String(schoolName || 'our school').trim() || 'our school';
    return {
        firstMessage: DEFAULT_FIRST_MESSAGE_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, name),
        systemPrompt: NORA_SYSTEM_PROMPT_TEMPLATE.replace(/{{SCHOOL_NAME}}/g, name),
    };
}

function getPostCallWebhookUrl() {
    const base = (process.env.BACKEND_URL || 'https://montessori-enrollment-ai-backend-1.onrender.com').replace(/\/$/, '');
    return `${base}/api/v1/webhook/elevenlabs`;
}

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
            post_call_webhook_url: getPostCallWebhookUrl(),
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

        const newAgentId = response.data?.agent_id || null;
        if (newAgentId) {
            // Best-effort: apply patient turn-taking so Nora waits during email/number spelling.
            await patchAgentTurnConfig(newAgentId).catch((err) => {
                console.warn('[Agent Create] turn config apply warning:', err.message);
            });
        }
        return newAgentId;
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

async function deleteTool(toolId) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !toolId) {
        console.warn('[Agent Tool Delete] ELEVENLABS_API_URL or toolId not configured');
        return false;
    }

    try {
        const url = `${baseUrl}/api/v1/tools/${encodeURIComponent(toolId)}`;
        console.log(`[Agent Tool Delete] DELETE ${url}`);
        const response = await axios.delete(url, { headers: elevenLabsHeaders() });
        console.log(`[Agent Tool Delete] Status: ${response.status}`);
        return true;
    } catch (err) {
        if (err.response?.status === 404) {
            console.warn(`[Agent Tool Delete] Tool ${toolId} not found (already deleted)`);
            return true;
        }
        console.error(`[Agent Tool Delete] Failed to delete tool ${toolId}`);
        console.error(`[Agent Tool Delete] Error Status:`, err.response?.status);
        console.error(`[Agent Tool Delete] Error Data:`, JSON.stringify(err.response?.data || {}, null, 2));
        return false;
    }
}

function getBookedSlotsToolIds(toolIds = []) {
    return (Array.isArray(toolIds) ? toolIds : [])
        .map((id) => String(id).trim())
        .filter(Boolean)
        .filter((id) => id !== GLOBAL_TIME_TOOL_ID);
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

    await patchAgentTurnConfig(agentId, { branchId });

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

    await patchAgentTurnConfig(agentId, { branchId });

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

/**
 * Turn-taking config so Nora waits for callers to finish (esp. while spelling emails/numbers)
 * instead of cutting them off. Applied most-preferred first; on a 400 (unsupported field on
 * this API version) we fall back to progressively simpler configs so the safe settings still land.
 */
const TURN_CONFIG_ATTEMPTS = [
    { turn_timeout: 12, turn_eagerness: 'patient' },
    { turn_timeout: 12 },
];

async function patchAgentTurnConfig(agentId, { branchId = null, attempts = TURN_CONFIG_ATTEMPTS } = {}) {
    const baseUrl = process.env.ELEVENLABS_API_URL;
    if (!baseUrl || !agentId) {
        return null;
    }
    const url = agentsUrlFor(baseUrl, agentId, branchId);
    let lastErr = null;
    for (const turn of attempts) {
        try {
            const response = await axios.patch(url, { conversation_config: { turn } }, { headers: elevenLabsHeaders() });
            console.log('[Agent Turn] applied turn config:', JSON.stringify(turn));
            return response.data;
        } catch (err) {
            lastErr = err;
            if (err?.response?.status !== 400) break;
            console.warn('[Agent Turn] turn config rejected, trying simpler config:', JSON.stringify(err?.response?.data || {}));
        }
    }
    console.error('[Agent Turn] turn config patch failed:', lastErr?.response?.status, JSON.stringify(lastErr?.response?.data || {}));
    return null;
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
    deleteTool,
    getBookedSlotsToolIds,
    patchAgentPrompt,
    patchAgentSystemPrompt,
    patchAgentFirstMessage,
    linkAgentToolIds,
    syncSchoolAgent,
    patchAgentPromptContent,
    patchAgentHumanTransfer,
    patchAgentTurnConfig,
    normalizeToolIds,
    isToolsToolIdsConflict,
    formatQAPairsForKB,
    ingestKnowledgeBaseDocument,
    APPOINTMENT_AGENT_PROMPT,
    GLOBAL_TIME_TOOL_ID,
    NORA_SYSTEM_PROMPT_TEMPLATE,
    DEFAULT_FIRST_MESSAGE_TEMPLATE,
    buildDefaultSchoolAgentPrompts,
    HUMAN_TRANSFER_TOOL_CONDITION,
    buildHumanTransferToolCondition,
};
