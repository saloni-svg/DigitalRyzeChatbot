-- Optional: keep the English original of every translated live reply.
-- Live chat works without this; run it in Supabase > SQL Editor if you want the record.
alter table live_messages add column if not exists original text;
