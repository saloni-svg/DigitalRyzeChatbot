-- Google Calendar meetings: run once in Supabase > SQL Editor.
alter table lead_outcomes add column if not exists meeting_at timestamptz;
alter table lead_outcomes add column if not exists meeting_minutes int;
alter table lead_outcomes add column if not exists calendar_event_id text;
