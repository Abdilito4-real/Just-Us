// ═══════════════════════════════════════════════════════
//  OUR SPACE
//  A private real-time chat app for two people
//
//  Built by  : Jedderh
//  Stack     : Vanilla JS · Supabase (Postgres + Realtime)
//  Features  : Real-time chat · Voice notes · Images
//              Stickers · Heartbeat/Hug · Mood sharing
//              Delivery receipts · Swipe-to-reply
//              Long-press menu · Edit/Delete · PWA
//
//  All rights reserved © Jedderh
// ═══════════════════════════════════════════════════════
const SUPABASE_URL      = 'https://eekpkpjjdyuzpyxkodhd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVla3BrcGpqZHl1enB5eGtvZGhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzYyODAsImV4cCI6MjA4OTE1MjI4MH0.azUzGvPV23FJvb94B_7DELtsn36clxOFun5MnC3ZIto';

const { createClient } = supabase;

// ── Custom storage: bypasses Supabase navigator.locks wrapper ─────────────
const _customStorage = {
  getItem:    (k)    => { try { return localStorage.getItem(k);       } catch(_) { return null; } },
  setItem:    (k, v) => { try { localStorage.setItem(k, v);           } catch(_) {} },
  removeItem: (k)    => { try { localStorage.removeItem(k);           } catch(_) {} },
};

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:     true,
    detectSessionInUrl: false,
    autoRefreshToken:   true,
    flowType:           'implicit',
    storage:            _customStorage,
    storageKey:         'our-space-auth',
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
let _appBooted       = false;
let _tickPollInterval = null;
let _unreadCount     = 0;     // unread message badge counter
let _lastReadTimestamp = null; // Track last time we marked messages as read

// ═══════════════════════════════════════════════════════════════
//  LOADER ENGINE — step-by-step progress feedback
// ═══════════════════════════════════════════════════════════════
const LD_STEPS = [
  { pct: 0,   label: 'Starting up…'              },
  { pct: 18,  label: 'Checking your session…'    },
  { pct: 38,  label: 'Restoring your profile…'   },
  { pct: 58,  label: 'Connecting to your space…' },
  { pct: 80,  label: 'Loading messages…'         },
  { pct: 100, label: 'Almost there ✦'            },
];

let _ldCurrent = 0;
let _ldPctDisplayed = 0;
let _ldAnimFrame = null;

function ldStep(idx) {
  if (idx === _ldCurrent && idx !== 0) return;
  _ldCurrent = Math.min(idx, LD_STEPS.length - 1);
  const step = LD_STEPS[_ldCurrent];

  const textEl = document.getElementById('ld-step-text');
  const pctEl  = document.getElementById('ld-step-pct');
  const barEl  = document.getElementById('ld-bar');

  if (textEl) {
    textEl.style.opacity = '0';
    setTimeout(() => {
      textEl.textContent  = step.label;
      textEl.style.opacity = '1';
    }, 180);
  }
  if (barEl) barEl.style.width = step.pct + '%';

  const target = step.pct;
  if (_ldAnimFrame) cancelAnimationFrame(_ldAnimFrame);
  function tick() {
    if (_ldPctDisplayed < target) {
      _ldPctDisplayed = Math.min(_ldPctDisplayed + 2, target);
      if (pctEl) pctEl.textContent = _ldPctDisplayed + '%';
      _ldAnimFrame = requestAnimationFrame(tick);
    }
  }
  tick();

  for (let i = 0; i < LD_STEPS.length; i++) {
    const dot = document.getElementById('ld-dot-' + i);
    if (!dot) continue;
    if (i < _ldCurrent)       { dot.className = 'ld-dot done';   }
    else if (i === _ldCurrent) { dot.className = 'ld-dot active'; }
    else                       { dot.className = 'ld-dot';        }
  }
}

function ldSetMessage(msg) {
  const textEl = document.getElementById('ld-step-text');
  if (!textEl) return;
  textEl.style.opacity = '0';
  setTimeout(() => { textEl.textContent = msg; textEl.style.opacity = '1'; }, 180);
}

function ldError(msg, onRetry) {
  const textEl = document.getElementById('ld-step-text');
  const pctEl  = document.getElementById('ld-step-pct');
  const barEl  = document.getElementById('ld-bar');
  if (barEl)  { barEl.style.width = '0%'; barEl.style.background = 'rgba(248,113,113,0.5)'; }
  if (pctEl)  pctEl.textContent = '!';
  if (textEl) {
    textEl.style.opacity = '0';
    setTimeout(() => {
      textEl.textContent  = msg;
      textEl.style.color  = '#f87171';
      textEl.style.cursor = 'pointer';
      textEl.style.opacity = '1';
      textEl.onclick = () => {
        if (barEl)  { barEl.style.width = '18%'; barEl.style.background = ''; }
        if (pctEl)  pctEl.textContent = '18%';
        textEl.style.color  = '';
        textEl.style.cursor = '';
        textEl.onclick = null;
        ldStep(2);
        if (onRetry) onRetry();
      };
    }, 180);
  }
}

function ldDone(callback) {
  ldStep(5);
  setTimeout(() => {
    const screen = document.getElementById('loading-screen');
    if (screen) {
      screen.classList.add('exiting');
      setTimeout(() => {
        if (callback) callback();
      }, 480);
    } else {
      if (callback) callback();
    }
  }, 420);
}

ldStep(1);

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
//  BOOTSTRAP
// ═══════════════════════════════════════════════

(function checkStoredSession() {
  try {
    const raw = localStorage.getItem('our-space-auth');
    if (raw) {
      const parsed = JSON.parse(raw);
      const hasToken = parsed?.access_token || parsed?.currentSession?.access_token;
      if (hasToken) {
        showScreen('loading-screen');
        return;
      }
    }
  } catch(_) {}
  showScreen('auth-screen');
})();

