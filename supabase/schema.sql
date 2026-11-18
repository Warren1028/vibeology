-- VIBEology Medspa: database schema and starter data (Supabase / Postgres)
-- Safe to run more than once: tables use IF NOT EXISTS and seed rows use ON CONFLICT DO NOTHING.
-- Timestamps are stored as text in the same formats the app uses:
--   starts_at / ends_at : 'YYYY-MM-DD HH:MM' (clinic time, America/Chicago)
--   created_at, last_message_at : ISO 8601 (UTC)

create table if not exists services (
  id            bigserial primary key,
  name          text not null unique,
  duration_min  integer not null,
  price         text not null default '',
  active        integer not null default 1,
  recall_months integer,                       -- null = no reminder for this treatment
  aftercare     text not null default '',
  description   text not null default ''       -- shown to guests in the chat and on the website
);
alter table services add column if not exists category text not null default 'Treatments';

create table if not exists providers (
  id     bigserial primary key,
  name   text not null unique,
  active integer not null default 1
);

create table if not exists clients (
  id            bigserial primary key,
  full_name     text not null,
  phone         text unique,
  email         text,
  notes         text not null default '',
  created_at    text not null,
  birthday      text,                          -- YYYY-MM-DD, optional
  promo_consent integer not null default 0
);

create table if not exists appointments (
  id          bigserial primary key,
  client_id   bigint not null references clients(id),
  provider_id bigint not null references providers(id),
  service_id  bigint not null references services(id),
  starts_at   text not null,
  ends_at     text not null,
  status      text not null default 'booked',  -- booked | done | no_show | cancelled
  source      text not null default 'staff',   -- website | chat | staff | ai
  created_at  text not null
);
create index if not exists idx_appt_provider_time on appointments (provider_id, starts_at);
create index if not exists idx_appt_client on appointments (client_id);

create table if not exists conversations (
  id              bigserial primary key,
  token           text not null default '',    -- secret the visitor's browser keeps
  channel         text not null default 'website',
  client_id       bigint references clients(id),
  ai_paused       integer not null default 0,
  needs_human     integer not null default 0,
  handoff_reason  text not null default '',
  last_message_at text not null,
  created_at      text not null
);

create table if not exists messages (
  id              bigserial primary key,
  conversation_id bigint not null references conversations(id),
  direction       text not null,               -- in | out
  sender          text not null,               -- patient | ai | staff
  text            text not null,
  created_at      text not null
);
create index if not exists idx_messages_conv on messages (conversation_id, id);

create table if not exists settings (
  key   text primary key,
  value text not null
);

-- Consent history: one row per change, so the clinic can show what a guest agreed to and when.
create table if not exists consents (
  id         bigserial primary key,
  client_id  bigint not null references clients(id),
  kind       text not null,                    -- marketing (offers, win-back, birthdays) | reminder (recall visits)
  granted    integer not null,                 -- 1 = agreed, 0 = withdrew
  source     text not null default 'staff',    -- staff | website | email
  created_at text not null
);
create index if not exists idx_consents_client on consents (client_id, kind);

-- Promotions the website and the AI receptionist can mention. Only active offers are ever shown.
create table if not exists offers (
  id          bigserial primary key,
  title       text not null,
  description text not null default '',
  terms       text not null default '',
  active      integer not null default 0,      -- 0 = draft (never shown), 1 = live
  sort_order  integer not null default 0,
  created_at  text not null
);

-- Message templates, one per automation. Placeholders: {first_name} {service} {clinic} {clinic_phone} {years}
create table if not exists message_templates (
  kind text primary key,                       -- recall | winback | birthday | anniversary
  body text not null
);

-- Message queue. Nothing is sent from here until a channel (SMS or email) is connected.
create table if not exists outbox (
  id         bigserial primary key,
  client_id  bigint not null references clients(id),
  kind       text not null,
  ref        text not null,                    -- de-duplicates: one message per client, kind and cycle
  channel    text not null default 'sms',
  body       text not null,
  status     text not null default 'queued',  -- queued | sent | failed | cancelled
  created_at text not null,
  send_at    text,                             -- clinic time, 'YYYY-MM-DD HH:MM'
  unique (client_id, kind, ref)
);
create index if not exists idx_outbox_status on outbox (status);

