const { getSettings } = require('./db');
const {
  clinicNow, availableSlots, bookAppointment, findService, findProvider,
} = require('./booking');
const knowledge = require('./knowledge');

// Local email check (chat.js imports this file, so it can't be imported back without a cycle)
function cleanEmail(raw) {
  const e = String(raw || '').trim().toLowerCase().slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOOL_ROUNDS = 6;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TOOLS = [
  {
    name: 'check_availability',
    description: 'List open appointment times for a date and service. Call this before offering any time to the guest.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date as YYYY-MM-DD' },
        service: { type: 'string', description: 'Service name exactly as listed in the clinic info' },
        provider: { type: 'string', description: 'Optional provider name if the guest asked for one' },
      },
      required: ['date', 'service'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment. Only call after the guest has confirmed the service, date, time, full name, and phone number.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: '24-hour HH:MM, as returned by check_availability' },
        service: { type: 'string' },
        patient_name: { type: 'string', description: 'Guest full name' },
        phone: { type: 'string', description: 'US 10-digit phone number' },
        email: { type: 'string', description: 'Guest email address (required to book)' },
        provider: { type: 'string', description: 'Optional provider name' },
      },
      required: ['date', 'time', 'service', 'patient_name', 'phone', 'email'],
    },
  },
];

// Possible emergencies after an injectable or laser treatment: send to a clinic or ER, never handle in chat.
const EMERGENCY_WORDS = [
  'bleeding', 'bleeds', 'swelling', 'swollen', 'severe pain', 'unbearable pain',
  'can\'t breathe', 'cannot breathe', 'trouble breathing', 'difficulty breathing', 'throat is closing',
  'chest pain', 'vision loss', 'vision changes', 'blurry vision', 'vision is blurry', 'vision blurry', 'lost vision', 'can\'t see', 'cannot see', 'double vision',
  'allergic reaction', 'hives', 'emergency', 'fainted', 'passed out',
  // Spanish
  'sangrado', 'sangrando', 'hinchazón', 'hinchado', 'dolor fuerte', 'dolor severo',
  'no puedo respirar', 'dificultad para respirar', 'visión borrosa', 'no puedo ver', 'reacción alérgica', 'emergencia',
];

function isEmergency(text) {
  const t = String(text || '').toLowerCase();
  return EMERGENCY_WORDS.some((w) => t.includes(w));
}

const HUMAN_WORDS = [
  'talk to a human', 'talk to a person', 'talk to someone', 'real person', 'speak to staff', 'speak to someone',
  'talk to staff', 'speak to a person', 'representative', 'call me back', 'have someone call',
  // Spanish
  'hablar con alguien', 'persona real', 'hablar con una persona', 'hablar con alguien del personal',
];
function asksForHuman(text) {
  const t = String(text || '').toLowerCase();
  return HUMAN_WORDS.some((w) => t.includes(w));
}

const EMERGENCY_REPLY =
  'I\'m sorry you\'re going through this. If you have trouble breathing, vision changes, severe pain, or heavy bleeding or swelling, call 911 or go to the nearest emergency room now. Please also call the clinic at once so a provider can follow up. A staff member has been notified.';

// Clinic is open when the day is in openDays and the time is inside the hours
function isOpenNow(s, now) {
  const dow = new Date(`${now.date}T00:00:00Z`).getUTCDay();
  return s.openDays.includes(dow) && now.time >= s.hoursOpen && now.time < s.hoursClose;
}

async function activeOffers(db) {
  return db.all('SELECT title, description, terms FROM offers WHERE active = 1 ORDER BY sort_order, id');
}

