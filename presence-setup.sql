-- "Who's on this chat right now?" Run once in Supabase > SQL Editor.
create table if not exists chat_presence (
  session_id text not null,
  user_id    text not null,            -- team member id, "owner" for the main admin, or "visitor"
  name       text,
  typing_at  timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists chat_presence_updated on chat_presence (updated_at);
alter table chat_presence enable row level security;   -- only the server can read or write it
notify pgrst, 'reload schema';
