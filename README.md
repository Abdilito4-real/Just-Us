# Our Space — Setup Guide 💛

A private chat PWA for just the two of you.

## Quick Setup

### 1. Supabase project
- Go to https://supabase.com → create a free project
- Project Settings → API → copy your **URL** and **anon key**

### 2. Configure app.js
Replace the two placeholders at the top of `app.js`:
```
SUPABASE_URL      = 'https://xxxx.supabase.co'
SUPABASE_ANON_KEY = 'eyJhb...'
```

### 3. Run schema.sql
In Supabase → SQL Editor → paste schema.sql → Run

### 4. Create voice-notes bucket
Storage → New bucket → name: `voice-notes` → check Public → Create

### 5. Deploy
Drag the folder to https://netlify.com (free) or run locally with `npx serve .`

### 6. Sign up
- You sign up first, enter your name + your babe's name and email
- Your babe signs up with their email — they're automatically linked to you

## Features
- Real-time chat with gold bubbles
- Voice notes (recorded in browser, stored in Supabase Storage)
- Hug button with phone vibration
- Heartbeat pulse with rhythmic vibration
- Mood sharing — your babe sees your mood banner instantly
- Daily spark prompts to keep the conversation going
- Typing indicator & live presence (online / away / offline)
- PWA — install on both phones like a native app
