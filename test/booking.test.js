const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* use real env vars */ }
delete process.env.GEMINI_API_KEY; // tests run in fallback mode

const { openDb, ensureSchema } = require('../src/db');
const booking = require('../src/booking');
const { isEmergency, asksForHuman, isOpenNow, toApiMessages, buildSystemPrompt } = require('../src/ai');
const { handlePatientMessage, staffReply, messagesForVisitor } = require('../src/chat');

// Tests run in a throwaway schema on the database, never in the public tables.
// That needs the session pooler (port 5432), which keeps the schema setting per connection.
const BASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!BASE_URL) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) in vibeology-app/.env to run the tests.');
const TEST_URL = BASE_URL.replace(':6543/', ':5432/');
if (!TEST_URL.includes(':5432/')) throw new Error('Tests need the session pooler (port 5432), so they stay in their own schema.');

const BOTOX = 'Botox / Dysport / Letybo';

// Runs fn with a fresh, seeded database schema, then drops the schema
async function withDb(fn) {
  const schema = `test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: TEST_URL, max: 1, ssl: { rejectUnauthorized: false } });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = openDb(TEST_URL, { schema, max: 2 }); // keep connections low: the free database has a small limit
  try {
    await ensureSchema(db);
    return await fn(db);
  } finally {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

// Two existing guests (ids 1 and 2), used by tests that need clients
async function seedClients(db) {
  const now = new Date().toISOString();
  await db.run('INSERT INTO clients (full_name, phone, created_at) VALUES (?, ?, ?)', ['Maria Garcia', '2145550101', now]);
  await db.run('INSERT INTO clients (full_name, phone, created_at) VALUES (?, ?, ?)', ['Paolo Ramos', '2145550102', now]);
}

// A date N days from today (clinic time) that is not a Sunday
function openDate(n = 3) {
  let d = booking.addMinutes(booking.clinicNow().date, '00:00', n * 1440).slice(0, 10);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) {
    d = booking.addMinutes(d, '00:00', 1440).slice(0, 10);
  }
  return d;
}

test('phone numbers are normalized to 10-digit US numbers', () => {
  assert.equal(booking.normalizePhone('(214) 555-0182'), '2145550182');
  assert.equal(booking.normalizePhone('+1 214 555 0182'), '2145550182');
  assert.equal(booking.normalizePhone('09175550182'), null, 'Philippine-style 11-digit numbers are rejected');
  assert.equal(booking.normalizePhone('123'), null);
  assert.equal(booking.normalizePhone(''), null);
});

test('the clinic runs on Central time', () => {
  assert.equal(booking.CLINIC_TZ, 'America/Chicago');
});

test('a booked slot disappears from availability', () => withDb(async (db) => {
  const date = openDate();
  const before = await booking.availableSlots(db, date, { serviceName: 'Consultation' });
  assert.ok(before.length > 0);

  const first = before[0];
  await booking.bookAppointment(db, {
    date, time: first.time, serviceName: 'Consultation', providerName: first.providerName,
    patientName: 'Test Guest', phone: '2145551234', source: 'website',
  });

  const after = await booking.availableSlots(db, date, { serviceName: 'Consultation', providerId: first.providerId });
  assert.ok(!after.some((s) => s.time === first.time), 'same provider and time should be gone');
}));

test('the same provider cannot be double-booked', () => withDb(async (db) => {
  const date = openDate();
  const slot = (await booking.availableSlots(db, date, { serviceName: 'Consultation', providerId: 1 }))[0];
  const input = {
    date, time: slot.time, serviceName: 'Consultation', providerName: 'Sharon Suh, FNP-C',
    patientName: 'First Guest', phone: '2145551111',
  };
  await booking.bookAppointment(db, input);
  await assert.rejects(
    booking.bookAppointment(db, { ...input, patientName: 'Second Guest', phone: '2145552222' }),
    booking.BookingError
  );
}));

test('without a provider, the second guest gets the other provider', () => withDb(async (db) => {
  const date = openDate();
  const slot = (await booking.availableSlots(db, date, { serviceName: 'Consultation' }))[0];
  const a = await booking.bookAppointment(db, {
    date, time: slot.time, serviceName: 'Consultation', patientName: 'First Guest', phone: '2145551111',
  });
  const b = await booking.bookAppointment(db, {
    date, time: slot.time, serviceName: 'Consultation', patientName: 'Second Guest', phone: '2145552222',
  });
  assert.notEqual(a.provider, b.provider);
}));

test('Sundays and past dates have no slots', () => withDb(async (db) => {
  assert.deepEqual(await booking.availableSlots(db, '2000-01-01', { serviceName: 'Consultation' }), []);
  let sunday = openDate(1);
  while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = booking.addMinutes(sunday, '00:00', 1440).slice(0, 10);
  assert.deepEqual(await booking.availableSlots(db, sunday, { serviceName: 'Consultation' }), []);
}));

test('a long treatment must finish before closing time', () => withDb(async (db) => {
  const date = openDate();
  const settings = await require('../src/db').getSettings(db);
  const slots = await booking.availableSlots(db, date, { serviceName: 'Non-Surgical BBL' }); // 90 min
  const lastStart = booking.addMinutes(date, settings.hoursClose, -90).slice(11);
  assert.ok(slots.every((s) => s.time <= lastStart));
}));

test('bad input is rejected with a clear message', () => withDb(async (db) => {
  const date = openDate();
  await assert.rejects(booking.bookAppointment(db, {
    date, time: '10:00', serviceName: 'Nonexistent', patientName: 'Ann', phone: '2145551234',
  }), /Unknown service/);
  await assert.rejects(booking.bookAppointment(db, {
    date, time: '10:00', serviceName: 'Consultation', patientName: 'Ann', phone: '123',
  }), /10-digit US number/);
  await assert.rejects(booking.bookAppointment(db, {
    date: '2026-13-40', time: '10:00', serviceName: 'Consultation', patientName: 'Ann', phone: '2145551234',
  }), /Invalid date/);
}));

test('emergency words are detected in English and Spanish', () => {
  assert.equal(isEmergency('my gums are bleeding a lot'), true);
  assert.equal(isEmergency('mi cara tiene sangrado'), true);
  assert.equal(isEmergency('my vision is blurry after filler'), true);
  assert.equal(isEmergency('how much is botox'), false);
});

test('requests for a human are detected in English and Spanish', () => {
  assert.equal(asksForHuman('can I talk to a real person please'), true);
  assert.equal(asksForHuman('quiero hablar con alguien del personal'), true);
  assert.equal(asksForHuman('what time do you open'), false);
});

test('open and closed status follows the clinic hours', () => {
  const s = { openDays: [1, 2, 3, 4, 5, 6], hoursOpen: '09:00', hoursClose: '18:00' };
  assert.equal(isOpenNow(s, { date: '2026-11-18', time: '10:30' }), true);  // Wednesday
  assert.equal(isOpenNow(s, { date: '2026-11-18', time: '20:00' }), false); // after hours
  assert.equal(isOpenNow(s, { date: '2026-11-22', time: '10:30' }), false); // Sunday
});

test('chat history converts to API messages with merged roles', () => {
  const out = toApiMessages([
    { sender: 'ai', text: 'hello' },            // leading assistant is dropped
    { sender: 'patient', text: 'hi' },
    { sender: 'patient', text: 'book please' },  // merged with the previous user turn
    { sender: 'staff', text: 'we can help' },
  ]);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].parts[0].text, /hi\nbook please/);
  assert.equal(out[1].role, 'model');
  assert.match(out[1].parts[0].text, /\[Clinic staff\] we can help/);
});

test('system prompt shows only live offers, never drafts', () => withDb(async (db) => {
  await db.run("INSERT INTO offers (title, description, terms, active, created_at) VALUES ('Live Offer', 'Save on a visit', 'Limit one', 1, ?)", [new Date().toISOString()]);
  await db.run("INSERT INTO offers (title, description, terms, active, created_at) VALUES ('Draft Offer', 'Not ready', '', 0, ?)", [new Date().toISOString()]);
  const prompt = await buildSystemPrompt(db);
  assert.match(prompt, /Live Offer/);
  assert.doesNotMatch(prompt, /Draft Offer/);
  assert.match(prompt, /Vi, the virtual front desk/);
  assert.match(prompt, /Never diagnose/);
}));

test('website chat: fallback reply, saved messages, and visitor token', () => withDb(async (db) => {
  const first = await handlePatientMessage(db, { text: 'How much is botox?' });
  assert.ok(first.token);
  assert.match(first.reply, /confirmed at your consultation/);

  const again = await handlePatientMessage(db, { conversationId: first.conversationId, token: first.token, text: 'Where are you?' });
  assert.equal(again.conversationId, first.conversationId);

  // Wrong token starts a new conversation instead of reading the old one
  const other = await handlePatientMessage(db, { conversationId: first.conversationId, token: 'wrong', text: 'hi' });
  assert.notEqual(other.conversationId, first.conversationId);

  assert.equal(await messagesForVisitor(db, { conversationId: first.conversationId, token: 'wrong' }), null);
}));

test('emergency pauses the AI and flags the conversation', () => withDb(async (db) => {
  const r = await handlePatientMessage(db, { text: 'my face is swelling badly' });
  assert.match(r.reply, /911/);
  const conv = await db.one('SELECT ai_paused, needs_human FROM conversations WHERE id = ?', [r.conversationId]);
  assert.equal(conv.ai_paused, 1);
  assert.equal(conv.needs_human, 1);

  const paused = await handlePatientMessage(db, { conversationId: r.conversationId, token: r.token, text: 'hello?' });
  assert.equal(paused.paused, true);
  assert.equal(paused.reply, null);
}));

test('staff reply pauses the AI and reaches the visitor', () => withDb(async (db) => {
  const r = await handlePatientMessage(db, { text: 'hi' });
  await staffReply(db, r.conversationId, 'Hi, this is Ana from the clinic.');
  const msgs = await messagesForVisitor(db, { conversationId: r.conversationId, token: r.token, afterId: 0 });
  assert.ok(msgs.some((m) => m.sender === 'staff' && m.text.includes('Ana')));
  const conv = await db.one('SELECT ai_paused FROM conversations WHERE id = ?', [r.conversationId]);
  assert.equal(conv.ai_paused, 1);
}));

test('no-show and done are valid statuses; unknown statuses are rejected', () => withDb(async (db) => {
  const date = openDate();
  const slot = (await booking.availableSlots(db, date, { serviceName: 'Consultation' }))[0];
  const b = await booking.bookAppointment(db, {
    date, time: slot.time, serviceName: 'Consultation', patientName: 'No Show Test', phone: '2145551230',
  });
  await booking.setAppointmentStatus(db, b.appointmentId, 'no_show');
  assert.equal((await db.one('SELECT status FROM appointments WHERE id = ?', [b.appointmentId])).status, 'no_show');
  await booking.setAppointmentStatus(db, b.appointmentId, 'done');
  await assert.rejects(booking.setAppointmentStatus(db, b.appointmentId, 'maybe'), /Invalid status/);
}));

test('handoff reasons are saved: medical, asked-for-staff, and unclear', () => withDb(async (db) => {
  const med = await handlePatientMessage(db, { text: 'bleeding after my treatment this morning' });
  const reasonOf = async (id) => (await db.one('SELECT handoff_reason FROM conversations WHERE id = ?', [id])).handoff_reason;
  assert.equal(await reasonOf(med.conversationId), 'medical');

  const human = await handlePatientMessage(db, { text: 'can I talk to a real person please' });
  assert.equal(await reasonOf(human.conversationId), 'human_request');
  const pausedConv = await db.one('SELECT ai_paused FROM conversations WHERE id = ?', [human.conversationId]);
  assert.equal(pausedConv.ai_paused, 1);

  const unclear = await handlePatientMessage(db, { text: 'zxqv blorf' });
  assert.equal(await reasonOf(unclear.conversationId), 'unclear');
}));

test('AI bookings are counted for this week and last week', () => withDb(async (db) => {
  await seedClients(db);
  const now = Date.now();
  const insert = (createdMs, source) => db.run(
    `INSERT INTO appointments (client_id, provider_id, service_id, starts_at, ends_at, status, source, created_at)
     VALUES (1, 1, 1, '2030-01-01 10:00', '2030-01-01 10:30', 'booked', ?, ?)`,
    [source, new Date(createdMs).toISOString()]
  );
  await insert(now - 2 * 86400000, 'website'); // this week, AI
  await insert(now - 3 * 86400000, 'staff');   // this week, staff: not counted
  await insert(now - 10 * 86400000, 'website'); // last week, AI
  const count = async (from, to) => (await db.one(
    `SELECT COUNT(*) AS n FROM appointments WHERE source != 'staff' AND status = 'booked' AND created_at >= ? AND created_at < ?`,
    [new Date(from).toISOString(), new Date(to).toISOString()]
  )).n;
  assert.equal(await count(now - 7 * 86400000, now + 86400000), 1);
  assert.equal(await count(now - 14 * 86400000, now - 7 * 86400000), 1);
}));

test('queue only takes consented clients, and running it twice adds nothing new', () => withDb(async (db) => {
  const automations = require('../src/automations');
  await seedClients(db);
  const botoxId = (await db.one('SELECT id FROM services WHERE name = ?', [BOTOX])).id;
  const old = new Date(Date.now() - 240 * 86400000).toISOString().slice(0, 10);
  // Maria (client 1) and Paolo (client 2) both had Botox 8 months ago (recall every 4 months)
  for (const id of [1, 2]) {
    await db.run(
      `INSERT INTO appointments (client_id, provider_id, service_id, starts_at, ends_at, status, source, created_at)
       VALUES (?, 1, ?, ?, ?, 'done', 'staff', ?)`,
      [id, botoxId, `${old} 10:00`, `${old} 10:30`, new Date().toISOString()]
    );
  }
  await db.run("UPDATE clients SET promo_consent = 1, email = 'maria@example.com' WHERE id = 1"); // only Maria consented

  const first = await automations.prepareDrafts(db);
  assert.equal(first.recall, 1);
  const rows = await db.all('SELECT client_id, kind, body, send_at FROM outbox ORDER BY kind');
  assert.deepEqual(rows.map((r) => [r.client_id, r.kind]), [[1, 'recall'], [1, 'winback']]);
  const tomorrow = booking.addMinutes(booking.clinicNow().date, '00:00', 1440).slice(0, 10);
  assert.equal(rows[0].send_at, `${tomorrow} 10:00`);
  assert.match(rows[0].body, /^Hi Maria,/);
  assert.match(rows[0].body, /Botox/);

  const second = await automations.prepareDrafts(db);
  assert.equal(second.recall + second.winback, 0, 'same cycle must not be queued twice');
}));

test('analytics returns counts for the period', () => withDb(async (db) => {
  const { analytics } = require('../src/analytics');
  const a = await analytics(db, 30);
  assert.equal(typeof a.bookings.total, 'number');
  assert.equal(typeof a.chats.total, 'number');
  assert.ok(Array.isArray(a.weekly));
  assert.ok(a.from <= a.to);
}));

test('details form saves name, phone, email, and a consent history row', () => withDb(async (db) => {
  const { saveDetailsFromChat } = require('../src/chat');
  const r = await handlePatientMessage(db, { text: 'hi, what treatments do you have?' });
  assert.equal(r.askDetails, true, 'first message from a new visitor asks for details');

  await saveDetailsFromChat(db, {
    conversationId: r.conversationId, token: r.token,
    name: 'Ana Cruz', phone: '(214) 555-1234', email: 'Ana@Example.com', marketingConsent: true,
  });
  const conv = await db.one('SELECT client_id FROM conversations WHERE id = ?', [r.conversationId]);
  const client = await db.one('SELECT full_name, email, promo_consent FROM clients WHERE id = ?', [conv.client_id]);
  assert.equal(client.full_name, 'Ana Cruz');
  assert.equal(client.email, 'ana@example.com');
  assert.equal(client.promo_consent, 1);
  const history = await db.all('SELECT granted FROM consents WHERE client_id = ?', [conv.client_id]);
  assert.deepEqual(history.map((h) => h.granted), [1]);

  await assert.rejects(saveDetailsFromChat(db, {
    conversationId: r.conversationId, token: r.token, name: 'Ana Cruz', phone: '2145551234', email: 'not-an-email',
  }), /valid email/);
}));

test('chat and public bookings require an email address', () => withDb(async (db) => {
  const { bookFromChat } = require('../src/chat');
  const date = openDate();
  const slot = (await booking.availableSlots(db, date, { serviceName: 'Consultation' }))[0];
  const conv = await handlePatientMessage(db, { text: 'I want to book' });
  await assert.rejects(bookFromChat(db, {
    conversationId: conv.conversationId, token: conv.token, date, time: slot.time, service: 'Consultation',
    name: 'Email Less', phone: '2145553333', email: '',
  }), /valid email address/);
  const ok = await bookFromChat(db, {
    conversationId: conv.conversationId, token: conv.token, date, time: slot.time, service: 'Consultation',
    name: 'With Email', phone: '2145553333', email: 'guest@example.com',
  });
  assert.ok(ok.appointmentId);
}));

