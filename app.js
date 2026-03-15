// ═══════════════════════════════════════════════
//  OUR SPACE — app.js  (full real-time edition)
//  1. Set SUPABASE_URL and SUPABASE_ANON_KEY below
//  2. Run schema.sql in your Supabase SQL editor
//  3. Create a Storage bucket called "voice-notes"
// ═══════════════════════════════════════════════
const SUPABASE_URL      = 'https://eekpkpjjdyuzpyxkodhd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVla3BrcGpqZHl1enB5eGtvZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzYyODAsImV4cCI6MjA4OTE1MjI4MH0.azUzGvPV23FJvb94B_7DELtsn36clxOFun5MnC3ZIto';

 

const { createClient } = supabase;
 
// ── Custom storage: bypasses Supabase navigator.locks wrapper ─────────────
// The default gotrue-js storage wraps every localStorage read/write inside
// navigator.locks.request().  In PWAs, iOS WebViews and some Chromium builds
// that lock times out (5 s) then forcibly steals itself → AbortError cascade.
// Providing our own plain synchronous adapter removes the lock entirely while
// still persisting the session across refreshes / app re-opens.
const _customStorage = {
  getItem:    (k)    => { try { return localStorage.getItem(k);       } catch(_) { return null; } },
  setItem:    (k, v) => { try { localStorage.setItem(k, v);           } catch(_) {} },
  removeItem: (k)    => { try { localStorage.removeItem(k);           } catch(_) {} },
};
 
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,        // stay logged in across refresh / PWA reopen
    detectSessionInUrl: false,
    autoRefreshToken:   true,
    flowType:           'implicit',  // no PKCE code-verifier needed
    storage:            _customStorage, // ← plain sync adapter, no lock
    storageKey:         'our-space-auth', // ← unique key, avoids collisions
  },
  realtime: { params: { eventsPerSecond: 10 } },
});
 
// ── State ──────────────────────────────────────
let currentUser      = null;
let userProfile      = null;
let partnerProfile   = null;
let isSignUp         = false;
let mediaRecorder    = null;
let audioChunks      = [];
let recInterval      = null;
let recSeconds       = 0;
let typingTimeout    = null;
let realtimeSub      = null;
let typingChannel    = null;
let presenceInterval = null;
let promptIndex      = 0;
let notifSound       = null;
let currentAudio     = null;
let _appBooted       = false; // prevents double-init
 
// ── Suppress residual AbortError from supabase-js internals ─────────────
// Even with custom storage, the library may fire one AbortError on first
// load from a stale lock state. Catch it here so it never appears in console.
window.addEventListener('unhandledrejection', (e) => {
  if (e?.reason?.name === 'AbortError') {
    e.preventDefault();
  }
});
 
// ── Audio tone ─────────────────────────────────
function initAudio() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    notifSound = () => {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o1.connect(g); o2.connect(g); g.connect(ctx.destination);
      o1.type = o2.type = 'sine';
      o1.frequency.setValueAtTime(880, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.07);
      o2.frequency.setValueAtTime(1100, ctx.currentTime + 0.07);
      o2.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.18);
      g.gain.setValueAtTime(0.18, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
      o1.start(ctx.currentTime); o1.stop(ctx.currentTime + 0.08);
      o2.start(ctx.currentTime + 0.08); o2.stop(ctx.currentTime + 0.28);
    };
  } catch(e) { notifSound = () => {}; }
}
document.addEventListener('click',    () => { if (!notifSound) initAudio(); }, { once: true });
document.addEventListener('touchend', () => { if (!notifSound) initAudio(); }, { once: true });
 
// ── Daily prompts ──────────────────────────────
const PROMPTS = [
  "What's one small thing I did recently that made you smile?",
  "If today were our last day together, what would you want us to do?",
  "What song reminds you of me — and why?",
  "Describe me in three words you've never said out loud.",
  "What's a memory of us that you keep coming back to?",
  "What do you love most about how we communicate?",
  "If you could plan our perfect evening, what would it look like?",
  "What's something you wish I knew about how much I mean to you?",
  "What's a fear you feel safe sharing only with me?",
  "When do you feel most loved by me?",
  "What's one thing you want us to do together that we haven't yet?",
  "How has knowing me changed you?",
  "What do you notice about me that you don't think I notice myself?",
  "What little habit of mine secretly makes you happy?",
  "If we could teleport anywhere right now, where would you take us?",
];
 
