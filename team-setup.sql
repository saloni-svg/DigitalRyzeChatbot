-- Team assignment and response times. Run once in Supabase > SQL Editor.
alter table chats add column if not exists assigned_to     text;
alter table chats add column if not exists assigned_name   text;
alter table chats add column if not exists assigned_at     timestamptz;
alter table chats add column if not exists assigned_reason text;
create index if not exists chats_assigned_to on chats (assigned_to);
-- settings table (also used by follow-ups; safe to run again)
create table if not exists app_settings (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;
notify pgrst, 'reload schema';
