// Vercel entry point. Reuses the same request handler as the local server (src/server.js).
const { openDb, ensureSchema } = require('../src/db');
const { createServer } = require('../src/server');

let handler = null;

module.exports = async (req, res) => {
  if (!handler) {
    const db = openDb();
    await ensureSchema(db); // creates tables only if the database is empty
    const server = createServer({ db, adminPassword: process.env.ADMIN_PASSWORD || 'changeme' });
    handler = server.listeners('request')[0];
  }
  return handler(req, res);
};
