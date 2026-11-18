const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, ensureSchema, getSettings } = require('./db');
const booking = require('./booking');
const { handlePatientMessage, staffReply, messagesForVisitor, bookFromChat, saveDetailsFromChat, saveClientDetails, cleanEmail } = require('./chat');
const preeval = require('./preeval');
const automations = require('./automations');
const { analytics } = require('./analytics');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;
// Sessions live in the database (table `sessions`), so every server copy sees the same login.
// Only a SHA-256 hash of the cookie value is stored.
const SECURE_COOKIE = process.env.VERCEL ? '; Secure' : ''; // Vercel serves over HTTPS
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Validates an offer from the admin form. Offers are only shown (and only mentioned by the AI) when active.
function cleanOffer(body) {
  const title = String(body.title || '').trim().slice(0, 120);
  if (title.length < 3) throw httpError(400, 'Offer title must be at least 3 characters');
  const order = Number(body.sort_order || 0);
  return {
    title,
    description: String(body.description || '').trim().slice(0, 400),
    terms: String(body.terms || '').trim().slice(0, 400),
    active: body.active ? 1 : 0,
    sort_order: Number.isInteger(order) ? order : 0,
  };
}

function createServer({ db, adminPassword }) {
  const routes = [];
  const route = (method, pattern, handler, { auth = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  // ---- Public API (website) ----
  route('GET', '/api/public/info', async () => {
    const s = await getSettings(db);
    const services = await db.all('SELECT id, name, duration_min, price, description, category, image, details FROM services WHERE active = 1 ORDER BY name');
    const providers = await db.all('SELECT id, name FROM providers WHERE active = 1 ORDER BY name');
    return { clinic: { name: s.clinicName, address: s.clinicAddress, phone: s.clinicPhone, hours: `${s.hoursOpen} - ${s.hoursClose}`, openDays: s.openDays }, services, providers };
  });

  route('GET', '/api/public/availability', async (req, params, query) => {
    const slots = await booking.availableSlots(db, query.get('date') || '', {
      serviceName: query.get('service') || '',
      providerId: null,
    });
    return { slots: slots.map((s) => ({ time: s.time, provider: s.providerName })) };
  });

  route('POST', '/api/chat', async (req, params, query, body) => {
    return handlePatientMessage(db, {
      conversationId: body.conversationId,
      token: body.token,
      text: body.message,
      channel: 'website',
    });
  });

  route('POST', '/api/chat/:id/book', async (req, params, query, body) => {
    try {
      const appt = await bookFromChat(db, {
        conversationId: params.id,
        token: body.token,
        date: body.date,
        time: body.time,
        service: body.service,
        name: body.name,
        phone: body.phone,
        email: body.email,
        marketingConsent: body.marketingConsent,
      });
      return { ok: true, appointment: appt };
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(400, err.message);
      throw err;
    }
  });

  // Details form in the chat (name, phone, email, consent)
  route('POST', '/api/chat/:id/details', async (req, params, query, body) => {
    try {
      await saveDetailsFromChat(db, {
        conversationId: params.id,
        token: body.token,
        name: body.name,
        phone: body.phone,
        email: body.email,
        marketingConsent: body.marketingConsent,
      });
      return { ok: true, message: 'Thank you. Your details are saved.' };
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(400, err.message);
      throw err;
    }
  });

  // Pre-evaluation from the homepage funnel: saves the answers, opens a chat with a recap
  route('POST', '/api/preeval', async (req, params, query, body) => {
    try {
      return await preeval.submit(db, body);
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(400, err.message);
      throw err;
    }
  });

  // Booking from the /book-now page (no chat needed). Same calendar and rules as everything else.
  route('POST', '/api/public/book', async (req, params, query, body) => {
    try {
      const appt = await booking.bookAppointment(db, {
        date: body.date, time: body.time, serviceName: body.service,
        patientName: body.name, phone: body.phone, source: 'website',
      });
      const mail = cleanEmail(body.email);
      if (!mail) throw httpError(400, 'Please enter a valid email address to book.');
      if (mail || body.marketingConsent) {
        await saveClientDetails(db, appt.clientId, { email: mail, marketingConsent: Boolean(body.marketingConsent), source: 'website' });
      }
      return { ok: true, appointment: appt };
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(400, err.message);
      throw err;
    }
  });

  route('GET', '/api/chat/:id/messages', async (req, params, query) => {
    const msgs = await messagesForVisitor(db, {
      conversationId: params.id,
      token: query.get('token'),
      afterId: query.get('after'),
    });
    if (msgs === null) throw httpError(404, 'Conversation not found');
    return { messages: msgs };
  });

  route('GET', '/api/public/offers', async () => ({
    offers: await db.all(
      'SELECT id, title, description, terms FROM offers WHERE active = 1 ORDER BY sort_order, id'
    ),
  }));

  // ---- Admin login ----
  route('POST', '/api/admin/login', async (req, params, query, body) => {
    const given = Buffer.from(String(body.password || ''));
    const want = Buffer.from(adminPassword);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw httpError(401, 'Wrong password');
    }
    const token = crypto.randomBytes(24).toString('hex');
    const now = new Date();
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now.toISOString()]);
    await db.run('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)',
      [hashToken(token), new Date(now.getTime() + SESSION_MS).toISOString(), now.toISOString()]);
    return [{ ok: true }, { 'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE}` }];
  });
  route('POST', '/api/admin/logout', async (req) => {
    const token = getCookie(req, 'admin_session');
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
    return [{ ok: true }, { 'Set-Cookie': `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE_COOKIE}` }];
  });
  route('GET', '/api/admin/me', async (req) => ({ authed: await isAuthed(req) }));

  // ---- Admin API ----
  route('GET', '/api/admin/meta', async () => ({
    aiEnabled: Boolean(process.env.GEMINI_API_KEY),
    settings: await getSettings(db),
    services: await db.all('SELECT id, name, duration_min, price FROM services WHERE active = 1 ORDER BY name'),
    providers: await db.all('SELECT id, name FROM providers WHERE active = 1 ORDER BY name'),
  }), { auth: true });

  // ---- Clinic details (location, contact, hours, assistant). Saved in the settings table. ----
  const SETTING_KEYS = {
    clinicName: 'clinic_name', clinicAddress: 'clinic_address', clinicPhone: 'clinic_phone',
    hoursOpen: 'hours_open', hoursClose: 'hours_close', assistantName: 'assistant_name',
    bookingUrl: 'booking_url', aiInstructions: 'ai_instructions',
  };
  route('PATCH', '/api/admin/settings', async (req, params, query, body) => {
    const clean = {};
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      if (body[field] === undefined) continue;
      const v = String(body[field]).trim();
      if (['clinicName', 'clinicAddress', 'assistantName'].includes(field) && v.length < 2) {
        throw httpError(400, `${field} must be at least 2 characters`);
      }
      if (['hoursOpen', 'hoursClose'].includes(field) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
        throw httpError(400, 'Hours must be HH:MM (24-hour)');
      }
      if (field === 'bookingUrl' && v && !/^https:\/\//.test(v)) throw httpError(400, 'Booking link must start with https://');
      clean[key] = v.slice(0, 500);
    }
    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(clean)) {
        await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
      }
    });
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/dashboard', async () => {
    const now = booking.clinicNow();
    const todayAppts = (await booking.listAppointments(db, now.date, booking.addMinutes(now.date, '00:00', 1440).slice(0, 10)))
      .filter((a) => a.status === 'booked');
    // AI bookings in the last 7 days vs the 7 days before (by when they were made)
    const DAY = 86400000;
    const nowMs = Date.now();
    const countAiBooked = async (fromMs, toMs) => (await db.one(
      `SELECT COUNT(*) AS n FROM appointments WHERE source != 'staff' AND status = 'booked' AND created_at >= ? AND created_at < ?`,
      [new Date(fromMs).toISOString(), new Date(toMs).toISOString()]
    )).n;
    const aiBookedWeek = await countAiBooked(nowMs - 7 * DAY, nowMs + DAY);
    const aiBookedPrev = await countAiBooked(nowMs - 14 * DAY, nowMs - 7 * DAY);

    // No-show rate this month: no-shows out of (completed + no-shows)
    const monthStart = `${now.date.slice(0, 8)}01 00:00`;
    const monthCounts = await db.one(
      `SELECT SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM appointments WHERE starts_at >= ? AND starts_at < ?`,
      [monthStart, `${now.date} 23:59`]
    );
    const noShows = Number(monthCounts.no_show) || 0;
    const attended = noShows + (Number(monthCounts.done) || 0);
    const noShowRate = attended ? Math.round((noShows / attended) * 1000) / 10 : null;

    const waiting = (await db.one('SELECT COUNT(*) AS n FROM conversations WHERE needs_human = 1')).n;
    const needsHuman = await db.all(
      `SELECT c.id, c.channel, c.last_message_at, c.handoff_reason, cl.full_name
       FROM conversations c LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE c.needs_human = 1 ORDER BY c.last_message_at DESC LIMIT 5`
    );
    const clientsTotal = (await db.one('SELECT COUNT(*) AS n FROM clients')).n;
    const aiActivity = await db.all(
      `SELECT m.conversation_id, m.sender, m.text, m.created_at, cl.full_name
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       WHERE m.sender IN ('ai', 'staff') ORDER BY m.id DESC LIMIT 8`
    );
    const dueCount = (await automations.dueForRecall(db)).length;
    const celebrationsCount = (await automations.upcomingCelebrations(db, 7)).length;
    return {
      today: now.date,
      clientsTotal,
      aiActivity,
      todayCount: todayAppts.length,
      todayAppointments: todayAppts,
      aiBookedWeek,
      aiBookedPrev,
      noShowRate,
      waiting,
      needsHuman,
      dueCount,
      celebrationsCount,
    };
  }, { auth: true });

  // ---- AI automations (lists only; sending needs a channel) ----
  route('GET', '/api/admin/automations', async () => {
    const s = await getSettings(db);
    const services = await db.all(
      'SELECT id, name, recall_months, aftercare, description FROM services WHERE active = 1 ORDER BY name'
    );
    const clients = await db.all(
      'SELECT id, full_name, birthday, promo_consent, email FROM clients ORDER BY full_name LIMIT 300'
    );
    return {
      smsConnected: false,
      winbackDays: s.winbackDays,
      services,
      recall: await automations.dueForRecall(db),
      winback: await automations.lapsedClients(db, s.winbackDays),
      celebrations: await automations.upcomingCelebrations(db, 14),
      clients,
    };
  }, { auth: true });

  route('PATCH', '/api/admin/services/:id', async (req, params, query, body) => {
    const id = Number(params.id);
    if (!(await db.one('SELECT id FROM services WHERE id = ?', [id]))) throw httpError(404, 'Service not found');
    const months = body.recall_months === null || body.recall_months === '' ? null : Number(body.recall_months);
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 60)) {
      throw httpError(400, 'Reminder interval must be 1 to 60 months, or empty for none');
    }
    const aftercare = String(body.aftercare || '').slice(0, 1000);
    const description = body.description === undefined ? null : String(body.description).trim().slice(0, 500);
    await db.run(
      'UPDATE services SET recall_months = ?, aftercare = ?, description = COALESCE(?, description) WHERE id = ?',
      [months, aftercare, description, id]
    );
    return { ok: true };
  }, { auth: true });

  route('PATCH', '/api/admin/clients/:id/profile', async (req, params, query, body) => {
    const id = Number(params.id);
    const client = await db.one('SELECT id, promo_consent FROM clients WHERE id = ?', [id]);
    if (!client) throw httpError(404, 'Client not found');
    const birthday = body.birthday ? String(body.birthday) : null;
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw httpError(400, 'Birthday must be YYYY-MM-DD');
    const consent = body.promo_consent ? 1 : 0;
    const email = body.email === undefined ? undefined : cleanEmail(body.email);
    if (body.email && !email) throw httpError(400, 'Please enter a valid email address, or leave it blank');
    await db.transaction(async (tx) => {
      await tx.run(
        'UPDATE clients SET birthday = ?, promo_consent = ?, email = COALESCE(?, email) WHERE id = ?',
        [birthday, consent, email === undefined ? null : (email || null), id]
      );
      // Keep a history row each time consent changes, so the clinic can show when it was given or withdrawn
      if (client.promo_consent !== consent) {
        await tx.run(
          'INSERT INTO consents (client_id, kind, granted, source, created_at) VALUES (?, ?, ?, ?, ?)',
          [id, 'marketing', consent, 'staff', new Date().toISOString()]
        );
      }
    });
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/clients/:id/consents', async (req, params) => {
    return {
      consents: await db.all(
        'SELECT kind, granted, source, created_at FROM consents WHERE client_id = ? ORDER BY id DESC',
        [Number(params.id)]
      ),
    };
  }, { auth: true });

  // ---- Message queue and templates (nothing is sent until a channel is connected) ----
  route('POST', '/api/admin/automations/prepare', async () => {
    return { created: await automations.prepareDrafts(db) };
  }, { auth: true });

  route('GET', '/api/admin/outbox', async (req, params, query) => {
    const status = query.get('status') || 'queued';
    return {
      messages: await automations.listOutbox(db, status),
      counts: await automations.outboxCounts(db),
    };
  }, { auth: true });

  route('PATCH', '/api/admin/outbox/:id', async (req, params, query, body) => {
    if (body.status !== 'cancelled') throw httpError(400, 'Only cancelling a queued message is allowed here');
    const r = await db.run("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'", [Number(params.id)]);
    if (r.changes === 0) throw httpError(404, 'Queued message not found');
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/templates', async () => ({
    templates: await db.all('SELECT kind, body FROM message_templates ORDER BY kind'),
  }), { auth: true });

  route('PATCH', '/api/admin/templates/:kind', async (req, params, query, body) => {
    const text = String(body.body || '').trim();
    if (!text || text.length > 500) throw httpError(400, 'Template must be 1 to 500 characters');
    const r = await db.run('UPDATE message_templates SET body = ? WHERE kind = ?', [text, params.kind]);
    if (r.changes === 0) throw httpError(404, 'Template not found');
    return { ok: true };
  }, { auth: true });

  // ---- Treatment menu (admin): booking length, price text, and on/off. Changes apply to new bookings. ----
  route('GET', '/api/admin/services', async () => ({
    services: await db.all('SELECT id, name, category, duration_min, price, active FROM services ORDER BY category, name'),
  }), { auth: true });

  route('PATCH', '/api/admin/services/:id/menu', async (req, params, query, body) => {
    const dur = Number(body.duration_min);
    if (!Number.isInteger(dur) || dur < 15 || dur > 240 || dur % 5 !== 0) {
      throw httpError(400, 'Duration must be 15 to 240 minutes, in steps of 5');
    }
    const price = String(body.price || '').trim().slice(0, 80);
    const r = await db.run('UPDATE services SET duration_min = ?, price = ?, active = ? WHERE id = ?',
      [dur, price, body.active ? 1 : 0, Number(params.id)]);
    if (r.changes === 0) throw httpError(404, 'Treatment not found');
    return { ok: true };
  }, { auth: true });

  // ---- Offers (promotions the website and the AI receptionist can mention) ----
  route('GET', '/api/admin/offers', async () => ({
    offers: await db.all('SELECT * FROM offers ORDER BY sort_order, id'),
  }), { auth: true });

  route('POST', '/api/admin/offers', async (req, params, query, body) => {
    const offer = cleanOffer(body);
    const id = await db.insert(
      'INSERT INTO offers (title, description, terms, active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [offer.title, offer.description, offer.terms, offer.active, offer.sort_order, new Date().toISOString()]
    );
    return { ok: true, id };
  }, { auth: true });

  route('PATCH', '/api/admin/offers/:id', async (req, params, query, body) => {
    const offer = cleanOffer(body);
    const r = await db.run(
      'UPDATE offers SET title = ?, description = ?, terms = ?, active = ?, sort_order = ? WHERE id = ?',
      [offer.title, offer.description, offer.terms, offer.active, offer.sort_order, Number(params.id)]
    );
    if (r.changes === 0) throw httpError(404, 'Offer not found');
    return { ok: true };
  }, { auth: true });

  route('DELETE', '/api/admin/offers/:id', async (req, params) => {
    await db.run('DELETE FROM offers WHERE id = ?', [Number(params.id)]);
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/analytics', async (req, params, query) => {
    const days = [7, 30, 90, 365].includes(Number(query.get('days'))) ? Number(query.get('days')) : 90;
    return analytics(db, days);
  }, { auth: true });

  route('PATCH', '/api/admin/automations/settings', async (req, params, query, body) => {
    const days = Number(body.winback_days);
    if (!Number.isInteger(days) || days < 30 || days > 730) throw httpError(400, 'Win-back days must be 30 to 730');
    await db.run("UPDATE settings SET value = ? WHERE key = 'winback_days'", [String(days)]);
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/report', async (req, params, query) => {
    const days = Math.min(Math.max(Number(query.get('days')) || 7, 1), 90);
    return automations.weeklyReport(db, days);
  }, { auth: true });

  route('GET', '/api/admin/appointments', async (req, params, query) => {
    const from = query.get('from') || booking.clinicNow().date;
    const to = query.get('to') || booking.addMinutes(from, '00:00', 7 * 1440).slice(0, 10);
    if (!booking.isValidDate(from) || !booking.isValidDate(to)) throw httpError(400, 'Invalid date range');
    return { appointments: await booking.listAppointments(db, from, to) };
  }, { auth: true });

  route('POST', '/api/admin/appointments', async (req, params, query, body) => {
    try {
      const result = await booking.bookAppointment(db, {
        date: body.date,
        time: body.time,
        serviceName: body.service,
        providerName: body.provider,
        patientName: body.patient_name,
        phone: body.phone,
        source: 'staff',
      });
      return { booked: true, ...result };
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(409, err.message);
      throw err;
    }
  }, { auth: true });

  route('PATCH', '/api/admin/appointments/:id', async (req, params, query, body) => {
    try {
      await booking.setAppointmentStatus(db, Number(params.id), body.status);
      return { ok: true };
    } catch (err) {
      if (err instanceof booking.BookingError) throw httpError(400, err.message);
      throw err;
    }
  }, { auth: true });

  route('GET', '/api/admin/clients', async (req, params, query) => {
    const q = `%${(query.get('q') || '').trim()}%`;
    const clients = await db.all(
      `SELECT c.id, c.full_name, c.phone,
              (SELECT MAX(starts_at) FROM appointments a WHERE a.client_id = c.id AND a.status = 'booked' AND a.starts_at < ?) AS last_visit,
              (SELECT MIN(starts_at) FROM appointments a WHERE a.client_id = c.id AND a.status = 'booked' AND a.starts_at >= ?) AS next_appt,
              (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id AND a.status = 'booked') AS visits
       FROM clients c WHERE c.full_name ILIKE ? OR c.phone LIKE ? ORDER BY c.full_name LIMIT 200`,
      [nowLocal(), nowLocal(), q, q]
    );
    return { clients };
  }, { auth: true });

  route('GET', '/api/admin/clients/:id', async (req, params) => {
    const client = await db.one('SELECT id, full_name, phone, email, notes, created_at FROM clients WHERE id = ?', [Number(params.id)]);
    if (!client) throw httpError(404, 'Client not found');
    const appointments = await db.all(
      `SELECT a.id, a.starts_at, a.status, a.source, s.name AS service_name, d.name AS provider_name
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN providers d ON d.id = a.provider_id
       WHERE a.client_id = ? ORDER BY a.starts_at DESC`,
      [client.id]
    );
    const conv = await db.one('SELECT id FROM conversations WHERE client_id = ? ORDER BY id DESC LIMIT 1', [client.id]);
    return { client, appointments, conversationId: conv ? conv.id : null };
  }, { auth: true });

  // Deletes a client, their appointments, and unlinks their chats (chats are kept).
  route('DELETE', '/api/admin/clients/:id', async (req, params) => {
    const id = Number(params.id);
    if (!(await db.one('SELECT id FROM clients WHERE id = ?', [id]))) throw httpError(404, 'Client not found');
    await db.transaction(async (tx) => {
      await tx.run('UPDATE conversations SET client_id = NULL WHERE client_id = ?', [id]);
      await tx.run('DELETE FROM appointments WHERE client_id = ?', [id]);
      await tx.run('DELETE FROM clients WHERE id = ?', [id]);
    });
    return { ok: true };
  }, { auth: true });

  route('GET', '/api/admin/conversations', async () => {
    const conversations = await db.all(
      `SELECT c.id, c.channel, c.ai_paused, c.needs_human, c.last_message_at, cl.full_name,
              (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text
       FROM conversations c LEFT JOIN clients cl ON cl.id = c.client_id
       ORDER BY c.last_message_at DESC LIMIT 100`
    );
    return { conversations };
  }, { auth: true });

  route('GET', '/api/admin/conversations/:id', async (req, params) => {
    const conv = await db.one(
      'SELECT c.*, cl.full_name, cl.phone FROM conversations c LEFT JOIN clients cl ON cl.id = c.client_id WHERE c.id = ?',
      [Number(params.id)]
    );
    if (!conv) throw httpError(404, 'Conversation not found');
    const messages = await db.all(
      'SELECT id, direction, sender, text, created_at FROM messages WHERE conversation_id = ? ORDER BY id',
      [conv.id]
    );
    return { conversation: { id: conv.id, channel: conv.channel, ai_paused: conv.ai_paused, needs_human: conv.needs_human, full_name: conv.full_name, phone: conv.phone }, messages };
  }, { auth: true });

  route('POST', '/api/admin/conversations/:id/reply', async (req, params, query, body) => {
    await staffReply(db, Number(params.id), body.text);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/admin/conversations/:id/pause', async (req, params) => {
    await db.run('UPDATE conversations SET ai_paused = 1 WHERE id = ?', [Number(params.id)]);
    return { ok: true };
  }, { auth: true });

  route('POST', '/api/admin/conversations/:id/resume', async (req, params) => {
    await db.run("UPDATE conversations SET ai_paused = 0, needs_human = 0, handoff_reason = '' WHERE id = ?", [Number(params.id)]);
    return { ok: true };
  }, { auth: true });

  // Deletes the chat and its messages. The client record is kept.
  route('DELETE', '/api/admin/conversations/:id', async (req, params) => {
    const id = Number(params.id);
    if (!(await db.one('SELECT id FROM conversations WHERE id = ?', [id]))) throw httpError(404, 'Conversation not found');
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM messages WHERE conversation_id = ?', [id]);
      await tx.run('DELETE FROM conversations WHERE id = ?', [id]);
    });
    return { ok: true };
  }, { auth: true });

  async function isAuthed(req) {
    const token = getCookie(req, 'admin_session');
    if (!token) return false;
    const row = await db.one('SELECT expires_at FROM sessions WHERE token_hash = ?', [hashToken(token)]);
    return Boolean(row) && row.expires_at > new Date().toISOString();
  }

  // ---- HTTP plumbing ----
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Server error' : err.message });
    }
  });

  async function handleApi(req, res, url) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (r.auth && !(await isAuthed(req))) throw httpError(401, 'Please log in');
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : {};
      const result = await r.handler(req, params, url.searchParams, body);
      // handlers may return [data, headers]
      const [data, headers] = Array.isArray(result) ? result : [result, {}];
      return sendJson(res, 200, data, headers);
    }
    throw httpError(404, 'Not found');
  }

  function serveStatic(req, res, url) {
    let p = url.pathname;
    if (p === '/' || p === '/index.html') p = '/index.html';
    else if (p === '/admin' || p === '/admin/') p = '/admin.html';
    else if (p === '/talk' || p === '/talk/') p = '/talk.html';
    else if (p === '/book-now' || p === '/book-now/') p = '/book-now.html';
    else if (p.startsWith('/services/')) p = '/service.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }
}

// Clinic-local "YYYY-MM-DD HH:MM" for comparing with stored times
function nowLocal() {
  const n = booking.clinicNow();
  return `${n.date} ${n.time}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function start({ port = 3000 } = {}) {
  const db = openDb();
  const created = await ensureSchema(db);
  if (created) console.log('Created the database tables and sample data.');
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme';
  if (!process.env.ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD not set, using the default "changeme". Set it before going live.');
  if (!process.env.GEMINI_API_KEY) console.warn('[warn] GEMINI_API_KEY not set, the AI runs in basic fallback mode (no booking).');
  const server = createServer({ db, adminPassword });
  server.listen(port, () => console.log(`Clinic app running at http://localhost:${port}  (admin: /admin)`));
  return server;
}

module.exports = { createServer, start };
