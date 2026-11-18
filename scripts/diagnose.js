// Checks each part the chat depends on, one line per check. Never prints secrets.
// Usage:  node scripts/diagnose.js                       (checks .env and the local DB)
//         node scripts/diagnose.js https://your-site.vercel.app   (also tests the live chat)
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* use real env vars */ }

const results = [];
const line = (ok, name, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const ms = (t0) => `${Date.now() - t0} ms`;

(async () => {
  // 1. Environment (names and lengths only)
  for (const k of ['DATABASE_URL', 'ADMIN_PASSWORD', 'GEMINI_API_KEY']) {
    line(Boolean(process.env[k]), `env ${k}`, process.env[k] ? `set (${process.env[k].length} chars)` : 'MISSING');
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log(`      model: ${model}`);

  // 2. Database
  if (process.env.DATABASE_URL) {
    const { openDb } = require('../src/db');
    const db = openDb();
    try {
      const t0 = Date.now();
      await db.one('SELECT 1 AS ok');
      line(true, 'database connect + query', ms(t0));
      const t1 = Date.now();
      const s = await db.all('SELECT name FROM services WHERE active = 1');
      line(s.length > 0, 'treatments in database', `${s.length} active, ${ms(t1)}`);
      const t2 = Date.now();
      await db.all('SELECT key FROM settings');
      line(true, 'settings query', ms(t2));
    } catch (e) {
      line(false, 'database', e.message);
    } finally {
      await db.close();
    }
  }

  // 3. Gemini: is the key accepted, and does the model answer?
  if (process.env.GEMINI_API_KEY) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the word ok.' }] }], generationConfig: { maxOutputTokens: 10 } }),
      });
      const body = await r.text();
      const hint = r.status === 403 ? ' (key disabled or leaked: create a new key)'
        : r.status === 404 ? ' (model name not available: change GEMINI_MODEL)'
        : r.status === 429 ? ' (rate or quota limit reached)' : '';
      line(r.ok, 'Gemini API', `HTTP ${r.status}, ${ms(t0)}${hint}`);
      if (!r.ok) console.log('      ' + body.replace(/\s+/g, ' ').slice(0, 160));
    } catch (e) {
      line(false, 'Gemini API', `network error: ${e.message}`);
    }
  }

  // 4. The site's own chat, if a URL was given
  const base = process.argv[2];
  if (base) {
    const t0 = Date.now();
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello (diagnostic check)' }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await r.json().catch(() => ({}));
      const reply = data.reply || data.error || '';
      line(r.ok && Boolean(data.reply), 'live chat reply', `HTTP ${r.status}, ${ms(t0)}`);
      console.log(`      reply: ${String(reply).slice(0, 120)}`);
    } catch (e) {
      line(false, 'live chat reply', `no answer after ${ms(t0)}: ${e.name === 'TimeoutError' ? 'timed out at 30 s' : e.message}`);
    }
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