db.auth.onAuthStateChange(async (event, session) => {
  if (!event) return;

  if (event === 'INITIAL_SESSION') {
    if (session?.user) {
      if (_appBooted && currentUser?.id === session.user.id) return;
      currentUser = session.user;
      _appBooted  = true;
      ldStep(2);
      setTimeout(() => loadProfile(), 0);
    } else {
      ldDone(() => showScreen('auth-screen'));
    }
  }

  if (event === 'SIGNED_IN') {
    if (_appBooted && currentUser?.id === session?.user?.id) return;
    if (session?.user) {
      currentUser = session.user;
      _appBooted  = true;
      ldStep(2);
      setTimeout(() => loadProfile(), 0);
    }
  }

  if (event === 'SIGNED_OUT') {
    _appBooted = false; currentUser = null; userProfile = null; partnerProfile = null;
    stopPresenceHeartbeat();
    if (_tickPollInterval) { clearInterval(_tickPollInterval); _tickPollInterval = null; }
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

  const { data: existing } = await db.auth.getSession();
  if (existing?.session?.user && !isSignUp) {
    currentUser = existing.session.user;
    _appBooted  = true;
    await loadProfile();
    return;
  }

  if (isSignUp) {
    const name = document.getElementById('signup-name').value.trim();
    if (!name) {
      btn.disabled = false; btn.textContent = 'Create account';
      return showAuthError('Please enter your name.');
    }

    const { data: signUpData, error: signUpErr } = await db.auth.signUp({
      email, password,
      options: {
        data: { display_name: name },
        emailRedirectTo: undefined,
      },
    });

    if (signUpErr) {
      btn.disabled = false; btn.textContent = 'Create account';
      return showAuthError(signUpErr.message);
    }

    if (signUpData.session) {
      btn.textContent = 'Done!';
    } else {
      btn.disabled = false; btn.textContent = 'Create account';
      showAuthError('✓ Account created! Check your email to confirm, then sign in here.');
    }

  } else {
    const { data, error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      btn.disabled = false; btn.textContent = 'Sign in';
      if (error.message.includes('Invalid login'))
        return showAuthError('Wrong email or password. Try again.');
      if (error.message.includes('Email not confirmed'))
        return showAuthError('Please confirm your email first, then sign in.');
      return showAuthError(error.message);
    }

    btn.textContent = 'Welcome back ✦';
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
  if (_tickPollInterval) { clearInterval(_tickPollInterval); _tickPollInterval = null; }
  document.removeEventListener('visibilitychange', handleVisibility);
  document.removeEventListener('visibilitychange', handleVisibilityRead);
  try { await updatePresence('offline'); } catch(_) {}
  await db.auth.signOut();
}

// ═══════════════════════════════════════════════
//  PROFILE & SETUP
// ═══════════════════════════════════════════════

async function loadProfile() {
  await new Promise(r => setTimeout(r, 80));

  const fetchProfile = () =>
    db.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();

  let data = null, error = null;

  const withTimeout = (promise, ms) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })
    ]).finally(() => clearTimeout(timer));
  };

  try {
    ({ data, error } = await withTimeout(fetchProfile(), 7000));
  } catch (e) {
    ldSetMessage('Connection slow, retrying…');
    await new Promise(r => setTimeout(r, 1200));
    try {
      ({ data, error } = await withTimeout(fetchProfile(), 10000));
    } catch (e2) {
      ldError('Could not connect. Check your internet and tap to retry.', () => {
        _appBooted = false;
        loadProfile();
      });
      return;
    }
  }

  if (error && error.code !== 'PGRST116') {
    console.warn('loadProfile error:', error.message);
    ldError('Profile error: ' + error.message + '. Tap to retry.', () => {
      _appBooted = false;
      loadProfile();
    });
    return;
  }

  userProfile = data || null;

  if (!userProfile) {
    const displayName = currentUser.user_metadata?.display_name || currentUser.email.split('@')[0];
    const { error: upsertErr } = await db.from('profiles').upsert({
      id: currentUser.id, email: currentUser.email, display_name: displayName,
    });
    if (upsertErr) {
      ldError('Could not create profile. Tap to retry.', () => { _appBooted = false; loadProfile(); });
      return;
    }
    userProfile = { id: currentUser.id, email: currentUser.email, display_name: displayName };
  }

  if (!userProfile.partner_email) {
    prefillSetupFromInvite();
    ldDone(() => showScreen('setup-screen'));
    return;
  }

  ldStep(3);
  await loadPartnerProfile();
  showScreen('app-screen');
  await initApp();
}

function prefillSetupFromInvite() {
  const params = new URLSearchParams(window.location.search);
  const inviteEmail = params.get('invite');
  const inviteName  = params.get('name');
  if (inviteEmail) {
    const emailEl = document.getElementById('partner-email');
    const nameEl  = document.getElementById('partner-name');
    if (emailEl) emailEl.value = inviteEmail;
    if (nameEl && inviteName) nameEl.value = decodeURIComponent(inviteName);
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

  showInviteLink(partnerEmail, myName);
  btn.disabled = false; btn.textContent = 'Enter our space →';
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
  ldStep(4);
  await loadMessages();
  subscribeRealtime();
  subscribeTypingChannel();
  await updatePresence('online');
  startPresenceHeartbeat();
  requestPushPermission();
  
  // WhatsApp-style delivery: mark as delivered automatically when message is received
  // This happens via database trigger now, not manually
  
  startTickPoller();
  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('visibilitychange', handleVisibilityRead);
  updateActionBtn();
  ldDone(() => {});
}

function handleVisibility() {
  updatePresence(document.hidden ? 'away' : 'online');
  if (!document.hidden) {
    // App came to foreground — mark all as read (WhatsApp behavior)
    markAllRead();
    clearUnread();
    // Also dismiss any pending notifications
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        reg.getNotifications({ tag: 'our-space-msg' }).then(notifs => {
          notifs.forEach(n => n.close());
        });
      });
    }
  }
}
async function handleVisibilityRead() { 
  if (!document.hidden) {
    await markAllRead(); 
  }
}

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

  if (status === 'online') {
    dot.className = 'presence-dot online';
    label.textContent    = 'online now';
    label.dataset.status = 'online';
  } else {
    dot.className = 'presence-dot offline';
    label.dataset.status = 'offline';
    if (lastSeenISO) {
      label.textContent = 'last seen ' + formatLastSeen(lastSeenISO);
    } else {
      label.textContent = 'offline';
    }
  }
}