-- Admin login sessions. Stored here so every server copy (for example on Vercel) can see them.
-- Only a hash of the cookie value is stored, never the cookie itself.
create table if not exists sessions (
  token_hash text primary key,
  expires_at text not null,
  created_at text not null
);

-- Row-level security: the public anon key cannot read or write these tables.
-- The server uses the service_role key, which bypasses RLS.
alter table services          enable row level security;
alter table providers         enable row level security;
alter table clients           enable row level security;
alter table appointments      enable row level security;
alter table conversations     enable row level security;
alter table messages          enable row level security;
alter table settings          enable row level security;
alter table consents          enable row level security;
alter table offers            enable row level security;
alter table message_templates enable row level security;
alter table outbox            enable row level security;
alter table sessions          enable row level security;

-- ---------- Starter data (confirm every value in the admin before going live) ----------
-- Durations are estimates. Prices are blank, so the chat says "confirmed at your consultation".
-- Clinic hours and open days are placeholders until the clinic confirms them.
insert into services (name, duration_min, price, recall_months, aftercare, description, category) values
  ('Consultation',                    30,  '', null, '', 'Meet a provider to talk through your goals, your options, and whether a treatment is right for you. The best first step.', 'Start here'),
  ('Botox / Dysport / Letybo',        30,  '', 4,    '', 'Neurotoxin injections that soften expression lines. The provider chooses the product and amount at your visit.', 'Injectables'),
  ('Skin Boosters',                   45,  '', null, '', 'Hydrating injections that improve skin quality and glow. The provider recommends the plan for your skin.', 'Injectables'),
  ('Bio-Stimulators',                 60,  '', null, '', 'Injectables that support natural collagen over time. Results build gradually. The provider explains what to expect.', 'Injectables'),
  ('Dermal Fillers',                  60,  '', null, '', 'Filler to restore volume or smooth lines. The provider explains the options and risks at your consultation.', 'Fillers & Contouring'),
  ('Lip Filler',                      45,  '', null, '', 'Filler to add shape and fullness to the lips, planned around your features.', 'Fillers & Contouring'),
  ('Tear Trough Filler',              45,  '', null, '', 'Filler for the under-eye area. Your provider will check whether it suits you at your consultation.', 'Fillers & Contouring'),
  ('Cheek & Jawline Contouring',      60,  '', null, '', 'Filler to define the cheeks or jawline for a balanced, natural look.', 'Fillers & Contouring'),
  ('RHA Redensity / Skinvive',        60,  '', null, '', 'Specialty fillers and skin treatments for hydration, fine lines, and texture.', 'Fillers & Contouring'),
  ('Sculptra',                        60,  '', null, '', 'A collagen-stimulating treatment that restores volume gradually over several visits.', 'Fillers & Contouring'),
  ('Radiesse',                        60,  '', null, '', 'A volumizing filler that also supports collagen. The provider explains the plan at your consultation.', 'Fillers & Contouring'),
  ('PRP / PRF Injections',            60,  '', null, '', 'Injections made from your own blood plasma to support skin renewal. Your provider will confirm it suits you.', 'Skin'),
  ('Microneedling',                   60,  '', null, '', 'Controlled micro-channels that help the skin renew its texture and tone.', 'Skin'),
  ('Chemical Peels',                  45,  '', null, '', 'Chemical exfoliation to improve texture and tone. The provider recommends the right strength for your skin.', 'Skin'),
  ('Skin Rejuvenation',               60,  '', null, '', 'A customized treatment to refresh skin quality and radiance.', 'Skin'),
  ('Non-Surgical BBL',                90,  '', null, '', 'A non-surgical body contouring treatment. The provider reviews your goals and suitability at your consultation.', 'Body'),
  ('Hair Restoration',                60,  '', null, '', 'Treatments to support fuller-looking hair. A provider reviews your history at your consultation.', 'Hair'),
  ('Hormone Replacement Therapy',     60,  '', null, '', 'Medically supervised hormone care. A licensed provider reviews your history and labs before anything is prescribed.', 'Wellness & Hormones'),
  ('Weight Loss Program',             45,  '', null, '', 'A medically supervised weight loss program. A licensed provider reviews your health history at your consultation.', 'Wellness & Hormones'),
  ('Peptide Therapy',                 30,  '', null, '', 'Medically supervised peptide therapy. A licensed provider reviews whether it is appropriate for you.', 'Wellness & Hormones'),
  ('IV Therapy',                      60,  '', null, '', 'IV hydration and nutrient therapy, reviewed by a provider before your first session.', 'Wellness & Hormones'),
  ('Sexual Health',                   45,  '', null, '', 'Medically supervised sexual health care. A licensed provider reviews your history privately at your consultation.', 'Wellness & Hormones')