// ═══════════════════════════════════════════════
//  BOOTSTRAP — single listener, no getSession() race
// ═══════════════════════════════════════════════
db.auth.onAuthStateChange(async (event, session) => {
  if (!event) return;
 
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    if (session?.user) {
      if (_appBooted && currentUser?.id === session.user.id) return; // already running
      currentUser = session.user;
      _appBooted  = true;
      await loadProfile();
    } else {
      // No saved session → show login
      showScreen('auth-screen');
    }
  }
 
  if (event === 'SIGNED_OUT') {
    _appBooted = false; currentUser = null; userProfile = null; partnerProfile = null;
    stopPresenceHeartbeat();
    db.removeAllChannels();
    document.removeEventListener('visibilitychange', handleVisibility);
    document.removeEventListener('visibilitychange', handleVisibilityRead);
    showScreen('auth-screen');
  }
 
  if (event === 'TOKEN_REFRESHED' && session?.user) {
    currentUser = session.user;
  }
});
 
// ═══════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════
function toggleAuthMode() {
  isSignUp = !isSignUp;
  document.getElementById('auth-title').textContent   = isSignUp ? 'Join Our Space' : 'Welcome back';
  document.getElementById('auth-btn').textContent     = isSignUp ? 'Create account' : 'Sign in';
  document.getElementById('name-field').style.display = isSignUp ? 'flex' : 'none';
  document.getElementById('auth-switch').innerHTML    = isSignUp
    ? 'Already joined? <span onclick="toggleAuthMode()">Sign in</span>'
    : 'New here? <span onclick="toggleAuthMode()">Create account</span>';
  clearAuthError();
}
 
async function handleAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn      = document.getElementById('auth-btn');
 
  if (!email || !password) return showAuthError('Please fill in all fields.');
  if (password.length < 6)  return showAuthError('Password must be at least 6 characters.');
 
  btn.disabled = true;
  btn.textContent = isSignUp ? 'Creating…' : 'Signing in…';
 
  if (isSignUp) {
    // ── SIGN UP ──────────────────────────────────
    const name = document.getElementById('signup-name').value.trim();
    if (!name) {
      btn.disabled = false; btn.textContent = 'Create account';
      return showAuthError('Please enter your name.');
    }
 
    // Step 1: Create the auth user
    const { data: signUpData, error: signUpErr } = await db.auth.signUp({
      email, password,
      options: {
        data: { display_name: name },
        // Skip email confirmation — users go straight in
        emailRedirectTo: undefined,
      },
    });
 
    if (signUpErr) {
      btn.disabled = false; btn.textContent = 'Create account';
      return showAuthError(signUpErr.message);
    }
 
    // Supabase may auto-confirm (if you disabled "confirm email" in dashboard)
    // OR it may require confirmation. We handle both:
    if (signUpData.session) {
      // Confirmed immediately — onAuthStateChange(SIGNED_IN) will fire and boot the app
      btn.textContent = 'Done!';
    } else {
      // Email confirmation required
      btn.disabled = false; btn.textContent = 'Create account';
      showAuthError('✓ Account created! Check your email to confirm, then sign in here.');
    }
 
  } else {
    // ── SIGN IN ──────────────────────────────────
    const { data, error } = await db.auth.signInWithPassword({ email, password });
 
    if (error) {
      btn.disabled = false; btn.textContent = 'Sign in';
      // Friendly error messages
      if (error.message.includes('Invalid login'))
        return showAuthError('Wrong email or password. Try again.');
      if (error.message.includes('Email not confirmed'))
        return showAuthError('Please confirm your email first, then sign in.');
      return showAuthError(error.message);
    }
 
    btn.textContent = 'Welcome back ✦';
    // onAuthStateChange(SIGNED_IN) fires next and boots the app — no manual call needed
  }
}
 
function showAuthError(msg) {
  const e = document.getElementById('auth-error');
  e.textContent = msg; e.classList.add('show');
}
function clearAuthError() {
  document.getElementById('auth-error').classList.remove('show');
}
 