function formatLastSeen(iso) {
  if (!iso) return 'a while ago';
  const d     = new Date(iso);
  const diff  = Date.now() - d.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  const time  = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (mins  < 1)   return 'just now';
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `today at ${time}`;
  if (days === 1)  return `yesterday at ${time}`;
  if (days  < 7)   return `${d.toLocaleDateString([], { weekday:'long' })} at ${time}`;
  return d.toLocaleDateString([], { day:'numeric', month:'short' });
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
  clearUnread();
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

  if (msg.deleted_for_me && isMine) return;

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

  const arrow = document.createElement('div');
  arrow.className = 'swipe-arrow'; arrow.textContent = '↩';
  wrap.appendChild(arrow);

  const bubble  = document.createElement('div');
  const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (msg.reply_preview) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    quote.textContent = msg.reply_preview;
    bubble.appendChild(quote);
  }

  if (msg.deleted_for_all) {
    bubble.className = 'bubble deleted';
    bubble.innerHTML = `<span class="deleted-icon">🚫</span>${isMine ? 'You deleted this message' : 'This message was deleted'}`;
    const deletedMeta = document.createElement('div'); deletedMeta.className = 'bubble-meta';
    const deletedTime = document.createElement('span'); deletedTime.className = 'bubble-time';
    deletedTime.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    deletedMeta.appendChild(deletedTime);
    wrap.appendChild(bubble);
    wrap.appendChild(deletedMeta);
    area.insertBefore(wrap, typing);
    return;
  }

  if (msg.type === 'affection') {
    bubble.className = 'bubble affection-bubble'; bubble.textContent = msg.content;
  } else if (msg.type === 'sticker') {
    bubble.className = 'bubble sticker-bubble'; bubble.textContent = msg.content;
  } else if (msg.type === 'image') {
    bubble.className = 'bubble img-bubble';
    const img = document.createElement('img');
    img.src = msg.content; img.alt = 'image'; img.loading = 'lazy';
    img.addEventListener('click', () => openImgViewer(msg.content));
    bubble.appendChild(img);
  } else if (msg.type === 'images') {
    bubble.className = 'bubble multi-img-bubble';
    let urls = [];
    try { urls = JSON.parse(msg.content); } catch(_) { urls = [msg.content]; }
    const grid = document.createElement('div');
    grid.className = `img-grid img-grid-${Math.min(urls.length, 4)}`;
    urls.forEach((url, i) => {
      const img = document.createElement('img');
      img.src = url; img.alt = `image ${i+1}`; img.loading = 'lazy';
      img.addEventListener('click', () => openImgViewer(url));
      if (urls.length > 4 && i === 3) {
        const more = document.createElement('div');
        more.className = 'img-grid-more';
        more.innerHTML = `<img src="${url}" /><span>+${urls.length - 4}</span>`;
        more.addEventListener('click', () => openImgViewer(url));
        grid.appendChild(more);
      } else if (i < 4) {
        grid.appendChild(img);
      }
    });
    bubble.appendChild(grid);
  } else if (msg.type === 'voice') {
    bubble.className = 'bubble voice-bubble';
    const bars = Array.from({length:7},(_,i)=>`<span style="animation-delay:${i*0.1}s"></span>`).join('');
    bubble.innerHTML = (msg.reply_preview ? bubble.innerHTML : '') + `
      <button class="voice-play" data-src="${msg.content}">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </button>
      <div class="voice-waveform">${bars}</div>
      <span class="voice-dur">${msg.duration||'0:00'}</span>`;
    bubble.querySelector('.voice-play').addEventListener('click', function() {
      playVoice(this.dataset.src, this);
    });
  } else {
    bubble.className = 'bubble';
    const textNode = document.createElement('span');
    textNode.textContent = msg.content;
    bubble.appendChild(textNode);
    if (msg.edited) {
      const el = document.createElement('span');
      el.className = 'edited-label'; el.textContent = 'edited';
      bubble.appendChild(el);
    }
  }

  const meta   = document.createElement('div'); meta.className = 'bubble-meta';
  const timeEl = document.createElement('span'); timeEl.className = 'bubble-time'; timeEl.textContent = timeStr;
  meta.appendChild(timeEl);

  if (isMine) {
    const tick = document.createElement('span');
    const _state = tickState(msg);
    tick.className = `read-tick ${_state}`;
    tick.innerHTML = buildTick(_state);
    tick.title     = _state === 'read'      ? `Read ${formatLastSeen(msg.read_at)}`
                   : _state === 'delivered' ? `Delivered ${formatLastSeen(msg.delivered_at)}`
                   : 'Sent';
    meta.appendChild(tick);
  }

  wrap.appendChild(bubble); wrap.appendChild(meta);
  area.insertBefore(wrap, typing);

  attachSwipeReply(wrap, msg);
  attachLongPress(wrap, msg);
}

// ══════════════════════════════════════════════════════
//  THREE-STATE TICK SYSTEM
// ══════════════════════════════════════════════════════
function buildTick(state) {
  if (state === true)  state = 'read';
  if (state === false) state = 'sent';

  const check = (dx, color, w = 2) =>
    `<polyline
       points="${1.5+dx},7 ${5+dx},11 ${12+dx},3"
       fill="none" stroke="${color}" stroke-width="${w}"
       stroke-linecap="round" stroke-linejoin="round"/>`;

  if (state === 'sent') {
    return `<svg viewBox="0 0 14 14" width="14" height="14">
      ${check(0, '#666', 1.9)}
    </svg>`;
  }

  if (state === 'delivered') {
    return `<svg viewBox="0 0 20 14" width="20" height="14">
      ${check(0,   '#666', 1.8)}
      ${check(5.5, '#888', 1.8)}
    </svg>`;
  }

  return `<svg viewBox="0 0 20 14" width="20" height="14">
    ${check(0,   'rgba(212,175,55,0.65)', 1.9)}
    ${check(5.5, 'var(--gold)',           2.1)}
  </svg>`;
}

function tickState(msg) {
  if (msg.read_at)      return 'read';
  if (msg.delivered_at) return 'delivered';
  return 'sent';
}

// WhatsApp-style: mark as read only when user opens the chat
async function markAllRead() {
  if (!currentUser || !partnerProfile) return;
  
  // Only mark as read if we're actually viewing the chat
  // (In WhatsApp, opening the chat marks everything as read)
  const now = new Date().toISOString();
  
  // Update database
  const { data } = await db.from('messages')
    .update({ read_at: now })
    .eq('sender_id', partnerProfile.id)
    .is('read_at', null)
    .select();
  
  // Update UI for each message that was marked as read
  if (data) {
    data.forEach(msg => {
      updateReadTickInUI(msg.id);
    });
  }
  
  // Clear badge immediately when reading
  clearUnread();
}

// WhatsApp-style: mark as delivered automatically when message is received
// This should be handled by a database trigger, but we'll also update UI
async function markMessageDelivered(messageId) {
  if (!currentUser || !partnerProfile) return;
  
  const now = new Date().toISOString();
  await db.from('messages')
    .update({ delivered_at: now })
    .eq('id', messageId)
    .eq('sender_id', partnerProfile.id)
    .is('delivered_at', null);
}

async function markMessageRead(messageId) {
  if (!currentUser || !partnerProfile || document.hidden) return;
  
  const now = new Date().toISOString();
  await db.from('messages')
    .update({ read_at: now })
    .eq('id', messageId)
    .eq('sender_id', partnerProfile.id)
    .is('read_at', null);
}

function updateTickInUI(msgId, state) {
  const wrap = document.querySelector(`.bubble-wrap[data-id="${msgId}"]`);
  if (!wrap) return;
  const tick = wrap.querySelector('.read-tick');
  if (!tick) return;
  tick.className = `read-tick ${state} tick-bump`;
  tick.innerHTML = buildTick(state);
  tick.title = state === 'read' ? 'Read' : state === 'delivered' ? 'Delivered' : 'Sent';
  setTimeout(() => tick.classList.remove('tick-bump'), 400);
}

function updateReadTickInUI(msgId)      { updateTickInUI(msgId, 'read'); }
function updateDeliveredTickInUI(msgId) { updateTickInUI(msgId, 'delivered'); }