async function buildSystemPrompt(db) {
  const s = await getSettings(db);
  const now = clinicNow();
  const services = await db.all('SELECT name, duration_min, price, description FROM services WHERE active = 1 ORDER BY name');
  const providers = await db.all('SELECT name FROM providers WHERE active = 1 ORDER BY name');
  const offers = await activeOffers(db);
  const openDays = s.openDays.map((d) => DAY_NAMES[d]).join(', ');
  const open = isOpenNow(s, now);

  return [
    `You are ${s.assistantName}, the virtual front desk for ${s.clinicName}. You chat with guests on the website 24 hours a day, 7 days a week. You answer questions, suggest the right treatment or consultation, mention current offers when they fit, and book appointments.`,
    '',
    `Today is ${now.date} (Central time, Texas). Current time is ${now.time}. The clinic is ${open ? 'OPEN right now' : 'CLOSED right now'}.`,
    open ? 'Staff can reply live now.' : `Staff replies when the clinic opens (${s.hoursOpen} on the next open day). You can still book any open time, day or night.`,
    '',
    'Clinic info:',
    `- Address: ${s.clinicAddress}`,
    `- Phone: ${s.clinicPhone}`,
    `- Hours: ${openDays}, ${s.hoursOpen} to ${s.hoursClose}`,
    s.bookingUrl ? `- Online booking page (share only if the guest asks to book on their own): ${s.bookingUrl}` : '',
    `- Providers: ${providers.map((d) => d.name).join(', ') || 'none listed'}`,
    '- Treatments (price is confirmed at the consultation unless listed):',
    ...services.map((x) => `  - ${x.name} (${x.duration_min} min, ${x.price || 'price at consultation'})${x.description ? ': ' + x.description : ''}`),
    '',
    'Current offers (mention at most one, only when it fits, and always with its terms):',
    ...(offers.length
      ? offers.map((o) => `  - ${o.title}: ${o.description || ''}${o.terms ? ` Terms: ${o.terms}` : ''}`)
      : ['  - none right now. Do not mention any offer or discount.']),
    '',
    'Knowledge base (answer questions from this when it applies):',
    knowledge.asPromptText() || 'none',
    '',
    'How to act as a receptionist:',
    '- Be warm, brief, and conversational. Ask one question at a time. Keep replies to about 60 words unless you are listing options.',
    '- Reply in the language the guest writes in (English or Spanish).',
    '- Find out the goal first (for example: smoother forehead, fuller lips, glowing skin, hair loss, weight). Then suggest the most fitting treatment and recommend a consultation as the first step, because the provider decides what is right.',
    '- When a guest is interested, offer to book a consultation. Offer 2 to 4 times from check_availability.',
    '- If a relevant offer exists, mention it once, naturally, with its terms. Never invent offers, discounts, or deadlines.',
    '- Do not invent prices, times, providers, or availability. Use check_availability for any availability question.',
    '- To book, collect: treatment, date, time, full name, US phone number, and email address. Email is required. Confirm the details, then call book_appointment.',
    '- After a booking, confirm the date, time, treatment, and provider, and say the clinic will send a reminder.',
    '- If the guest is unsure, offer a consultation. If they ask for a person, or you cannot help, say a staff member will follow up.',
    '',
    'Medical safety (always follow):',
    '- You are not a clinician. Never diagnose, prescribe, recommend doses or product quantities, or promise results. Never share before-and-after or outcome claims.',
    '- For prescription or medically supervised services (hormone replacement, weight loss, peptides, IV therapy, sexual health, hair restoration, injectables), say a licensed provider reviews eligibility at the consultation. Do not say whether the guest qualifies.',
    '- Tell guests to mention pregnancy, breastfeeding, medications, allergies, and past reactions at the consultation.',
    '- For any side effect or problem after a treatment (swelling, pain, bleeding, vision changes, allergic reaction, trouble breathing), tell them to call 911 or go to the nearest ER if severe, and to call the clinic right away. Do not give treatment advice in chat.',
    s.aiInstructions ? `- Clinic instructions: ${s.aiInstructions}` : '',
  ].filter((line) => line !== '').join('\n');
}

