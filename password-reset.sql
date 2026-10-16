-- "Forgot password?" reset links. Run once in Supabase > SQL Editor.
create table if not exists password_resets (
  id         bigserial primary key,
  email      text not null,
  user_id    text,
  token_hash text not null unique,        -- only a SHA-256 hash of the link is stored
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_resets_email on password_resets (email, created_at);
alter table password_resets enable row level security;   -- only the server can read or write it
notify pgrst, 'reload schema';
