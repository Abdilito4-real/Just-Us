-- ═══════════════════════════════════════
--  OUR SPACE — Supabase Schema
--  Run this in your Supabase SQL Editor.
-- ═══════════════════════════════════════

-- PROFILES table
create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  display_name    text,
  partner_name    text,
  partner_email   text,
  current_mood    text,
  mood_label      text,
  mood_emoji      text,
  presence        text default 'offline',
  last_seen       timestamptz,
  is_typing       boolean default false,
  created_at      timestamptz default now()
);

-- MESSAGES table
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  sender_id   uuid references profiles(id) on delete cascade,
  type        text not null default 'text',   -- text | affection | heartbeat | hug | kiss | thinking | voice
  content     text not null,
  duration    text,                            -- for voice notes (e.g. "0:12")
  read_at     timestamptz,                     -- null = unread, set = read (for read receipts ✓✓)
  created_at  timestamptz default now()
);

-- ROW LEVEL SECURITY
alter table profiles enable row level security;
alter table messages enable row level security;

-- Profiles: users can read all profiles, update only their own
create policy "read all profiles" on profiles for select using (true);
create policy "insert own profile" on profiles for insert with check (auth.uid() = id);
create policy "update own profile" on profiles for update using (auth.uid() = id);

-- Messages: authenticated users can read all and insert their own
create policy "read all messages" on messages for select using (auth.role() = 'authenticated');
create policy "insert own messages" on messages for insert with check (auth.uid() = sender_id);
-- Allow partner to mark messages as read (update read_at only)
create policy "update read_at" on messages for update using (auth.role() = 'authenticated');

-- Realtime: enable for both tables
alter publication supabase_realtime add table profiles;
alter publication supabase_realtime add table messages;

-- ═══════════════════════════════════════
--  STORAGE: voice notes
--  Go to Storage → New Bucket → name it
--  "voice-notes" → check Public bucket
-- ═══════════════════════════════════════