async function refreshAllTicks() {
  if (!currentUser) return;
  const pendingWraps = [...document.querySelectorAll('.bubble-wrap.mine')].filter(w => {
    const tick = w.querySelector('.read-tick');
    return tick && !tick.classList.contains('read');
  });
  if (!pendingWraps.length) return;
  const ids = pendingWraps.map(w => w.dataset.id).filter(Boolean);
  if (!ids.length) return;
  const { data } = await db.from('messages')
    .select('id, delivered_at, read_at')
    .in('id', ids)
    .eq('sender_id', currentUser.id);
  if (!data) return;
  data.forEach(m => {
    if (m.read_at)           updateReadTickInUI(m.id);
    else if (m.delivered_at) updateDeliveredTickInUI(m.id);
  });
}

function startTickPoller() {
  if (_tickPollInterval) clearInterval(_tickPollInterval);
  _tickPollInterval = setInterval(() => refreshAllTicks(), 3000);
}

// ── Send message ───────────────────────────────
async function sendMessage() {
  if (_pendingImages.length > 0) { await sendImageMessage(); return; }

  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentUser) return;
  input.value = ''; autoResize(input); closeEmojiPicker(); closeStickerPicker(); clearTypingFlag(); updateActionBtn();

  const row = {
    sender_id: currentUser.id,
    type:      'text',
    content,
  };
  if (_replyTarget) {
    row.reply_to_id  = _replyTarget.id;
    row.reply_preview = (_replyTarget.type === 'voice' ? '🎙 Voice note'
                       : _replyTarget.type === 'image' ? '🖼 Image'
                       : _replyTarget.type === 'sticker' ? _replyTarget.content
                       : (_replyTarget.content || '').slice(0, 60));
    cancelReply();
  }

  const { data, error } = await db.from('messages').insert(row).select().single();
  if (!error && data) {
    renderMessage(data); scrollToBottom(); 
    sendPushToPartner(data);
    setTimeout(() => refreshAllTicks(), 1500);
    setTimeout(() => refreshAllTicks(), 4000);
  }
}

async function sendSpecial(type, content, extra = {}) {
  const { data, error } = await db.from('messages')
    .insert({ sender_id: currentUser.id, type, content, ...extra }).select().single();
  if (!error && data) {
    renderMessage(data); scrollToBottom(); sendPushToPartner(data);
    setTimeout(() => refreshAllTicks(), 1500);
  }
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
      
      renderMessage(msg); 
      scrollToBottom(); 
      hideTypingUI();
      
      // WhatsApp-style notification logic
      triggerNotification(msg);
      
      // Auto-mark as delivered (WhatsApp does this when device receives message)
      markMessageDelivered(msg.id);
      
      // If app is visible and focused, mark as read immediately
      if (!document.hidden) {
        markMessageRead(msg.id);
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'messages' }, payload => {
      const u = payload.new;
      const old = payload.old;

      if (u.sender_id === currentUser.id) {
        if (u.read_at && !old.read_at) {
          updateReadTickInUI(u.id);
        } else if (u.delivered_at && !old.delivered_at) {
          updateDeliveredTickInUI(u.id);
        }
      }

      if (u.edited && u.sender_id !== currentUser.id && u.content !== old.content) {
        const wrap = document.querySelector(`.bubble-wrap[data-id="${u.id}"]`);
        const textSp = wrap?.querySelector('.bubble span:not(.edited-label)');
        if (textSp) {
          textSp.textContent = u.content;
          let el = wrap.querySelector('.edited-label');
          if (!el) {
            el = document.createElement('span');
            el.className = 'edited-label'; el.textContent = 'edited';
            const meta = wrap.querySelector('.bubble-meta');
            if (meta) meta.insertBefore(el, meta.firstChild);
          }
        }
      }

      if (u.email && u.email.toLowerCase() === userProfile?.partner_email?.toLowerCase()) {
        partnerProfile = u;
        updatePartnerUI();
        showToast('💛', (userProfile.partner_name || 'She') + ' just joined!');
      }
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'profiles' }, payload => {
      const u = payload.new;
      const old = payload.old;
      
      if (!partnerProfile || u.id !== partnerProfile.id) return;
      
      partnerProfile = u;
      updatePartnerPresence(u.presence || 'offline', u.last_seen);
      
      if (u.current_mood && u.current_mood !== old?.current_mood) {
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
  updateActionBtn();
  if (typingChannel && currentUser) {
    typingChannel.send({ type:'broadcast', event:'typing', payload:{ user_id: currentUser.id, is_typing: true } });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(clearTypingFlag, 2500);
}

function updateActionBtn() {
  const btn    = document.getElementById('action-btn');
  const input  = document.getElementById('msg-input');
  if (!btn) return;
  const hasText = input?.value.trim().length > 0 || _pendingImages.length > 0;
  if (hasText) {
    btn.classList.add('send-mode');
    btn.classList.remove('recording');
    btn.title = 'Send';
  } else {
    btn.classList.remove('send-mode');
    btn.title = 'Voice note';
  }
}

function handleActionBtn() {
  const btn   = document.getElementById('action-btn');
  const input = document.getElementById('msg-input');
  const hasText = input?.value.trim().length > 0 || _pendingImages.length > 0;
  if (hasText) {
    sendMessage();
  } else {
    toggleVoiceRecord();
  }
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
    document.getElementById('action-btn').classList.add('recording'); document.getElementById('action-btn').classList.remove('send-mode');
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
  document.getElementById('action-btn').classList.remove('recording'); updateActionBtn();
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
  document.getElementById('action-btn').classList.remove('recording'); updateActionBtn(); closeModal('voice-modal');
}
function playVoice(url, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio=null; }
  const audio = new Audio(url); currentAudio = audio;
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  audio.play().catch(() => showToast('⚠️','Could not play audio'));
  audio.onended = () => { btn.innerHTML='<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'; currentAudio=null; };
}

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS — VAPID
// ═══════════════════════════════════════════════════════════════

const VAPID_PUBLIC_KEY = 'BNTTu-CxpWI1q3WLMAFH4yy42x9v0hX59kCYOjIrsibSLzquDRsKW7SPuSPwFsc5eCkdLj_heuaYr9JfrSonRDo';

let _pushSubscription = null;

async function subscribeToPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY_HERE') return;
    if (Notification.permission !== 'granted') return;

    let reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SW timeout')), 8000))
    ]);

    if (!navigator.serviceWorker.controller) {
      await reg.update();
      await new Promise(r => setTimeout(r, 500));
      reg = await navigator.serviceWorker.ready;
    }

    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    _pushSubscription = sub;
    await savePushSubscription(sub);
    console.log('✓ Push subscription active:', sub.endpoint.slice(0, 50) + '...');
    return sub;
  } catch (err) {
    console.warn('Push subscribe failed:', err.message || err);
  }
}