async function signOut() {
  _appBooted = false;
  db.removeAllChannels();
  stopPresenceHeartbeat();
  document.removeEventListener('visibilitychange', handleVisibility);
  document.removeEventListener('visibilitychange', handleVisibilityRead);
  try { await updatePresence('offline'); } catch(_) {}
  await db.auth.signOut();
}
 
// ═══════════════════════════════════════════════
//  PROFILE & SETUP
//
//  HOW THE TWO-PERSON FLOW WORKS
//  ─────────────────────────────
//  Person A (you) signs up → enters YOUR name + YOUR partner's name.
//  The app creates your profile with partner_name stored.
//  You then copy the "invite link" shown in setup → send to your babe.
//
//  Person B (babe) opens the invite link → it pre-fills her sign-up
//  with your email as "partner_email" so the two profiles link up.
//  She just picks her own name & password → done, you're connected.
//
//  Both profiles store each other's email so loadPartnerProfile()
//  can find the other person without any complex join logic.
// ═══════════════════════════════════════════════
 
async function loadProfile() {
  let data, error;
  try {
    ({ data, error } = await db
      .from('profiles').select('*').eq('id', currentUser.id).maybeSingle());
  } catch(e) {
    // Catch any stray AbortError from supabase internals and retry once
    if (e?.name === 'AbortError') {
      await new Promise(r => setTimeout(r, 600));
      try {
        ({ data, error } = await db
          .from('profiles').select('*').eq('id', currentUser.id).maybeSingle());
      } catch(e2) { console.warn('loadProfile retry failed:', e2.message); return; }
    } else { console.warn('loadProfile threw:', e.message); return; }
  }
 
  if (error && error.code !== 'PGRST116') {
    console.warn('loadProfile error:', error.message);
  }
 
  userProfile = data || null;
 
  // New user — no profile row yet
  if (!userProfile) {
    // Auto-create a minimal profile so they can continue
    const displayName = currentUser.user_metadata?.display_name || currentUser.email.split('@')[0];
    await db.from('profiles').upsert({
      id:           currentUser.id,
      email:        currentUser.email,
      display_name: displayName,
    });
    userProfile = { id: currentUser.id, email: currentUser.email, display_name: displayName };
  }
 
  // Check if setup is complete (has partner linked)
  if (!userProfile.partner_email) {
    prefillSetupFromInvite(); // check URL for invite params
    showScreen('setup-screen');
    return;
  }
 
  await loadPartnerProfile();
  showScreen('app-screen');
  initApp();
}
 
// ── Setup screen helpers ──────────────────────
 
// Check URL for ?invite=EMAIL param — babe arrives via invite link
function prefillSetupFromInvite() {
  const params = new URLSearchParams(window.location.search);
  const inviteEmail = params.get('invite');
  const inviteName  = params.get('name');
  if (inviteEmail) {
    const emailEl = document.getElementById('partner-email');
    const nameEl  = document.getElementById('partner-name');
    if (emailEl) emailEl.value = inviteEmail;
    if (nameEl && inviteName) nameEl.value = decodeURIComponent(inviteName);
    // Clean URL without reloading
    window.history.replaceState({}, '', window.location.pathname);
  }
}
 