on conflict (name) do nothing;

insert into providers (name) values ('Sharon Suh, FNP-C'), ('Dr. Rodney Lindsay')
on conflict (name) do nothing;

insert into settings (key, value) values
  ('clinic_name',       'VIBEology Medspa'),
  ('clinic_address',    '4580 West University Drive #132, Prosper, TX 75078'),
  ('clinic_phone',      '(972) 533-6293'),
  ('hours_open',        '09:00'),          -- PLACEHOLDER: confirm
  ('hours_close',       '18:00'),          -- PLACEHOLDER: confirm
  ('open_days',         '1,2,3,4,5,6'),    -- PLACEHOLDER: confirm (0 = Sunday)
  ('slot_minutes',      '30'),
  ('assistant_name',    'Vi'),
  ('booking_url',       'https://vibeology.janeapp.com/'),
  ('ai_instructions',   'Be warm, polished, and concise, like a luxury spa front desk. Reply in English or Spanish, matching the guest. Say "we" for the clinic. We serve Prosper, Frisco, McKinney, Celina, Aubrey, and Savannah.'),
  ('winback_days',      '90')
on conflict (key) do nothing;

insert into message_templates (kind, body) values
  ('recall',      'Hi {first_name}, it has been a few months since your {service} at {clinic}. Ready for a refresh? Reply here or call {clinic_phone} to book.'),
  ('winback',     'Hi {first_name}, we miss you at {clinic}. Reply to this message and we will find a time that works for you.'),
  ('birthday',    'Happy birthday, {first_name}! Wishing you a beautiful year from all of us at {clinic}.'),
  ('anniversary', '{first_name}, it has been {years} year(s) since your first visit to {clinic}. Thank you for trusting us with your care.')
on conflict (kind) do nothing;

-- Offers start as drafts (active = 0). Add real offers in the admin, then switch them on.

-- Pre-evaluation answers from the homepage funnel (one row per submission)
create table if not exists preevaluations (
  id         bigserial primary key,
  client_id  bigint not null references clients(id),
  service    text not null,
  answers    text not null default '[]',      -- JSON list of { question, answer }
  created_at text not null
);
alter table preevaluations enable row level security;

