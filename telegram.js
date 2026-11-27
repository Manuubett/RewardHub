// telegram.js: makes SemaRewards work as a Telegram Mini App. Load it BEFORE app.js (see index.html).
// Outside Telegram it does nothing, so the normal website keeps working.
import { auth, db, API_URL } from './firebase-config.js';
import { onAuthStateChanged, signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const APP_LINK = 'https://t.me/sidehusle254Bot/quiz';   // CHANGE: your Mini App link from BotFather
const tg = window.Telegram && window.Telegram.WebApp;
const inTg = !!(tg && tg.initData);

if (inTg) {
  tg.ready(); tg.expand();

  // Referral code from https://t.me/bot/app?startapp=CODE (app.js reads rh_ref when the friend signs up)
  const sp = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
  if (sp && /^[A-Za-z0-9]{4,12}$/.test(sp)) localStorage.rh_ref = sp.toUpperCase();

  // Open partner pages with Telegram's own opener. Telegram can't use the "open a blank tab, fill it in later" trick,
  // so window.open('about:blank') returns a stand-in whose location.href opens the link when it is set.
  const openExternal = u => {
    try { /^https:\/\/(t|telegram)\.me\//.test(u) ? tg.openTelegramLink(u) : tg.openLink(u); } catch (e) { location.href = u; }
  };
  window.open = u => {
    if (!u || u === 'about:blank') return { opener: null, close() {}, location: { set href(x) { openExternal(x); } } };
    openExternal(u); return { opener: null, close() {}, location: {} };
  };
  document.addEventListener('click', e => {   // WhatsApp community, share buttons, "pop-up blocked" links
    const a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (a) { e.preventDefault(); openExternal(a.href); }
  });

  // When the user comes back from a partner page, run the "I'm back" visit check right away
  tg.onEvent('activated', () => window.dispatchEvent(new Event('pageshow')));

  // Hide the adult-content tasks (BTN015 to BTN020) inside Telegram
  document.head.insertAdjacentHTML('beforeend', '<style>.card.opp:has(.tag.warn),.card:has(> .tag.warn),.rule.adult{display:none!important}</style>');
}

// Invite link used by the Refer & Earn page
window.tgReferralLink = code => inTg ? APP_LINK + '?startapp=' + encodeURIComponent(code) : null;

// Sign in with Telegram: server checks Telegram's signature and returns a Firebase login token
let tried = false;
onAuthStateChanged(auth, async u => {
  if (u || !inTg || tried) return;
  tried = true;
  try {
    const r = await fetch(API_URL.replace(/\/+$/, '') + '/auth/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData })
    });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Login failed');
    const c = await signInWithCustomToken(auth, j.token);
    const has = (await getDoc(doc(db, 'users', c.user.uid))).exists();
    location.hash = has ? '#/dashboard' : '#/setup';   // first visit: ask for the M-Pesa number
  } catch (e) {
    console.error(e);
    const app = document.getElementById('app');
    if (app) app.insertAdjacentHTML('afterbegin', '<div class="msg" role="alert">Telegram login failed: ' + String(e.message || e).replace(/[<>&]/g, '') + '. Close and reopen the app.</div>');
  }
});
