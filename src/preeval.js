// Pre-evaluation: the questions a guest answers on the homepage before booking.
// Saves the answers, creates (or reuses) the client, and opens a chat with a personal recap.
const crypto = require('node:crypto');
const booking = require('./booking');
const { saveClientDetails, cleanEmail } = require('./chat');

const MAX_ANSWERS = 12;
const MAX_ANSWER = 300;

function nowIso() { return new Date().toISOString(); }

async function submit(db, body) {
  const service = await booking.findService(db, body.service);
  if (!service) throw new booking.BookingError('Please choose a treatment from the list.');

  const name = String(body.name || '').trim().slice(0, 80);
  if (name.length < 2) throw new booking.BookingError('Please enter your full name.');
  const phone = booking.normalizePhone(body.phone);
  if (!phone) throw new booking.BookingError('Please enter a valid 10-digit US mobile number.');
  const email = cleanEmail(body.email);
  if (String(body.email || '').trim() && !email) throw new booking.BookingError('Please enter a valid email address, or leave it blank.');

  // Keep only short string answers, with a cap on how many
  const answers = [];
  for (const a of Array.isArray(body.answers) ? body.answers : []) {
    const q = String(a.question || '').trim().slice(0, 160);
    const v = String(a.answer || '').trim().slice(0, MAX_ANSWER);
    if (q && v) answers.push({ question: q, answer: v });
    if (answers.length >= MAX_ANSWERS) break;
  }
  const pregnancy = answers.some((a) => /pregnant|breastfeeding/i.test(a.question) && /^yes/i.test(a.answer));

  const now = nowIso();
  return db.transaction(async (tx) => {
    let client = await tx.one('SELECT * FROM clients WHERE phone = ?', [phone]);
    if (!client) {
      const id = await tx.insert('INSERT INTO clients (full_name, phone, created_at) VALUES (?, ?, ?)', [name, phone, now]);
      client = { id };
    }
    await tx.run(
      'INSERT INTO preevaluations (client_id, service, answers, created_at) VALUES (?, ?, ?, ?)',
      [client.id, service.name, JSON.stringify(answers), now]
    );
    const token = crypto.randomBytes(16).toString('hex');
    const convId = await tx.insert(
      `INSERT INTO conversations (token, channel, client_id, needs_human, handoff_reason, last_message_at, created_at)
       VALUES (?, 'preeval', ?, ?, ?, ?, ?)`,
      [token, client.id, pregnancy ? 1 : 0, pregnancy ? 'pregnancy_flag' : '', now, now]
    );

    const first = name.split(/\s+/)[0];
    const recap = answers.map((a) => `- ${a.question} ${a.answer}`).join('\n');
    const follow = pregnancy
      ? 'Since you mentioned pregnancy or breastfeeding, please tell your provider at your visit. I have flagged this for our team.'
      : 'Would you like to book a consultation? I can show you open times right here.';
    const greeting = `Thanks, ${first}! I've saved your pre-evaluation for ${service.name}.\n${recap ? recap + '\n' : ''}${follow}`;
    await tx.run(
      "INSERT INTO messages (conversation_id, direction, sender, text, created_at) VALUES (?, 'out', 'ai', ?, ?)",
      [convId, greeting, now]
    );

    await tx.run("UPDATE clients SET full_name = ? WHERE id = ? AND (full_name = '' OR full_name IS NULL)", [name, client.id]);
    return { conversationId: convId, token, greeting, service: service.name, clientId: client.id };
  }).then(async (result) => {
    // Consent history uses its own transaction, so it runs after this one commits
    await saveClientDetails(db, result.clientId, { email, marketingConsent: Boolean(body.marketingConsent), source: 'website' });
    delete result.clientId;
    return result;
  });
}

module.exports = { submit };