-- Treatment photos (placeholders until licensed client photos are supplied)
alter table services add column if not exists image text not null default '';
update services set image = '/images/consultation.jpg' where name = 'Consultation' and image = '';
update services set image = '/images/clinic-treatment.jpg' where name = 'Botox / Dysport / Letybo' and image = '';
update services set image = '/images/hand-on-face.jpg' where name = 'Skin Boosters' and image = '';
update services set image = '/images/facial-routine.jpg' where name = 'Bio-Stimulators' and image = '';
update services set image = '/images/facial-brush.jpg' where name = 'Dermal Fillers' and image = '';
update services set image = '/images/facial-brush.jpg' where name = 'Lip Filler' and image = '';
update services set image = '/images/face-cream.jpg' where name = 'Tear Trough Filler' and image = '';
update services set image = '/images/morning-care.jpg' where name = 'Cheek & Jawline Contouring' and image = '';
update services set image = '/images/skin-serum.jpg' where name = 'RHA Redensity / Skinvive' and image = '';
update services set image = '/images/facial-routine.jpg' where name = 'Sculptra' and image = '';
update services set image = '/images/skin-serum.jpg' where name = 'Radiesse' and image = '';
update services set image = '/images/clinic-treatment.jpg' where name = 'PRP / PRF Injections' and image = '';
update services set image = '/images/clinic-treatment.jpg' where name = 'Microneedling' and image = '';
update services set image = '/images/face-cream.jpg' where name = 'Chemical Peels' and image = '';
update services set image = '/images/skincare-cream.jpg' where name = 'Skin Rejuvenation' and image = '';
update services set image = '/images/morning-care.jpg' where name = 'Non-Surgical BBL' and image = '';
update services set image = '/images/morning-care.jpg' where name = 'Hair Restoration' and image = '';
update services set image = '/images/consultation.jpg' where name = 'Hormone Replacement Therapy' and image = '';
update services set image = '/images/facial-routine.jpg' where name = 'Weight Loss Program' and image = '';
update services set image = '/images/skin-serum.jpg' where name = 'Peptide Therapy' and image = '';
update services set image = '/images/skincare-cream.jpg' where name = 'IV Therapy' and image = '';
update services set image = '/images/hand-on-face.jpg' where name = 'Sexual Health' and image = '';

