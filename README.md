# VIBEology Medspa: website and AI receptionist

Public website (layout modeled on a med spa site, in the VIBEology brand palette) plus a 24/7 AI receptionist, "Vi", with a staff admin. Built from the DENTAL clinic app.

## Setup
1. Create a Supabase (or any Postgres) database. Put its connection string in `.env`:
   ```
   DATABASE_URL=postgresql://...        (session/transaction pooler)
   GEMINI_API_KEY=...                   (optional; without it Vi only answers basic questions and cannot book)
   GEMINI_MODEL=gemini-3.5-flash        (optional)
   ADMIN_PASSWORD=choose-a-strong-one
   ASSISTANT_NAME=Vi                    (optional, or change in settings table)
   ```
2. `npm install`, then `npm start`. Tables and starter data are created on first run (`supabase/schema.sql`).
3. Website: `/`. Staff admin: `/admin`.

## Before going live: confirm these with the client
- **Clinic hours and open days** (placeholders: Mon-Sat 09:00-18:00, `settings` table).
- **Treatment durations** (estimates) and whether each treatment needs a consultation first.
- **Offers**: none are live. Add them in Admin > Offers. Only Live offers appear on the site and in Vi's answers.
- **Booking**: the built-in calendar is used. `booking_url` (Jane App) is shared only if a guest asks to book themselves. Clear it in `settings` to stop sharing it.
- **Testimonials**: the two on the site are taken from the client's own website. Get permission before publishing.
- **Medical review**: have the medical director review the emergency wording and the rules in `src/ai.js`. Prescription services (HRT, weight loss, peptides, IV, sexual health) are routed to a provider consultation.
- **Privacy and compliance**: confirm HIPAA and vendor agreements (hosting, database, Gemini API) before storing patient health details. Add a privacy policy and SMS terms; the footer links are placeholders.
- **Photos**: the site uses no stock photos. Add the client's own images.

## Tests
`npm test` runs against a real Postgres (`DATABASE_URL`, session pooler on port 5432). It uses a throwaway schema.

## Files
- `src/ai.js`: receptionist persona, offers, medical guardrails, tools (availability, booking)
- `src/booking.js`: Central time, US phone rules, double-booking lock
- `src/chat.js`, `src/server.js`: chat API, consent history, admin API (incl. offers)
- `public/index.html`: website and chat widget
- `public/admin.html`: staff admin (dashboard, calendar, inbox, clients, offers, automations, analytics)
- `supabase/schema.sql`: tables and starter data
