-- Priority order and automatic handover. Run once in Supabase > SQL Editor (after team-setup.sql).
alter table chats add column if not exists reassign_count int not null default 0;
alter table chats add column if not exists assign_log jsonb not null default '[]'::jsonb;
alter table admin_users add column if not exists last_seen_at timestamptz;
notify pgrst, 'reload schema';