async function savePushSubscription(sub) {
  if (!currentUser || !sub) return;
  const json = sub.toJSON();
  const { error } = await db.from('push_subscriptions').upsert({
    user_id:    currentUser.id,
    endpoint:   json.endpoint,
    p256dh:     json.keys.p256dh,
    auth:       json.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) console.warn('savePushSubscription error:', error.message);
  else console.log('✓ Push subscription saved to Supabase');
}

async function requestPushPermission() {
  if (!('Notification' in window)) return;

  checkInstallState();

  if (Notification.permission === 'denied') return;

  if (Notification.permission === 'default') {
    setTimeout(async () => {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isInstalled = window.matchMedia('(display-mode: standalone)').matches
                       || window.navigator.standalone === true;

      if (isIOS && !isInstalled) return;

      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        showToast('🔔', 'Notifications on!');
        await subscribeToPush();
      }
    }, 3000);
    return;
  }

  if (Notification.permission === 'granted') {
    await subscribeToPush();
  }
}

async function sendPushToPartner(msg) {
  if (!partnerProfile?.id) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY === 'YOUR_VAPID_PUBLIC_KEY_HERE') return;

  const senderName = userProfile?.display_name || userProfile?.partner_name || 'Babe';
  const bodyMap = {
    heartbeat: `${senderName} sent you a heartbeat 💓`,
    hug:       `${senderName} is hugging you 🤗`,
    kiss:      `${senderName} blew you a kiss 💋`,
    thinking:  `${senderName} is thinking of you 🌸`,
    affection: msg.content,
    voice:     `${senderName} sent a voice note 🎙`,
    image:     `${senderName} sent a photo 🖼`,
    images:    `${senderName} sent photos 🖼`,
    sticker:   `${senderName} sent a sticker ${msg.content}`,
    text:      msg.content,
  };
  const body = bodyMap[msg.type] || msg.content || 'New message';

  try {
    const session = await db.auth.getSession();
    await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        recipientId: partnerProfile.id,
        title: `Our Space 💛`,
        body,
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     'our-space-msg',
        renotify: true,
        actions: [
          { action: 'reply',  title: '💬 Reply' },
          { action: 'open',   title: 'Open' },
        ],
        silent: false,
        data: {
          url:         '/',
          senderId:    currentUser.id,
          senderName,
          messageType: msg.type,
          messageId:   msg.id,
          timestamp:   Date.now(),
        },
      }),
    });
  } catch (e) {
    // Push is best-effort — never block message send
  }
}

// ═══════════════════════════════════════════════════════════════
//  WHATSAPP-STYLE NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════

// ── Badge counter ───────────────────────────────────────────────
function incrementUnread() {
  _unreadCount++;
  updateAppBadge(_unreadCount);
  updatePageTitle(_unreadCount);
}

function clearUnread() {
  _unreadCount = 0;
  updateAppBadge(0);
  updatePageTitle(0);
}

function updateAppBadge(count) {
  try {
    if ('setAppBadge' in navigator) {
      if (count > 0) navigator.setAppBadge(count);
      else           navigator.clearAppBadge();
    }
  } catch (_) {}
}

function updatePageTitle(count) {
  document.title = count > 0 ? `(${count}) Our Space` : 'Our Space';
}

// WhatsApp-style notification trigger
function triggerNotification(msg) {
  // Always increment badge
  incrementUnread();

  // WhatsApp behavior:
  // - App OPEN & focused in this chat → no OS notification, just in-app sound
  // - App OPEN but backgrounded → OS notification
  // - App closed/killed → OS notification via VAPID push
  
  // Check if we're actively viewing the chat
  const isInChat = !document.hidden; // User is in the app
  
  if (isInChat) {
    // Just play in-app sound, no OS notification (like WhatsApp)
    if (notifSound) notifSound();
    if (navigator.vibrate) navigator.vibrate(50);
    return;
  }

  // App is backgrounded or closed - show OS notification
  if (Notification.permission !== 'granted') return;

  const senderName = userProfile?.partner_name || 'Babe';
  
  const bodyMap = {
    heartbeat: `💓 ${senderName} sent you a heartbeat`,
    hug:       `🤗 ${senderName} hugged you`,
    kiss:      `💋 ${senderName} blew you a kiss`,
    thinking:  `🌸 ${senderName} is thinking of you`,
    affection: msg.content,
    voice:     `🎙 Voice message from ${senderName}`,
    image:     `🖼 Photo from ${senderName}`,
    images:    `🖼 ${msg.content ? JSON.parse(msg.content).length : ''} photos from ${senderName}`,
    sticker:   `${senderName} sent a sticker`,
    text:      msg.content,
  };
  const body = bodyMap[msg.type] || msg.content || 'New message';

  const title = _unreadCount > 1
    ? `Our Space (${_unreadCount}) 💛`
    : `Our Space 💛`;

  const notifOpts = {
    body,
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    tag:   'our-space-msg',
    renotify: true,
    silent: false,
    vibrate: [100, 50, 200],
    requireInteraction: false,
    data: {
      url:         '/',
      unreadCount: _unreadCount,
      senderId:    msg.sender_id,
      messageId:   msg.id,
      timestamp:   Date.now(),
    },
    actions: [
      { action: 'reply', title: '💬 Reply' },
      { action: 'open',  title: 'Open' },
    ],
  };

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type:  'SHOW_NOTIFICATION',
      title,
      ...notifOpts,
    });
  } else {
    try { new Notification(title, notifOpts); } catch (_) {}
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'NOTIFICATION_CLICK') {
      clearUnread();        // clear badge + title when notification tapped
      scrollToBottom(true);
      markAllRead();        // Mark all as read when opening from notification
    }
    if (e.data?.type === 'PUSH_SUBSCRIPTION_CHANGED') {
      const raw = e.data.subscription;
      if (raw && currentUser) {
        db.from('push_subscriptions').upsert({
          user_id: currentUser.id,
          endpoint: raw.endpoint,
          p256dh: raw.keys?.p256dh,
          auth: raw.keys?.auth,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'endpoint' });
      }
    }
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

// ═══════════════════════════════════════════════════════════════
//  INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  showInstallBanner('android');
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  hideInstallBanner();
  showToast('💛', 'Our Space installed!');
  setTimeout(() => subscribeToPush(), 1500);
});

function checkInstallState() {
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;
  if (isInstalled) { hideInstallBanner(); return; }

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (isIOS && isSafari) {
    showInstallBanner('ios');
  }
}

function showInstallBanner(type) {
  if (sessionStorage.getItem('install-banner-shown')) return;
  sessionStorage.setItem('install-banner-shown', '1');

  const banner = document.getElementById('install-banner');
  if (!banner) return;

  if (type === 'ios') {
    document.getElementById('install-android-row').style.display = 'none';
    document.getElementById('install-ios-row').style.display = 'flex';
  } else {
    document.getElementById('install-android-row').style.display = 'flex';
    document.getElementById('install-ios-row').style.display = 'none';
  }

  banner.classList.add('show');
}

