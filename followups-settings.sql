-- Follow-up settings, custom due dates and "they replied". Run once in Supabase > SQL Editor.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;   -- only the server can read or write it
alter table chats add column if not exists followup_due_override timestamptz;
alter table followups add column if not exists replied_at timestamptz;
alter table followups add column if not exists replied_note text;
notify pgrst, 'reload schema';
