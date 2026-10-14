-- "Ask your dashboard": log of questions and approved actions (also used for the daily limit).
-- Run once in Supabase > SQL Editor.
create table if not exists assistant_log (
  id         bigserial primary key,
  user_id    text,
  user_name  text,
  question   text,
  tools      jsonb,
  actions    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists assistant_log_user_day on assistant_log (user_id, created_at);
alter table assistant_log enable row level security;   -- only the server can read or write it
notify pgrst, 'reload schema';