function hideInstallBanner() {
  document.getElementById('install-banner')?.classList.remove('show');
}

async function triggerInstall() {
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') hideInstallBanner();
    _deferredInstallPrompt = null;
  } else {
    hideInstallBanner();
  }
}

// ── UI Helpers ─────────────────────────────────
function handleInputKey(e) { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,110)+'px'; }
function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  const btn    = document.getElementById('emoji-tb-btn');
  const isOpen = picker.classList.toggle('show');
  btn?.classList.toggle('active', isOpen);
  if (isOpen) closeStickerPicker();
}
function closeEmojiPicker() {
  document.getElementById('emoji-picker').classList.remove('show');
  document.getElementById('emoji-tb-btn')?.classList.remove('active');
}
function insertEmoji(emoji) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const txt = input.value.trim();

  if (!txt) {
    closeEmojiPicker();
    sendEmojiMessage(emoji);
  } else {
    const pos = input.selectionStart;
    input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + emoji.length;
    updateActionBtn();
  }
}

async function sendEmojiMessage(emoji) {
  if (!currentUser) return;
  clearTypingFlag();
  const row = { sender_id: currentUser.id, type: 'text', content: emoji };
  if (_replyTarget) {
    row.reply_to_id   = _replyTarget.id;
    row.reply_preview = (_replyTarget.content || '').slice(0, 60);
    cancelReply();
  }
  const { data, error } = await db.from('messages').insert(row).select().single();
  if (!error && data) { renderMessage(data); scrollToBottom(); }
}
document.addEventListener('click', e => {
  if (!e.target.closest('#emoji-tb-btn') && !e.target.closest('.emoji-picker')) closeEmojiPicker();
  if (!e.target.closest('#sticker-btn') && !e.target.closest('.sticker-picker')) closeStickerPicker();
});
function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target===o) o.classList.remove('show'); })
  );
});
function showAbout() { openModal('about-modal'); }
function openSettings() {
  updateSettingsNotifUI();
  updateSettingsInstallUI();
  openModal('settings-modal');
}

function updateSettingsNotifUI() {
  const btn = document.getElementById('notif-settings-btn');
  const sub = document.getElementById('notif-settings-sub');
  if (!btn || !sub) return;
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  if (perm === 'granted') {
    sub.textContent = _pushSubscription ? 'Push notifications active ✓' : 'Granted — re-subscribe below';
    btn.style.opacity = _pushSubscription ? '0.55' : '1';
  } else if (perm === 'denied') {
    sub.textContent = 'Blocked — enable in phone Settings';
    btn.style.opacity = '0.55';
  } else {
    sub.textContent = 'Tap to allow push notifications';
    btn.style.opacity = '1';
  }
  btn.style.display = perm === 'unsupported' ? 'none' : '';
}

function updateSettingsInstallUI() {
  const btn = document.getElementById('install-settings-btn');
  if (!btn) return;
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;
  if (isInstalled) {
    btn.querySelector('.do-sub').textContent = 'Already installed ✓';
    btn.style.opacity = '0.55';
  } else {
    btn.querySelector('.do-sub').textContent = 'Install app for best experience';
    btn.style.opacity = '1';
  }
}

async function handleNotifSettingsBtn() {
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  if (perm === 'denied') {
    showToast('⚙️', 'Enable in your phone Settings → Notifications');
    return;
  }
  if (perm === 'default') {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      await subscribeToPush();
      showToast('🔔', 'Notifications on!');
    }
  } else if (perm === 'granted') {
    await subscribeToPush();
    showToast('🔔', 'Push subscription refreshed!');
  }
  updateSettingsNotifUI();
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE: DELETE CHAT
// ═══════════════════════════════════════════════════════════════
function openDeleteChatConfirm() {
  closeModal('settings-modal');
  openModal('delete-chat-modal');
}

async function confirmDeleteChat() {
  closeModal('delete-chat-modal');

  const btn = document.querySelector('#delete-chat-modal .btn-gold');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  const { error } = await db.from('messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  if (error) {
    showToast('⚠️', 'Could not delete: ' + error.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete everything'; }
    return;
  }

  const area = document.getElementById('messages-area');
  [...area.querySelectorAll('.bubble-wrap, .event-msg, .day-sep')].forEach(el => el.remove());

  showToast('🗑', 'Chat cleared for both of you');
}

function handleInstallSettingsBtn() {
  closeModal('settings-modal');
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches
                   || window.navigator.standalone === true;
  if (isInstalled) {
    showToast('✓', 'Already installed!');
    return;
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    sessionStorage.removeItem('install-banner-shown');
    showInstallBanner('ios');
  } else if (_deferredInstallPrompt) {
    triggerInstall();
  } else {
    showToast('📲', 'Use your browser\'s install option');
  }
}

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
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (newSW) newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller)
            newSW.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    } catch (e) { console.warn('SW registration failed:', e); }
  });
}

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

// ═══════════════════════════════════════════════════════════════
//  FEATURE: SWIPE-TO-REPLY
// ═══════════════════════════════════════════════════════════════
let _replyTarget = null;

function attachSwipeReply(wrap, msg) {
  let startX = 0, currentX = 0, swiping = false;
  const isMine = msg.sender_id === currentUser.id;
  const THRESHOLD = 60;

  function onStart(e) {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; swiping = true; currentX = 0;
  }
  function onMove(e) {
    if (!swiping) return;
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const dir = isMine ? -dx : dx;
    if (dir < 0) return;
    currentX = Math.min(dir, THRESHOLD + 20);
    const bubble = wrap.querySelector('.bubble');
    const progress = Math.min(currentX / THRESHOLD, 1);
    bubble.style.transform = isMine
      ? `translateX(${-currentX * 0.5}px)`
      : `translateX(${currentX * 0.5}px)`;
    if (progress > 0.3) wrap.classList.add('swiping');
    else wrap.classList.remove('swiping');
    if (e.cancelable) e.preventDefault();
  }
  function onEnd() {
    if (!swiping) return;
    swiping = false;
    const bubble = wrap.querySelector('.bubble');
    bubble.style.transform = '';
    wrap.classList.remove('swiping');
    if (currentX >= THRESHOLD) {
      triggerReply(msg);
      if (navigator.vibrate) navigator.vibrate(40);
    }
    currentX = 0;
  }

  wrap.addEventListener('touchstart', onStart, { passive: true });
  wrap.addEventListener('touchmove',  onMove,  { passive: false });
  wrap.addEventListener('touchend',   onEnd,   { passive: true });
}

