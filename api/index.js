// Vercel entry point. Reuses the same request handler as the local server (src/server.js).
// vercel.json sends every request here with the original path in ?p=, so the server sees the real URL.
const { openDb, ensureSchema } = require('../src/db');
const { createServer } = require('../src/server');

let handler = null;

function restorePath(req) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.searchParams.get('p');
  if (p !== null) {
    u.searchParams.delete('p');
    const query = u.searchParams.toString();
    req.url = '/' + p.replace(/^\/+/, '') + (query ? '?' + query : '');
  }
}

module.exports = async (req, res) => {
  restorePath(req);
  if (!handler) {
    const db = openDb();
    await ensureSchema(db); // creates tables only if the database is empty
    const server = createServer({ db, adminPassword: process.env.ADMIN_PASSWORD || 'changeme' });
    handler = server.listeners('request')[0];
  }
  return handler(req, res);
};