async function saveSetup() {
  const partnerName  = document.getElementById('partner-name').value.trim();
  const partnerEmail = document.getElementById('partner-email').value.trim().toLowerCase();
  const myName       = document.getElementById('my-name').value.trim();
 
  if (!myName)        return showToast('⚠️', 'Enter your name');
  if (!partnerName)   return showToast('⚠️', 'Enter your partner\'s name');
  if (!partnerEmail)  return showToast('⚠️', 'Enter your partner\'s email');
  if (partnerEmail === currentUser.email.toLowerCase())
    return showToast('⚠️', 'That\'s your own email!');
 
  const btn = document.getElementById('setup-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
 
  const { error } = await db.from('profiles').upsert({
    id:            currentUser.id,
    email:         currentUser.email,
    display_name:  myName,
    partner_name:  partnerName,
    partner_email: partnerEmail,
  });
 
  if (error) {
    btn.disabled = false; btn.textContent = 'Enter our space →';
    return showToast('⚠️', error.message);
  }
 
  // Show invite link for partner
  showInviteLink(partnerEmail, myName);
  btn.disabled = false; btn.textContent = 'Enter our space →';
 
  // Reload profile — if partner already exists, go straight to chat
  await loadProfile();
}
 
function showInviteLink(partnerEmail, myName) {
  const base = window.location.origin + window.location.pathname;
  const link = `${base}?invite=${encodeURIComponent(currentUser.email)}&name=${encodeURIComponent(myName)}`;
 
  const box = document.getElementById('invite-box');
  const url = document.getElementById('invite-url');
  if (!box || !url) return;
  url.value = link;
  box.classList.remove('hidden');
}
 
function copyInviteLink() {
  const url = document.getElementById('invite-url');
  if (!url) return;
  navigator.clipboard.writeText(url.value).then(() => showToast('✓', 'Link copied! Send it to her'));
}
 
async function loadPartnerProfile() {
  if (!userProfile?.partner_email) return;
  // maybeSingle() returns null (not 406) when the partner hasn't signed up yet
  const { data, error } = await db
    .from('profiles').select('*')
    .eq('email', userProfile.partner_email).maybeSingle();
  if (error) console.warn('loadPartnerProfile:', error.message);
  partnerProfile = data || null;
  updatePartnerUI();
}
 
function updatePartnerUI() {
  const name = userProfile?.partner_name || 'Your babe';
  document.getElementById('partner-initial').textContent      = name.charAt(0).toUpperCase();
  document.getElementById('header-partner-name').textContent  = name;
  if (partnerProfile) {
    updatePartnerPresence(partnerProfile.presence || 'offline', partnerProfile.last_seen);
  } else {
    // Partner hasn't joined yet — show a gentle waiting state
    const label = document.getElementById('header-status');
    if (label) { label.textContent = 'waiting for her to join…'; label.dataset.status = 'offline'; }
  }
}
 
// ═══════════════════════════════════════════════
//  APP INIT
// ═══════════════════════════════════════════════
async function initApp() {
  updatePartnerUI();
  setupDateDivider();
  await loadMessages();
  subscribeRealtime();
  subscribeTypingChannel();
  await updatePresence('online');
  startPresenceHeartbeat();
  requestPushPermission();
  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('visibilitychange', handleVisibilityRead);
}
 
function handleVisibility()      { updatePresence(document.hidden ? 'away' : 'online'); }
async function handleVisibilityRead() { if (!document.hidden) await markAllRead(); }
 
function setupDateDivider() {
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  document.getElementById('date-divider').textContent =
    new Date().toLocaleDateString('en-US', opts).toLowerCase();
}
 
// ── Presence ───────────────────────────────────
function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  presenceInterval = setInterval(() => { if (!document.hidden) updatePresence('online'); }, 20000);
}
function stopPresenceHeartbeat() {
  if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
}
async function updatePresence(status) {
  if (!currentUser) return;
  await db.from('profiles')
    .update({ presence: status, last_seen: new Date().toISOString() })
    .eq('id', currentUser.id);
}
 
function updatePartnerPresence(status, lastSeenISO) {
  const dot   = document.getElementById('presence-dot');
  const label = document.getElementById('header-status');
  dot.className = `presence-dot ${status}`;
  if (status === 'online') {
    label.textContent = '● online now'; label.dataset.status = 'online';
  } else if (status === 'away') {
    label.textContent = '● away'; label.dataset.status = 'away';
  } else {
    label.dataset.status = 'offline';
    label.textContent = lastSeenISO ? 'last seen ' + formatLastSeen(lastSeenISO) : 'offline';
  }
}
 
