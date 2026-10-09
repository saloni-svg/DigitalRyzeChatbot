-- Calendar access per team member (Show calendar / Do not show calendar). Run once in Supabase > SQL Editor.
alter table admin_users add column if not exists can_calendar boolean not null default true;
notify pgrst, 'reload schema';