function triggerReply(msg) {
  _replyTarget = msg;
  const isMine = msg.sender_id === currentUser.id;
  const who = isMine ? 'You' : (userProfile?.partner_name || 'Babe');
  const preview = msg.type === 'voice' ? '🎙 Voice note'
                : msg.type === 'image' ? '🖼 Image'
                : msg.type === 'sticker' ? msg.content
                : (msg.content || '').slice(0, 60);
  document.getElementById('reply-who').textContent = who + ':';
  document.getElementById('reply-text-preview').textContent = preview;
  document.getElementById('reply-preview').classList.add('show');
  document.getElementById('msg-input').focus();
}

function cancelReply() {
  _replyTarget = null;
  document.getElementById('reply-preview').classList.remove('show');
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE: LONG-PRESS CONTEXT MENU
// ═══════════════════════════════════════════════════════════════
let _ctxMsg = null;
let _longPressTimer = null;

function attachLongPress(wrap, msg) {
  function show(clientX, clientY) {
    _ctxMsg = msg;
    const menu  = document.getElementById('ctx-menu');
    const isMine = msg.sender_id === currentUser.id;

    document.getElementById('ctx-edit').style.display   = isMine && msg.type === 'text' ? '' : 'none';
    document.getElementById('ctx-delete').style.display = isMine ? '' : 'none';
    document.getElementById('ctx-copy').style.display   = ['text','affection'].includes(msg.type) ? '' : 'none';

    menu.style.display = 'flex';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = clientX - mw / 2, y = clientY - mh - 12;
    x = Math.max(8, Math.min(x, vw - mw - 8));
    y = Math.max(8, Math.min(y, vh - mh - 8));
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.classList.add('show');

    if (navigator.vibrate) navigator.vibrate(50);
  }

  wrap.addEventListener('touchstart', e => {
    const t = e.touches[0];
    _longPressTimer = setTimeout(() => show(t.clientX, t.clientY), 480);
  }, { passive: true });
  wrap.addEventListener('touchend',   () => clearTimeout(_longPressTimer), { passive: true });
  wrap.addEventListener('touchmove',  () => clearTimeout(_longPressTimer), { passive: true });

  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    show(e.clientX, e.clientY);
  });
}

function closeCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('show');
  menu.style.left = '-9999px';
}
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu')) closeCtxMenu();
});
document.addEventListener('touchstart', e => {
  if (!e.target.closest('#ctx-menu')) closeCtxMenu();
}, { passive: true });

async function ctxAction(action) {
  closeCtxMenu();
  if (!_ctxMsg) return;
  const msg = _ctxMsg;
  _ctxMsg = null;

  if (action === 'reply') {
    triggerReply(msg);
  }

  if (action === 'copy') {
    const text = msg.content || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast('⎘', 'Copied!');
    } catch(_) {
      const el = document.createElement('textarea');
      el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el); el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      showToast('⎘', 'Copied!');
    }
  }

  if (action === 'edit') {
    const wrap   = document.querySelector(`.bubble-wrap[data-id="${msg.id}"]`);
    const bubble = wrap?.querySelector('.bubble');
    if (!bubble) return;

    const textSpan = bubble.querySelector('span:not(.edited-label)') || bubble;
    const original = textSpan.textContent.trim();

    textSpan.contentEditable = 'true';
    bubble.classList.add('editing');
    textSpan.focus();

    const range = document.createRange();
    range.selectNodeContents(textSpan); range.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);

    function finishEdit(e) {
      if ((e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey) || e.type === 'blur') {
        if (e.type === 'keydown') e.preventDefault();
        textSpan.contentEditable = 'false';
        bubble.classList.remove('editing');
        textSpan.removeEventListener('keydown', finishEdit);
        textSpan.removeEventListener('blur', finishEdit);
        const newText = textSpan.textContent.trim();
        if (newText && newText !== original) {
          saveEdit(msg.id, newText, textSpan, wrap);
        }
      }
    }
    textSpan.addEventListener('keydown', finishEdit);
    textSpan.addEventListener('blur',    finishEdit);
  }

  if (action === 'delete') {
    openDeleteConfirm(msg);
  }
}

// ── Delete confirmation sheet ────────────────────────────────────
let _deleteTarget = null;

function openDeleteConfirm(msg) {
  _deleteTarget = msg;

  const preview = msg.type === 'voice'   ? '🎙 Voice note'
                : msg.type === 'image'   ? '🖼 Image'
                : msg.type === 'sticker' ? msg.content
                : (msg.content || '').slice(0, 80);
  document.getElementById('delete-preview-text').textContent = preview;

  document.getElementById('delete-overlay').classList.add('show');
}

function cancelDelete(e) {
  if (e && e.target !== document.getElementById('delete-overlay')) return;
  _deleteTarget = null;
  document.getElementById('delete-overlay').classList.remove('show');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cancelDelete();
    closeCtxMenu();
  }
});

async function confirmDelete(scope) {
  document.getElementById('delete-overlay').classList.remove('show');
  if (!_deleteTarget) return;
  const msg = _deleteTarget;
  _deleteTarget = null;

  const wrap = document.querySelector(`.bubble-wrap[data-id="${msg.id}"]`);

  if (scope === 'me') {
    if (wrap) markBubbleDeleted(wrap, false);
    const { error } = await db.from('messages')
      .update({ deleted_for_me: true })
      .eq('id', msg.id);
    if (error) {
      console.error('delete-for-me error:', error.message);
      showToast('⚠️', 'Could not delete');
      if (wrap) wrap.querySelector('.bubble')?.classList.remove('deleted');
    }
  }

  if (scope === 'all') {
    if (wrap) markBubbleDeleted(wrap, true);
    const { error } = await db.from('messages')
      .update({ deleted_for_all: true })
      .eq('id', msg.id)
      .eq('sender_id', currentUser.id);
    if (error) {
      console.error('delete-for-all error:', error.message);
      showToast('⚠️', 'Could not delete for everyone');
      if (wrap) {
        const bubble = wrap.querySelector('.bubble');
        if (bubble) { bubble.classList.remove('deleted'); bubble.textContent = msg.content; }
      }
    }
  }
}

function markBubbleDeleted(wrap, forAll) {
  const bubble = wrap?.querySelector('.bubble');
  if (!bubble) return;
  const isMine = wrap.classList.contains('mine');
  const label = (forAll && !isMine) ? 'This message was deleted'
              : (forAll &&  isMine) ? 'You deleted this message'
              : 'You deleted this message';
  bubble.className = 'bubble deleted';
  bubble.contentEditable = 'false';
  bubble.innerHTML = `<span class="deleted-icon">🚫</span>${label}`;
  const tick = wrap.querySelector('.read-tick');
  if (tick) tick.style.display = 'none';
  const fresh = wrap.cloneNode(true);
  wrap.parentNode?.replaceChild(fresh, wrap);
}