// Stored messages -> Gemini contents. Staff messages go in as model text,
// consecutive same-role messages are merged, and the list starts with a user turn.
function toApiMessages(history) {
  const out = [];
  for (const m of history) {
    const role = m.sender === 'patient' ? 'user' : 'model';
    const text = m.sender === 'staff' ? `[Clinic staff] ${m.text}` : m.text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n${text}`;
    else out.push({ role, parts: [{ text }] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function executeTool(db, name, input, ctx) {
  if (name === 'check_availability') {
    const service = await findService(db, input.service);
    if (!service) throw new Error(`Unknown service "${input.service}". Use one of the listed services.`);
    const provider = input.provider ? await findProvider(db, input.provider) : null;
    if (input.provider && !provider) throw new Error(`Unknown provider "${input.provider}".`);
    const slots = await availableSlots(db, input.date, { serviceId: service.id, providerId: provider ? provider.id : null });
    return {
      date: input.date,
      service: service.name,
      slots: slots.slice(0, 20).map((s) => ({ time: s.time, provider: s.providerName })),
      note: slots.length ? undefined : 'No open times on this date. Suggest another date.',
    };
  }
  if (name === 'book_appointment') {
    const email = cleanEmail(input.email);
    if (!email) throw new Error('Email is required to book. Ask the guest for their email address first.');
    const booking = await bookAppointment(db, {
      date: input.date,
      time: input.time,
      serviceName: input.service,
      providerName: input.provider,
      patientName: input.patient_name,
      phone: input.phone,
      source: ctx.channel,
      conversationId: ctx.conversationId,
    });
    await db.run('UPDATE clients SET email = ? WHERE id = ?', [email, booking.clientId]);
    return { booked: true, ...booking };
  }
  throw new Error(`Unknown tool ${name}`);
}

function textOf(parts) {
  return parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n').trim();
}

// Gemini expects upper-case type names in function schemas
function toGeminiSchema(schema) {
  const out = { ...schema, type: schema.type.toUpperCase() };
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  return out;
}

const FUNCTION_DECLARATIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: toGeminiSchema(t.input_schema),
}));

async function callGemini(model, body) {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Returns { text, needsHuman, pause, reason }
async function respond(db, { history, conversationId, channel = 'website' }) {
  const text = history.length ? history[history.length - 1].text : '';
  if (isEmergency(text)) return { text: EMERGENCY_REPLY, needsHuman: true, pause: true, reason: 'medical' };
  if (asksForHuman(text)) {
    return { text: 'Of course. I\'ve asked a staff member to reply to you here shortly. We are glad to help you find a time that works in the meantime.', needsHuman: true, pause: true, reason: 'human_request' };
  }

  if (!process.env.GEMINI_API_KEY) return fallbackReply(db, text);

  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const contents = toApiMessages(history);
  if (contents.length === 0) return { text: 'Hi, I\'m here 24/7. How can I help you today? I can answer questions, suggest a treatment, or book a consultation.', needsHuman: false };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await callGemini(model, {
        systemInstruction: { parts: [{ text: await buildSystemPrompt(db) }] },
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        generationConfig: { maxOutputTokens: 1024 },
        contents,
      });
      const candidate = (resp.candidates || [])[0];
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      const calls = parts.filter((p) => p.functionCall);
      if (calls.length === 0) {
        return { text: textOf(parts) || 'Sorry, could you say that again?', needsHuman: false };
      }
      contents.push({ role: 'model', parts });
      const responses = [];
      for (const { functionCall } of calls) {
        try {
          const out = await executeTool(db, functionCall.name, functionCall.args || {}, { conversationId, channel });
          responses.push({ functionResponse: { name: functionCall.name, response: { result: out } } });
        } catch (err) {
          responses.push({ functionResponse: { name: functionCall.name, response: { error: err.message } } });
        }
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { text: 'Sorry, I could not finish that. A staff member will follow up.', needsHuman: true, pause: false, reason: 'unclear' };
  } catch (err) {
    console.error('[ai] error:', err.message);
    return { text: 'Sorry, I am having trouble right now. A staff member will follow up with you.', needsHuman: true, pause: false, reason: 'unclear' };
  }
}

// Used when no API key is configured. Answers basic questions only; booking needs the AI.
async function fallbackReply(db, text) {
  const t = text.toLowerCase();
  const s = await getSettings(db);
  const services = await db.all('SELECT name, price FROM services WHERE active = 1 ORDER BY name');
  const offers = await activeOffers(db);

  if (/price|cost|how much|magkano|cuanto|precio/.test(t)) {
    const offerLine = offers.length ? ` Current offer: ${offers[0].title}${offers[0].terms ? ` (${offers[0].terms})` : ''}.` : '';
    return { text: `Pricing is confirmed at your consultation, so the provider can recommend the right plan.${offerLine} Tap Book appointment to schedule one.`, needsHuman: false };
  }
  if (/hour|open|close|schedule|horario|abierto/.test(t)) {
    return { text: `We are open ${s.hoursOpen} to ${s.hoursClose}, ${s.openDays.map((d) => DAY_NAMES[d]).join(', ')}. You can book any open time online, any time.`, needsHuman: false };
  }
  if (/where|address|location|direccion|donde/.test(t)) {
    return { text: `${s.clinicName}, ${s.clinicAddress}. Phone: ${s.clinicPhone}.`, needsHuman: false };
  }
  if (/service|treatment|botox|filler|what do you|tratamiento/.test(t)) {
    return { text: 'We offer: ' + services.map((x) => x.name).join(', ') + '. Tell me your goal and I can suggest a fit, or tap Book appointment.', needsHuman: false };
  }
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|hola|buenos)/.test(t.trim())) {
    return { text: `Hi, I'm ${s.assistantName} from ${s.clinicName}. I'm here around the clock. Are you looking for a specific treatment, or would you like to book a consultation?`, needsHuman: false };
  }
  if (/book|appointment|cita|consult/.test(t)) {
    return { text: 'Tap Book appointment in this chat to choose a treatment and time. A consultation is a good first step.', needsHuman: false };
  }
  const named = services.find((x) => t.includes(x.name.toLowerCase()));
  if (named) {
    return { text: `${named.name}: pricing is confirmed at your consultation. Tap Book appointment to choose a time.`, needsHuman: false };
  }
  const answer = knowledge.findAnswer(t);
  if (answer) return { text: answer, needsHuman: false };
  return { text: 'Thanks for reaching out! A team member will reply shortly. You can also tap Book appointment to schedule a consultation.', needsHuman: true, reason: 'unclear' };
}

module.exports = { respond, isEmergency, asksForHuman, isOpenNow, buildSystemPrompt, toApiMessages, executeTool, TOOLS };