function formatLastSeen(iso) {
  if (!iso) return 'a while ago';
  const diff  = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return `${mins} min ago`;
  if (hours < 24) return `today at ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return `yesterday at ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
 
// ── Messages ───────────────────────────────────
async function loadMessages() {
  const { data, error } = await db
    .from('messages').select('*')
    .order('created_at', { ascending: true }).limit(120);
  if (error) { console.error('loadMessages:', error.message); return; }
 
  const area = document.getElementById('messages-area');
  [...area.querySelectorAll('.bubble-wrap, .event-msg, .day-sep')].forEach(el => el.remove());
 
  let lastDateStr = null;
  (data || []).forEach(msg => {
    const d = new Date(msg.created_at).toDateString();
    if (d !== lastDateStr) { insertDaySeparator(msg.created_at); lastDateStr = d; }
    renderMessage(msg);
  });
 
  scrollToBottom(true);
  await markAllRead();
}
 
function insertDaySeparator(iso) {
  const area   = document.getElementById('messages-area');
  const typing = document.getElementById('typing-indicator');
  const d      = new Date(iso);
  const today  = new Date().toDateString();
  const yest   = new Date(Date.now() - 86400000).toDateString();
  const label  = d.toDateString() === today ? 'today'
               : d.toDateString() === yest  ? 'yesterday'
               : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const sep = document.createElement('div');
  sep.className = 'day-sep date-divider'; sep.textContent = label; sep.dataset.date = d.toDateString();
  area.insertBefore(sep, typing);
}
 
function renderMessage(msg) {
  const isMine = msg.sender_id === currentUser.id;
  const area   = document.getElementById('messages-area');
  const typing = document.getElementById('typing-indicator');
  if (area.querySelector(`[data-id="${msg.id}"]`)) return;
 
  if (['heartbeat','hug','kiss','thinking'].includes(msg.type)) {
    const div = document.createElement('div');
    div.className = 'event-msg'; div.dataset.id = msg.id;
    const icons  = { heartbeat:'💓', hug:'🤗', kiss:'💋', thinking:'🌸' };
    const pName  = userProfile?.partner_name || 'babe';
    const labels = {
      heartbeat: isMine ? 'you sent a heartbeat'    : `${pName} sent you a heartbeat`,
      hug:       isMine ? 'you sent a hug'          : `${pName} hugged you`,
      kiss:      isMine ? 'you blew a kiss'         : `${pName} sent you a kiss`,
      thinking:  isMine ? "you're thinking of them" : `${pName} is thinking of you`,
    };
    div.innerHTML = `<div class="ev-icon ${msg.type}">${icons[msg.type]}</div><span>${labels[msg.type]}</span>`;
    area.insertBefore(div, typing); return;
  }
 
  const wrap = document.createElement('div');
  wrap.className = `bubble-wrap ${isMine ? 'mine' : 'theirs'}`; wrap.dataset.id = msg.id;
 
  const bubble  = document.createElement('div');
  const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
 
  if (msg.type === 'affection') {
    bubble.className = 'bubble affection-bubble'; bubble.textContent = msg.content;
  } else if (msg.type === 'voice') {
    bubble.className = 'bubble voice-bubble';
    const bars = Array.from({length:7},(_,i)=>`<span style="animation-delay:${i*0.1}s"></span>`).join('');
    bubble.innerHTML = `
      <button class="voice-play" data-src="${msg.content}">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="voice-waveform">${bars}</div>
      <span class="voice-dur">${msg.duration||'0:00'}</span>`;
    bubble.querySelector('.voice-play').addEventListener('click', function() {
      playVoice(this.dataset.src, this);
    });
  } else {
    bubble.className = 'bubble'; bubble.textContent = msg.content;
  }
 
  const meta   = document.createElement('div'); meta.className = 'bubble-meta';
  const timeEl = document.createElement('span'); timeEl.className = 'bubble-time'; timeEl.textContent = timeStr;
  meta.appendChild(timeEl);
 
  if (isMine) {
    const tick = document.createElement('span');
    tick.className = `read-tick ${msg.read_at ? 'read' : 'sent'}`;
    tick.innerHTML = buildTick(!!msg.read_at);
    tick.title     = msg.read_at ? `Read ${formatLastSeen(msg.read_at)}` : 'Sent';
    meta.appendChild(tick);
  }
 
  wrap.appendChild(bubble); wrap.appendChild(meta);
  area.insertBefore(wrap, typing);
}
 
function buildTick(isRead) {
  return isRead
    ? `<svg viewBox="0 0 20 12" width="18" height="12"><path d="M1 6l4 4L14 1" stroke="var(--gold)" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 10l4-4" stroke="var(--gold)" fill="none" stroke-width="2.2" stroke-linecap="round"/></svg>`
    : `<svg viewBox="0 0 14 12" width="14" height="12"><path d="M1 6l4 4L13 1" stroke="#555" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
 
async function markAllRead() {
  if (!currentUser || !partnerProfile || document.hidden) return;
  await db.from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('sender_id', partnerProfile.id).is('read_at', null);
}
function updateReadTickInUI(msgId) {
  const wrap = document.querySelector(`.bubble-wrap[data-id="${msgId}"]`); if (!wrap) return;
  const tick = wrap.querySelector('.read-tick'); if (!tick) return;
  tick.className = 'read-tick read'; tick.innerHTML = buildTick(true); tick.title = 'Read';
}
 
// ── Send message ───────────────────────────────
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentUser) return;
  input.value = ''; autoResize(input); closeEmojiPicker(); clearTypingFlag();
  const { data, error } = await db.from('messages')
    .insert({ sender_id: currentUser.id, type: 'text', content }).select().single();
  if (!error && data) { renderMessage(data); scrollToBottom(); }
}
 
async function sendSpecial(type, content, extra = {}) {
  const { data, error } = await db.from('messages')
    .insert({ sender_id: currentUser.id, type, content, ...extra }).select().single();
  if (!error && data) { renderMessage(data); scrollToBottom(); }
}
 
// ── Realtime ───────────────────────────────────
function subscribeRealtime() {
  if (realtimeSub) { db.removeChannel(realtimeSub); realtimeSub = null; }
  realtimeSub = db.channel('our-space-main')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'messages' }, payload => {
      const msg = payload.new;
      if (msg.sender_id === currentUser.id) return;
      const area = document.getElementById('messages-area');
      const seps = area.querySelectorAll('.day-sep');
      const lastSep = seps[seps.length-1];
      const msgDate = new Date(msg.created_at).toDateString();
      if (!lastSep || lastSep.dataset.date !== msgDate) insertDaySeparator(msg.created_at);
      renderMessage(msg); scrollToBottom(); hideTypingUI();
      if (notifSound) notifSound();
      if (navigator.vibrate) navigator.vibrate(50);
      if (!document.hidden) {
        db.from('messages').update({ read_at: new Date().toISOString() }).eq('id', msg.id);
      } else {
        triggerNotification(msg);
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'messages' }, payload => {
      const u = payload.new;
      if (u.sender_id === currentUser.id && u.read_at) updateReadTickInUI(u.id);
    })
    // Partner just created their account → link up automatically
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'profiles' }, async payload => {
      const u = payload.new;
      if (!userProfile?.partner_email) return;
      if (u.email?.toLowerCase() !== userProfile.partner_email.toLowerCase()) return;
      partnerProfile = u;
      updatePartnerUI();
      showToast('💛', (userProfile.partner_name || 'She') + ' just joined!');
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'profiles' }, payload => {
      const u = payload.new;
      if (!partnerProfile || u.id !== partnerProfile.id) return;
      partnerProfile = u;
      updatePartnerPresence(u.presence || 'offline', u.last_seen);
      if (u.current_mood) {
        const pName = userProfile?.partner_name || 'Babe';
        document.getElementById('mood-who').textContent        = pName;
        document.getElementById('mood-label-text').textContent = `${u.mood_emoji||''} ${u.mood_label||u.current_mood}`;
        const banner = document.getElementById('mood-banner');
        banner.classList.add('show'); clearTimeout(banner._t);
        banner._t = setTimeout(() => banner.classList.remove('show'), 7000);
      }
    })
    .subscribe();
}
 
function subscribeTypingChannel() {
  if (typingChannel) { db.removeChannel(typingChannel); typingChannel = null; }
  typingChannel = db.channel('our-space-typing');
  typingChannel
    .on('broadcast', { event:'typing' }, ({ payload }) => {
      if (!payload || payload.user_id === currentUser.id) return;
      payload.is_typing ? showTypingUI() : hideTypingUI();
    }).subscribe();
}
 
function showTypingUI() {
  document.getElementById('typing-indicator').classList.add('show');
  scrollToBottom(); clearTimeout(window._typingHide);
  window._typingHide = setTimeout(hideTypingUI, 4000);
}
function hideTypingUI() {
  document.getElementById('typing-indicator').classList.remove('show');
  clearTimeout(window._typingHide);
}
 
async function handleTyping(el) {
  autoResize(el);
  if (typingChannel && currentUser) {
    typingChannel.send({ type:'broadcast', event:'typing', payload:{ user_id: currentUser.id, is_typing: true } });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(clearTypingFlag, 2500);
}
function clearTypingFlag() {
  if (typingChannel && currentUser) {
    typingChannel.send({ type:'broadcast', event:'typing', payload:{ user_id: currentUser.id, is_typing: false } });
  }
  clearTimeout(typingTimeout);
}
 
// ── Affection ──────────────────────────────────
async function sendHug() {
  if (navigator.vibrate) navigator.vibrate([100,50,100,50,200]);
  await sendSpecial('hug','🤗'); showToast('🤗','hug sent!');
}
async function sendHeartbeat() {
  if (navigator.vibrate) navigator.vibrate([80,40,80,40,80,40,80]);
  await sendSpecial('heartbeat','💓'); showToast('💓','heartbeat sent!');
}
async function sendGesture(type, emoji, label) {
  await sendSpecial(type, emoji); showToast(emoji, label + '!');
}
 
// ── Mood ───────────────────────────────────────
function openMoodModal() { openModal('mood-modal'); }
async function selectMood(key, label, emoji) {
  closeModal('mood-modal');
  await db.from('profiles').update({ current_mood:key, mood_label:label, mood_emoji:emoji }).eq('id', currentUser.id);
  await sendSpecial('affection', `${emoji} feeling ${label.toLowerCase()}`);
  showToast(emoji, `mood set to ${label.toLowerCase()}`);
}
 
// ── Daily Prompt ───────────────────────────────
function openDailyPrompt() {
  promptIndex = Math.floor(Math.random() * PROMPTS.length);
  document.getElementById('daily-prompt-text').textContent = PROMPTS[promptIndex];
  openModal('prompt-modal');
}
function refreshPrompt() {
  promptIndex = (promptIndex + 1) % PROMPTS.length;
  document.getElementById('daily-prompt-text').textContent = PROMPTS[promptIndex];
}
async function sendPromptAsMessage() {
  closeModal('prompt-modal');
  await sendSpecial('affection', `✦ ${PROMPTS[promptIndex]}`);
  showToast('✦','spark sent!');
}
 
// ── Voice Notes ────────────────────────────────
async function toggleVoiceRecord() {
  if (mediaRecorder) { cancelRecording(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream); audioChunks = []; recSeconds = 0;
    mediaRecorder.ondataavailable = e => { if (e.data.size>0) audioChunks.push(e.data); };
    mediaRecorder.start(200);
    document.getElementById('voice-btn').classList.add('recording');
    openModal('voice-modal');
    recInterval = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds/60), s = String(recSeconds%60).padStart(2,'0');
      document.getElementById('rec-time').textContent = `${m}:${s}`;
    }, 1000);
  } catch(e) { showToast('⚠️','Mic access denied'); }
}
 
async function stopAndSendRecording() {
  if (!mediaRecorder) return;
  clearInterval(recInterval); closeModal('voice-modal');
  document.getElementById('voice-btn').classList.remove('recording');
  const duration = `${Math.floor(recSeconds/60)}:${String(recSeconds%60).padStart(2,'0')}`;
  mediaRecorder.stop();
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type:'audio/webm' });
    const filename = `voice_${Date.now()}_${currentUser.id.slice(0,8)}.webm`;
    const { error:upErr } = await db.storage.from('voice-notes').upload(filename, blob, { contentType:'audio/webm' });
    if (upErr) { showToast('⚠️','Upload failed'); console.error(upErr); mediaRecorder=null; return; }
    const { data:urlData } = db.storage.from('voice-notes').getPublicUrl(filename);
    await sendSpecial('voice', urlData.publicUrl, { duration });
    showToast('🎙','voice note sent!');
    mediaRecorder.stream.getTracks().forEach(t=>t.stop()); mediaRecorder=null;
  };
}
function cancelRecording() {
  if (mediaRecorder) { clearInterval(recInterval); try { mediaRecorder.stream.getTracks().forEach(t=>t.stop()); } catch(e){} mediaRecorder=null; }
  document.getElementById('voice-btn').classList.remove('recording'); closeModal('voice-modal');
}
function playVoice(url, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio=null; }
  const audio = new Audio(url); currentAudio = audio;
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  audio.play().catch(() => showToast('⚠️','Could not play audio'));
  audio.onended = () => { btn.innerHTML='<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'; currentAudio=null; };
}
 
// ── Push Notifications ─────────────────────────
async function requestPushPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    setTimeout(async () => {
      const p = await Notification.requestPermission();
      if (p === 'granted') showToast('🔔','Notifications on!');
    }, 3000);
  }
}
function triggerNotification(msg) {
  if (!document.hidden) return;
  if (Notification.permission !== 'granted') return;
  const senderName = userProfile?.partner_name || 'Babe';
  const bodyMap = {
    heartbeat:`${senderName} sent you a heartbeat 💓`, hug:`${senderName} is hugging you 🤗`,
    kiss:`${senderName} blew you a kiss 💋`, thinking:`${senderName} is thinking of you 🌸`,
    affection:msg.content, voice:`${senderName} sent a voice note 🎙`, text:msg.content,
  };
  const body = bodyMap[msg.type] || msg.content;
  const opts = { body, icon:'icon-192.png', badge:'icon-192.png', tag:'our-space-msg', renotify:true };
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type:'SHOW_NOTIFICATION', title:'Our Space 💛', ...opts });
  } else { try { new Notification('Our Space 💛', opts); } catch(e){} }
}
 
// ── UI Helpers ─────────────────────────────────
function handleInputKey(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,110)+'px'; }
function toggleEmojiPicker() { document.getElementById('emoji-picker').classList.toggle('show'); }
function closeEmojiPicker()  { document.getElementById('emoji-picker').classList.remove('show'); }
function insertEmoji(e) {
  const i=document.getElementById('msg-input'), pos=i.selectionStart;
  i.value=i.value.slice(0,pos)+e+i.value.slice(pos); i.focus(); i.selectionStart=i.selectionEnd=pos+e.length;
}
document.addEventListener('click', e => {
  if (!e.target.closest('.emoji-btn') && !e.target.closest('.emoji-picker')) closeEmojiPicker();
});
function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target===o) o.classList.remove('show'); })
  );
});
let toastTimer;
function showToast(icon, text) {
  document.getElementById('toast-icon').textContent=icon; document.getElementById('toast-text').textContent=text;
  const el=document.getElementById('toast'); el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2800);
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function scrollToBottom(instant=false) {
  const a=document.getElementById('messages-area');
  if (instant) { a.scrollTop=a.scrollHeight; return; }
  setTimeout(()=>a.scrollTo({top:a.scrollHeight,behavior:'smooth'}),60);
}
 
// ── iOS keyboard fix ───────────────────────────
(function iosKeyboardFix() {
  if (!window.visualViewport) return;
  let frame=null;
  function onVpChange() {
    if (frame) cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      const vv=window.visualViewport, screen=document.getElementById('app-screen');
      if (!screen) return;
      screen.style.setProperty('--keyboard-offset', Math.max(0,window.innerHeight-vv.height-vv.offsetTop)+'px');
    });
  }
  window.visualViewport.addEventListener('resize',onVpChange);
  window.visualViewport.addEventListener('scroll',onVpChange);
})();
 
if ('serviceWorker' in navigator) {
  window.addEventListener('load', ()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
 
// Pre-fill "your name" on setup screen from auth metadata
const _origShowScreen = showScreen;
showScreen = function(id) {
  _origShowScreen(id);
  if (id === 'setup-screen' && currentUser) {
    const nameEl = document.getElementById('my-name');
    if (nameEl && !nameEl.value) {
      const displayName = currentUser.user_metadata?.display_name
        || userProfile?.display_name
        || '';
      nameEl.value = displayName;
    }
    prefillSetupFromInvite();
  }
};
 