async function saveEdit(id, newText, textSpanEl, wrap) {
  const { error } = await db.from('messages')
    .update({ content: newText, edited: true })
    .eq('id', id).eq('sender_id', currentUser.id);
  if (error) { showToast('⚠️', 'Edit failed'); return; }
  textSpanEl.textContent = newText;
  const w = wrap || textSpanEl.closest('.bubble-wrap');
  let editedEl = w?.querySelector('.edited-label');
  if (!editedEl) {
    editedEl = document.createElement('span');
    editedEl.className = 'edited-label';
    editedEl.textContent = 'edited';
    const meta = w?.querySelector('.bubble-meta');
    if (meta) meta.insertBefore(editedEl, meta.firstChild);
  }
  showToast('✎', 'Message updated');
}

// ═══════════════════════════════════════════════════════════════
//  FEATURE: IMAGE SENDING
// ═══════════════════════════════════════════════════════════════
let _pendingImages = [];

function triggerImagePick() {
  document.getElementById('img-file-input').click();
}

function onImageSelected(e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;

  const valid = files.filter(f => {
    if (!f.type.startsWith('image/')) { showToast('⚠️', `${f.name} is not an image`); return false; }
    if (f.size > 10 * 1024 * 1024)   { showToast('⚠️', `${f.name} too large (max 10 MB)`); return false; }
    return true;
  });
  if (!valid.length) return;

  const remaining = 9 - _pendingImages.length;
  const toAdd = valid.slice(0, remaining);
  if (valid.length > remaining) showToast('⚠️', `Max 9 images at once`);

  toAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      _pendingImages.push({ file, dataUrl: ev.target.result });
      renderImagePreviews();
      updateActionBtn();
    };
    reader.readAsDataURL(file);
  });
}

function renderImagePreviews() {
  const wrap = document.getElementById('img-preview-wrap');
  const strip = document.getElementById('img-preview-strip');
  if (!strip) return;
  strip.innerHTML = '';
  _pendingImages.forEach((item, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'img-thumb-item';
    thumb.innerHTML = `
      <img src="${item.dataUrl}" class="img-preview-thumb" />
      <button class="img-thumb-remove" onclick="removeImageAt(${idx})">✕</button>
    `;
    strip.appendChild(thumb);
  });
  wrap.classList.toggle('show', _pendingImages.length > 0);
}

function removeImageAt(idx) {
  _pendingImages.splice(idx, 1);
  renderImagePreviews();
  updateActionBtn();
}

function cancelImageSend() {
  _pendingImages = [];
  const wrap = document.getElementById('img-preview-wrap');
  const strip = document.getElementById('img-preview-strip');
  if (strip) strip.innerHTML = '';
  wrap?.classList.remove('show');
  updateActionBtn();
}

async function sendImageMessage() {
  if (!_pendingImages.length) return;
  const images = [..._pendingImages];
  cancelImageSend();

  showToast('🖼', `Sending ${images.length} image${images.length > 1 ? 's' : ''}…`);

  const uploadOne = async (item) => {
    const ext = item.file.name.split('.').pop() || 'jpg';
    const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;
    const { error } = await db.storage.from('images')
      .upload(filename, item.file, { contentType: item.file.type, upsert: false });
    if (error) { console.error('upload error:', error); return null; }
    const { data } = db.storage.from('images').getPublicUrl(filename);
    return data.publicUrl;
  };

  if (images.length === 1) {
    const url = await uploadOne(images[0]);
    if (!url) { showToast('⚠️', 'Upload failed'); return; }
    const extra = _replyTarget
      ? { reply_to_id: _replyTarget.id, reply_preview: _replyTarget.content?.slice(0,60) }
      : {};
    cancelReply();
    await sendSpecial('image', url, extra);
  } else {
    const urls = await Promise.all(images.map(uploadOne));
    const failed = urls.filter(u => !u).length;
    const good   = urls.filter(Boolean);
    if (!good.length) { showToast('⚠️', 'All uploads failed'); return; }
    if (failed)       showToast('⚠️', `${failed} image(s) failed to upload`);
    const extra = _replyTarget
      ? { reply_to_id: _replyTarget.id, reply_preview: _replyTarget.content?.slice(0,60) }
      : {};
    cancelReply();
    await sendSpecial('images', JSON.stringify(good), extra);
  }
}

function openImgViewer(src) {
  document.getElementById('img-viewer-img').src = src;
  document.getElementById('img-viewer').classList.add('show');
}
function closeImgViewer() { document.getElementById('img-viewer').classList.remove('show'); }

// ═══════════════════════════════════════════════════════════════
//  FEATURE: STICKER PICKER
// ═══════════════════════════════════════════════════════════════
const STICKER_CATS = [
  ['💛','❤️','🧡','💜','💙','🖤','💚','🤍','💕','💞','💓','💗','💘','💝','💖','🫶','💋','😘','🥰','😍'],
  ['🥺','🥹','😊','🤭','🫣','😌','😏','🥲','😂','🤣','😭','😅','😇','🤩','😜','🫠','🤗','🤔','😴','🫡'],
  ['🌙','✨','🌟','💫','⭐','🌠','🌌','🌃','🌆','🌉','🕯','🪔','💤','😴','🌛','🌜','🌝','☁️','🌧','⛈'],
  ['🌸','🌷','🌹','🌺','🌻','💐','🍀','🌿','🍃','🌱','🦋','🐝','🌈','☀️','🌊','🏖','🫧','🍓','🍑','🍒'],
  ['🎉','🎊','🎈','🎀','🎁','🏆','🥇','👑','💎','🔮','🪄','🎶','🎵','🎸','🎹','🎤','🎧','📸','🍕','🍔'],
];

function showStickerCat(idx, btn) {
  document.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const grid = document.getElementById('sticker-grid');
  grid.innerHTML = STICKER_CATS[idx]
    .map(s => `<div class="sticker-item" onclick="sendSticker('${s}')">${s}</div>`).join('');
}

function toggleStickerPicker() {
  const picker = document.getElementById('sticker-picker');
  const btn    = document.getElementById('sticker-btn');
  const isOpen = picker.classList.contains('show');
  picker.classList.toggle('show', !isOpen);
  btn?.classList.toggle('active', !isOpen);
  if (!isOpen) {
    closeEmojiPicker();
    const firstTab = document.querySelector('.sticker-tab');
    if (firstTab && !document.getElementById('sticker-grid').children.length) {
      showStickerCat(0, firstTab);
    }
  }
}

function closeStickerPicker() {
  document.getElementById('sticker-picker').classList.remove('show');
  document.getElementById('sticker-btn')?.classList.remove('active');
}

async function sendSticker(emoji) {
  closeStickerPicker();
  const extra = _replyTarget ? { reply_to_id: _replyTarget.id, reply_preview: _replyTarget.content?.slice(0,60) } : {};
  cancelReply();
  await sendSpecial('sticker', emoji, extra);
  if (navigator.vibrate) navigator.vibrate(30);
}

document.addEventListener('click', e => {
  if (!e.target.closest('#sticker-picker') && !e.target.closest('#sticker-btn')) {
    closeStickerPicker();
  }
});