-- Service pages: short summary and 'what to expect' bullets (written for this site)
alter table services add column if not exists details text not null default '';
update services set details = $${"summary": "Injections made from your own blood plasma, used to support collagen, brighten skin, and refresh the under-eye area.", "expect": ["Usually a series of about 3 sessions, 4 to 6 weeks apart", "Freshness typically visible at 6 to 12 weeks", "Mild downtime of 24 to 72 hours"]}$$ where name = 'PRP / PRF Injections' and details = '';
update services set details = $${"summary": "Meet a provider to talk through your goals, your options, and whether a treatment is right for you. A good first step.", "expect": ["Review of your goals and health history", "A plan explained in plain language", "No obligation to book a treatment"]}$$ where name = 'Consultation' and details = '';
update services set details = $${"summary": "FDA-approved neurotoxins that soften frown lines, crow's feet, and forehead lines for a smoother, refreshed look.", "expect": ["Precise brow shaping and gentle smoothing of forehead lines", "Onset usually within about 3 to 7 days", "Results typically last 3 to 4 months"]}$$ where name = 'Botox / Dysport / Letybo' and details = '';
update services set details = $${"summary": "Micro-injections of ultra-fluid hyaluronic acid or PRF to hydrate deeply, smooth fine lines, and add radiance.", "expect": ["Adds hydration and a healthy glow", "Pinprick marks and mild swelling for a day or two", "Your provider recommends the right product for your skin"]}$$ where name = 'Skin Boosters' and details = '';
update services set details = $${"summary": "Treatments that support your skin's own collagen over time, for gradual volume and firmness.", "expect": ["Gradual, natural-looking change", "Usually a short series of sessions", "Your provider explains the timeline and what to expect"]}$$ where name = 'Bio-Stimulators' and details = '';
update services set details = $${"summary": "Hyaluronic acid fillers that restore volume, contour the cheeks and jawline, and smooth folds, tailored to your features.", "expect": ["Starts with a 3D facial analysis", "Gradual, conservative layering aimed at natural results", "Mild swelling or bruising for about 2 to 7 days", "Results typically last 6 to 18 months, depending on product and area"]}$$ where name = 'Dermal Fillers' and details = '';
update services set details = $${"summary": "Filler that defines, hydrates, and plumps lips for a natural shape that fits your face.", "expect": ["Options from subtle hydration to fuller volume", "Swelling for 24 to 72 hours, with small bruises possible", "Results last about 9 to 12 months on average"]}$$ where name = 'Lip Filler' and details = '';
update services set details = $${"summary": "Targeted under-eye treatment that softens hollows and brightens the look of dark circles, using careful techniques.", "expect": ["Cheek support may be used first to ease the under-eye trough", "Swelling and bruising can last about 3 to 7 days", "Results typically last about 9 to 18 months"]}$$ where name = 'Tear Trough Filler' and details = '';
update services set details = $${"summary": "Filler placement that sculpts the cheekbones and sharpens the jawline for a balanced, lifted profile.", "expect": ["Planned with a facial analysis at your consultation", "Added in stages with a conservative approach", "Your provider explains expected longevity for your plan"]}$$ where name = 'Cheek & Jawline Contouring' and details = '';
update services set details = $${"summary": "Hydrating skin boosters that smooth fine lines and add a healthy, dewy glow without adding bulk.", "expect": ["Redensity targets etched lip lines and fine lines around the mouth", "Skinvive improves cheek smoothness and hydration", "Expect pinprick marks and swelling for 24 to 48 hours"]}$$ where name = 'RHA Redensity / Skinvive' and details = '';
update services set details = $${"summary": "A collagen-stimulating treatment that rebuilds collagen gradually for firmer skin and a long-lasting, natural lift.", "expect": ["Usually 2 to 3 sessions, spaced 6 to 8 weeks apart", "Visible changes from about 8 to 12 weeks, peaking at 3 to 6 months", "Mild swelling or tenderness for 24 to 48 hours"]}$$ where name = 'Sculptra' and details = '';
update services set details = $${"summary": "A calcium-based biostimulator that tightens, lifts, and improves crepey skin on the face, neck, and body.", "expect": ["Used for jawline and chin definition, cheek support, and hands", "Results last about 12 to 18 months", "Mild swelling or bruising for 2 to 7 days"]}$$ where name = 'Radiesse' and details = '';
update services set details = $${"summary": "Injections made from your own blood plasma, used to support collagen, brighten skin, and refresh the under-eye area.", "expect": ["Usually a series of about 3 sessions, 4 to 6 weeks apart", "Freshness typically visible at 6 to 12 weeks", "Mild downtime of 24 to 72 hours"]}$$ where name = 'PRP / PRF Injections' and details = '';
update services set details = $${"summary": "Medical-grade microneedling that refines texture, minimizes the look of pores, and softens acne scars with minimal downtime.", "expect": ["Controlled micro-channels prompt the skin to renew collagen", "Typically 3 to 4 sessions, 4 to 6 weeks apart", "Redness usually lasts 1 to 2 days"]}$$ where name = 'Microneedling' and details = '';
update services set details = $${"summary": "Customized peels that help fade sun damage, melasma, and blemishes for clearer, brighter skin.", "expect": ["Reduces the look of dark patches and sun damage", "Softens fine lines around the lips and eyes", "Improves the look of acne scars"]}$$ where name = 'Chemical Peels' and details = '';
update services set details = $${"summary": "A skin imaging consultation looks at texture, tone, pores, fine lines, and hydration to build a plan for your skin.", "expect": ["Imaging-based review of texture, tone, and pores", "Detects hidden concerns such as sun damage and hydration needs", "Personalized treatment and skincare recommendations"]}$$ where name = 'Skin Rejuvenation' and details = '';
update services set details = $${"summary": "Non-surgical body contouring with collagen-building injectables to lift and shape hip dips and buttocks. No implants, no surgery.", "expect": ["Your provider reviews goals and suitability at your consultation", "Results develop gradually as collagen builds", "Plan and sessions are individualized"]}$$ where name = 'Non-Surgical BBL' and details = '';
update services set details = $${"summary": "Growth-factor scalp treatments that support follicles, reduce shedding, and encourage thicker-looking hair.", "expect": ["Less shedding within about 6 to 8 weeks", "Visible density improvement in about 3 to 6 months", "A temporary increase in shedding can occur at first"]}$$ where name = 'Hair Restoration' and details = '';
update services set details = $${"summary": "Medically supervised hormone therapy for women and men, aimed at energy, sleep, and overall wellness. A licensed provider decides if it is right for you.", "expect": ["Your provider reviews your history and labs before anything is prescribed", "Follow-up adjusts the plan over time", "Results vary between individuals"]}$$ where name = 'Hormone Replacement Therapy' and details = '';
update services set details = $${"summary": "A medically supervised program with GLP-1 and peptide protocols, coaching, and nutrition support for sustainable weight loss.", "expect": ["Any medication is prescribed and dosed carefully, with side-effect monitoring", "Nutrition plan built around protein and hunger", "Check-ins and plan adjustments along the way"]}$$ where name = 'Weight Loss Program' and details = '';
update services set details = $${"summary": "Medically supervised peptide therapy. A licensed provider reviews whether it is appropriate for you before anything is recommended.", "expect": ["Eligibility reviewed at your consultation", "Plan tailored to your goals and health history", "Follow-up to review progress"]}$$ where name = 'Peptide Therapy' and details = '';
update services set details = $${"summary": "Medical-grade IV drips for hydration and recovery, tailored to your lab work and goals.", "expect": ["Reviewed by a provider before your first session", "Tailored to lab results and your goals", "Sessions scheduled around your plan"]}$$ where name = 'IV Therapy' and details = '';
update services set details = $${"summary": "Medically supervised options to support sensitivity, comfort, and satisfaction, with a personalized plan.", "expect": ["Private consultation with a provider", "Options chosen by your provider after reviewing your history", "Brief discomfort, with numbing available when appropriate"]}$$ where name = 'Sexual Health' and details = '';

