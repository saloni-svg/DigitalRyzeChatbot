-- Follow-up agent: run once in Supabase > SQL Editor.
create table if not exists followups (
  id          bigserial primary key,
  session_id  text not null,
  step        int  not null,                       -- 1, 2 or 3
  channel     text not null default 'email',       -- email | whatsapp
  status      text not null default 'draft',       -- draft | sent | skipped | stopped | failed
  lead_name   text, lead_email text, lead_phone text, lead_need text,
  subject     text, body text,
  due_at      timestamptz,
  model       text,
  error       text,
  sent_at     timestamptz,
  sent_by     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists followups_session_step on followups (session_id, step);
create index if not exists followups_status on followups (status, due_at);
alter table followups enable row level security;   -- only the server (service key) can read or write it
alter table chats add column if not exists followup_paused boolean not null default false;
notify pgrst, 'reload schema';