-- Treatment photos: client photos from beautifulvibemedspa.com, plus licensed photos (see public/images/services/CREDITS.md)
update services set image = '/images/services/front-desk.jpg' where name = 'Consultation';
update services set image = '/images/services/botox.jpg' where name = 'Botox / Dysport / Letybo';
update services set image = '/images/services/clinic-suite.jpg' where name = 'Dermal Fillers';
update services set image = '/images/services/clinic-suite.jpg' where name = 'Lip Filler';
update services set image = '/images/services/treatment-room.jpg' where name = 'Tear Trough Filler';
update services set image = '/images/services/clinic-suite.jpg' where name = 'Cheek & Jawline Contouring';
update services set image = '/images/services/facial-care.jpg' where name = 'RHA Redensity / Skinvive';
update services set image = '/images/services/treatment-room.jpg' where name = 'Sculptra';
update services set image = '/images/services/clinic-suite.jpg' where name = 'Radiesse';
update services set image = '/images/services/treatment-room.jpg' where name = 'Bio-Stimulators';
update services set image = '/images/services/facial-treatment.jpg' where name = 'Skin Boosters';
update services set image = '/images/services/microneedling.jpg' where name = 'PRP / PRF Injections';
update services set image = '/images/services/microneedling.jpg' where name = 'Microneedling';
update services set image = '/images/services/facial-care.jpg' where name = 'Chemical Peels';
update services set image = '/images/services/laser-resurfacing.jpg' where name = 'Skin Rejuvenation';
update services set image = '/images/services/body-treatment.jpg' where name = 'Non-Surgical BBL';
update services set image = '/images/services/clinic-lobby.jpg' where name = 'Hair Restoration';
update services set image = '/images/services/intake-desk.jpg' where name = 'Hormone Replacement Therapy';
update services set image = '/images/services/clinic-lobby.jpg' where name = 'Weight Loss Program';
update services set image = '/images/services/treatment-room.jpg' where name = 'Peptide Therapy';
update services set image = '/images/services/iv-therapy.jpg' where name = 'IV Therapy';
update services set image = '/images/services/clinic-lobby.jpg' where name = 'Sexual Health';
