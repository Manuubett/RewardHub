import { auth, db, API_URL } from './firebase-config.js';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where, addDoc, setDoc, updateDoc, serverTimestamp, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { createUserUI } from './user-ui.js';
import { createAdminReview } from './admin-review.js';

const $ = s => document.querySelector(s), app = $('#app');
// Referral link: https://site/?ref=CODE  -> remember the code until the friend creates an account
{ const r = new URLSearchParams(location.search).get('ref'); if (r && /^[A-Za-z0-9]{4,12}$/.test(r)) localStorage.rh_ref = r.toUpperCase(); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kes = n => 'KES ' + Number(n || 0).toLocaleString();
const pts = n => Number(n || 0).toLocaleString() + ' pts';
// Conversion rate: 10 points = KES 1. Display only; the server must do the real conversion.
const PTS_PER_KES = 10;
const ptsKes = n => 'KES ' + (Number(n || 0) / PTS_PER_KES).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ptsVal = n => `${pts(n)} <span class="mute" style="font-size:.9rem">≈ ${ptsKes(n)}</span>`;
const MIN_PAY = 100;   // minimum payment request in KES (keep in sync with server.js)
const availKes = p => Math.max(0, p?.approved || 0) + Math.max(0, Math.floor((p?.approvedPoints || 0) / PTS_PER_KES));   // cash balance + approved points in KES
const RATE_NOTE = `<p class="mute">Conversion rate: <b>${PTS_PER_KES} points = KES 1</b></p>`;
const delta = n => n ? (n > 0 ? '+' : '') + Number(n).toLocaleString() : '—';
const STATUS_TXT = { started: 'Started', pending_review: 'Awaiting review', approved: 'Approved', rejected: 'Rejected', reversed: 'Reversed', expired: 'Expired' };
const LEDGER_TXT = { reward_pending: 'Partner confirmed (pending)', reward_approved: 'Approved', reward_rejected: 'Rejected', reward_reversed: 'Reversed by partner', admin_adjustment: 'Adjustment', payment_request: 'Payment requested', payment_refund: 'Payment refunded', referral_bonus: 'Referral bonus', streak_bonus: 'Streak bonus' };
const stat = s => `<span class="${esc(s)}">${esc(STATUS_TXT[s] || s)}</span>`;
const call = n => async d => {
  const r = await fetch(API_URL.replace(/\/+$/, '') + '/api/' + n, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await auth.currentUser.getIdToken() }, body: JSON.stringify(d || {}) });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Could not reach the server.'); e.data = j; throw e; } return j;
};
const when = t => t?.toDate ? t.toDate().toLocaleString() : '';
const rows = async (q) => (await getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
const byDate = (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
const note = (m) => `<div class="msg" role="status">${esc(m)}</div>`;
const err = e => (e.message || String(e)).replace(/^.*?: /, '');
const AUTH_MSG = {
  'auth/email-already-in-use': 'That email is already registered. Try logging in instead.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/weak-password': 'Password is too weak. Use at least 8 characters.',
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection. Check your internet and try again.',
  'auth/user-disabled': 'This account is disabled. Contact support.'
};
const authErr = e => AUTH_MSG[e?.code] || err(e);
const normPhone = s => { let p = String(s || '').replace(/[\s\-+]/g, ''); if (p.startsWith('0')) p = '254' + p.slice(1); return p; };
const phoneOk = p => /^2547\d{8}$|^2541\d{8}$/.test(p);   // same rule as server.js
const deviceId = localStorage.rh_dev || (localStorage.rh_dev = crypto.randomUUID());
let user = null, profile = null, isAdmin = false, unsub = null, flash = '', registering = false;

// Earn / Opportunity / Dashboard pages (progress bars, moving cards) live in user-ui.js; the admin Review tab lives in admin-review.js.
const UI = createUserUI({ $, app, esc, pts, ptsVal, ptsKes, kes, note, err, call, rows, byDate, when, stat, availKes, MIN_PAY, RATE_NOTE,
  db, collection, query, where, getDoc, doc, getUser: () => user, getProfile: () => profile, route });
const RV = createAdminReview({ $, app, esc, pts, when, stat, call, err });

onAuthStateChanged(auth, async u => {
  user = u; unsub?.(); profile = null; isAdmin = false;
  if (u) {
    // Admin = custom claim `admin: true` OR a document at admins/{uid} (same rule as the server and Firestore rules).
    isAdmin = await u.getIdTokenResult(true).then(t => t.claims.admin === true, () => false)
      || await getDoc(doc(db, 'admins', u.uid)).then(d => d.exists(), () => false);
    unsub = onSnapshot(doc(db, 'users', u.uid), s => { profile = s.data() || null; if (!/login|setup|support|admin|task|opportunity/.test(location.hash)) route(); }, e => console.error('profile listener', e));
  }
  if (!registering) route();
});
window.onhashchange = route;

function nav() {
  const L = user ? [['dashboard', 'Dashboard'], ['earn', 'Earn'], ['wallet', 'Wallet'], ['withdraw', 'Request Payment'], ['history', 'History'], ['referrals', 'Refer & Earn'], ['support', 'Support']] : [['home', 'Home'], ['login', 'Log in']];
  if (isAdmin) L.push(['admin', 'Admin']);
  const cur = location.hash.split('/')[1] || 'home';
  $('#nav').innerHTML = L.map(([k, t]) => `<a href="#/${k}" class="${cur === k ? 'on' : ''}">${t}</a>`).join('') + (user ? '<a href="#" id="out">Log out</a>' : '');
  $('#out')?.addEventListener('click', e => { e.preventDefault(); signOut(auth); location.hash = '#/home'; });
}

async function route() {
  UI.stop(); nav(); const [, p = 'home', arg] = location.hash.split('/');
  const open = ['home', 'login'];
  if (!user && !open.includes(p)) return (location.hash = '#/login');
  try { app.innerHTML = await (pages[p] || pages.home)(arg); bind[p]?.(arg); } catch (e) { app.innerHTML = note(err(e)); }
}

const pages = {
home: () => `<section class="hero"><h1>A side hustle for Kenyans. Don't stay idle online.</h1>
  <p>Got internet and some free time? Visit SemaRewards, see what's new, complete sponsored tasks and earn points. Redeem your approved points to M-Pesa.</p>
  <a class="btn gold" href="#/${user ? 'earn' : 'login'}">${user ? 'See opportunities' : 'Create free account'}</a></section>
  <h2>How it works</h2><ol class="steps"><li><b>Pick an opportunity</b><br><span class="mute">Read the requirements and reward first.</span></li>
  <li><b>Complete it</b><br><span class="mute">Follow the partner's steps exactly and wait until the page has fully loaded before you leave.</span></li>
  <li><b>Confirmation and review</b><br><span class="mute">Points show as pending, then approved after review.</span></li>
  <li><b>Redeem to M-Pesa</b><br><span class="mute">Request payment for your approved balance. 10 points = KES 1.</span></li></ol>
  <h2>Fair play</h2><p class="mute">Points are added only after the partner confirms your activity and we approve it. Clicking alone never earns points, and earnings are not guaranteed. One account per person and phone. Each opportunity has a waiting time before you can repeat it. Rewards the partner later reverses are removed. Accounts showing bot or duplicate activity are suspended. SemaRewards is for adults aged 18 and over, and some sponsored content from our partners may contain adult material.</p>
  ${UI.COMMUNITY}`,

  login: () => user ? (location.hash = '#/dashboard', '') : `<h1>Welcome</h1><form id="f">
  <div id="reg" hidden>${localStorage.rh_ref ? `<p class="msg">Invite code applied: <b>${esc(localStorage.rh_ref)}</b></p>` : ''}<label>Full name<input name="name" autocomplete="name"></label>
  <p class="mute">You must be 18 or older. Some sponsored content may contain adult material.</p>
  <label>M-Pesa phone (e.g. 0712345678)<input name="phone" inputmode="numeric" autocomplete="tel"></label></div>
  <label>Email<input name="email" type="email" required autocomplete="email" autocapitalize="none"></label>
  <label>Password<input name="pw" type="password" required autocomplete="current-password"></label>
  <button>Log in</button> <button type="button" class="alt" id="tog">Create account instead</button>
  <p><button type="button" class="alt" id="forgot">Forgot password?</button></p>
  <div id="m">${flash ? note(flash) : ''}</div></form>`,

  setup: () => `<h1>Finish setting up</h1><p class="mute">Your login works, but your profile was not completed. Add your details to continue.</p>
  <form id="f"><label>Full name<input name="name" required autocomplete="name"></label>
  <label>M-Pesa phone (e.g. 0712345678)<input name="phone" required inputmode="numeric" autocomplete="tel"></label>
  <button>Save</button><div id="m"></div></form>`,

  dashboard: UI.dashboard,
  earn: UI.earn,
  opportunity: UI.opportunity,
  referrals: UI.referrals,

  task: async id => {
    const c = await getDoc(doc(db, 'campaigns', id)); if (!c.exists()) return note('Task not found.');
    const x = c.data(), t = await getDoc(doc(db, 'tasks', `${user.uid}_${id}`));
    return `<h1>${esc(x.title)}</h1><div class="card"><div class="big">${kes(x.reward)}</div>
    <h2>Requirements</h2><p style="white-space:pre-wrap">${esc(x.requirements)}</p>
    <p class="mute">Reward stays pending until the advertiser confirms. Reversed conversions are deducted.</p>
    ${UI.WAIT_RULE}${UI.ADULT_NOTICE}
    ${t.exists() ? `<p>Your status: <b class="${t.data().status}">${t.data().status}</b></p>` : `<button id="go" data-id="${id}">Start task</button>`}<div id="m"></div></div>`;
  },

  wallet: async () => {
    const [pl, l] = await Promise.all([rows(query(collection(db, 'pointLedger'), where('uid', '==', user.uid))), rows(query(collection(db, 'ledger'), where('uid', '==', user.uid)))]);
    pl.sort(byDate); l.sort(byDate);
    return `<h1>Points wallet</h1><div class="grid"><div class="card"><div class="mute">Pending</div><div class="big">${ptsVal(profile?.pendingPoints)}</div></div>
    <div class="card"><div class="mute">Approved</div><div class="big">${ptsVal(profile?.approvedPoints)}</div></div></div>
    ${RATE_NOTE}<p class="mute">You can request payment for your approved balance from the Request Payment page.</p>
    <h2>Points activity</h2><div class="scroll"><table><tr><th>Date</th><th>Type</th><th>Pending</th><th>Approved</th></tr>
    ${pl.map(x => `<tr><td>${when(x.createdAt)}</td><td>${esc(LEDGER_TXT[x.type] || x.type)}</td><td>${delta(x.pendingDelta)}</td><td>${delta(x.approvedDelta)}</td></tr>`).join('') || '<tr><td colspan=4>No points activity yet.</td></tr>'}</table></div>
    ${l.length || profile?.approved || profile?.pending ? `<h2>Cash wallet (earlier tasks)</h2><div class="grid"><div class="card"><div class="mute">Pending</div><div class="big">${kes(profile?.pending)}</div></div>
    <div class="card"><div class="mute">Approved (payable)</div><div class="big">${kes(profile?.approved)}</div></div></div>
    <div class="scroll"><table><tr><th>Date</th><th>Type</th><th>Amount</th></tr>
    ${l.map(x => `<tr><td>${when(x.createdAt)}</td><td>${x.type.replace('_', ' ')}</td><td>${kes(x.amount)}</td></tr>`).join('')}</table></div>` : ''}`;
  },

  withdraw: async () => {
    const w = (await rows(query(collection(db, 'withdrawals'), where('uid', '==', user.uid)))).sort(byDate);
    const avail = availKes(profile), cash = Math.max(0, profile?.approved || 0), ap = Math.max(0, profile?.approvedPoints || 0);
    const can = avail >= MIN_PAY, short = Math.max(0, MIN_PAY * PTS_PER_KES - (cash * PTS_PER_KES + ap));
    return `<h1>Request payment</h1>${RATE_NOTE}
    <div class="grid"><div class="card"><div class="mute">Available to request</div><div class="big">${kes(avail)}</div>
    <div class="mute">${pts(ap)} approved${cash > 0 ? ' + ' + kes(cash) + ' cash balance' : ''}</div></div></div>
    <form id="f"><p class="mute">Payment is sent to ${esc(profile?.phone)} after review. Minimum ${kes(MIN_PAY)} (${pts(MIN_PAY * PTS_PER_KES)}).</p>
    ${can ? '' : note(`You need at least ${kes(MIN_PAY)} to request payment. Earn ${pts(short)} more to unlock it.`)}
    <label>Amount (KES)<input name="amt" type="number" min="${MIN_PAY}" max="${avail}" step="1" required ${can ? '' : 'disabled'}></label>
    <button id="req" disabled>Request payment</button><div id="m"></div></form>
    <h2>Your payment requests</h2><div class="scroll"><table><tr><th>Date</th><th>Amount</th><th>Status</th><th>Note</th></tr>
    ${w.map(x => `<tr><td>${when(x.createdAt)}</td><td>${kes(x.amount)}</td><td class="${x.status}">${x.status}</td><td>${esc(x.note)}</td></tr>`).join('') || '<tr><td colspan=4>None yet.</td></tr>'}</table></div>`;
  },

  history: async () => {
    const [a, t] = await Promise.all([rows(query(collection(db, 'activityAttempts'), where('uid', '==', user.uid))), rows(query(collection(db, 'tasks'), where('uid', '==', user.uid)))]);
    a.sort(byDate); t.sort(byDate);
    return `<h1>History</h1><div class="scroll"><table><tr><th>Date</th><th>Opportunity</th><th>Points</th><th>Status</th><th>Note</th></tr>
    ${a.map(x => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.opportunityCode)} · ${esc(x.opportunityTitle)}</td><td>${ptsVal(x.rewardPoints)}</td><td>${stat(x.status)}</td><td>${esc(x.reviewNote)}</td></tr>`).join('') || '<tr><td colspan=5>No activity yet.</td></tr>'}</table></div>
    ${t.length ? `<h2>Earlier cash tasks</h2><div class="scroll"><table><tr><th>Date</th><th>Task</th><th>Reward</th><th>Status</th></tr>
    ${t.map(x => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.title)}</td><td>${kes(x.reward)}</td><td class="${x.status}">${x.status}</td></tr>`).join('')}</table></div>` : ''}
    <p class="mute">Points movements appear under Wallet.</p>`;
  },

  support: async () => {
    const k = (await rows(query(collection(db, 'tickets'), where('uid', '==', user.uid)))).sort(byDate);
    return `<h1>Support</h1><form id="f"><label>Subject<input name="s" required maxlength="100"></label>
    <label>Describe the problem or complaint<textarea name="m" rows="5" required maxlength="2000"></textarea></label><button>Send</button><div id="m"></div></form>
    <h2>Your messages</h2>${k.map(x => `<div class="card"><b>${esc(x.subject)}</b><p>${esc(x.message)}</p>${x.reply ? `<p class="msg">Support: ${esc(x.reply)}</p>` : '<span class="mute">Awaiting reply</span>'}</div>`).join('') || '<p class="mute">No messages yet.</p>'}`;
  },

  admin: async (tab = 'overview') => {
    if (!isAdmin) return note('Admins only.');
    const [users, wd, led, partners, pays, camps, tix] = await Promise.all(['users', 'withdrawals', 'ledger', 'partners', 'partnerPayments', 'campaigns', 'tickets'].map(c => rows(collection(db, c))));
    const now = Date.now() / 1e3, prof = d => led.filter(x => x.createdAt?.seconds > now - d * 864e2).reduce((a, x) => a + (x.payout || 0) - (x.reward || 0), 0);
    const earn = led.filter(x => x.type === 'pending').reduce((a, x) => a + x.reward, 0);
    const owed = p => led.filter(x => x.partnerId === p).reduce((a, x) => a + (x.payout || 0), 0), paid = p => pays.filter(x => x.partnerId === p).reduce((a, x) => a + x.amount, 0);
    const pn = id => esc(partners.find(p => p.id === id)?.name || id), sus = users.filter(u => u.status !== 'active' || u.flags?.length);
    const ub = (u, s, t) => `<button class="alt" data-st="${s}" data-uid="${u.id}">${t}</button>`;
    // ---- SemaAfrica points: review, opportunities, report ----
    const [opps, atts, pled, waiting] = await Promise.all([rows(collection(db, 'opportunities')),
      rows(query(collection(db, 'activityAttempts'), orderBy('createdAt', 'desc'), limit(200))), rows(query(collection(db, 'pointLedger'), orderBy('createdAt', 'desc'), limit(500))),
      rows(query(collection(db, 'activityAttempts'), where('status', 'in', ['pending_review', 'started']), limit(500)))]);   // everything still waiting, not only the latest 200
    opps.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const sum = f => users.reduce((a, u) => a + (u[f] || 0), 0);
    const apprSince = d => pled.filter(x => x.type === 'reward_approved' && x.createdAt?.seconds > now - d * 864e2).reduce((a, x) => a + (x.approvedDelta || 0), 0);
    const queue = waiting;
    const cnt = (id, s) => atts.filter(a => a.opportunityId === id && (s === 'confirmed' ? ['pending_review', 'approved'].includes(a.status) : s === 'started' || a.status === s)).length;
    const oc = (v, t) => `<option value="${v}" ${v === t.cur ? 'selected' : ''}>${t.l}</option>`;
    const types = [['verified_offer', 'Verified offer'], ['signup', 'Sign-up'], ['install', 'App install'], ['survey', 'Survey'], ['permitted_click', 'Click (only if the partner explicitly pays/permits it)']];
    const oppForm = o => `<details class="card"><summary><b>${esc(o.code)}</b> ${esc(o.title)} · ${pts(o.rewardPoints)} · ${o.cooldownMinutes} min · <span class="${o.active ? 'active' : 'suspended'}">${o.active ? 'Active' : 'Paused'}</span>
      <span class="mute">· ${cnt(o.id, 'started')} started / ${cnt(o.id, 'confirmed')} confirmed / ${cnt(o.id, 'approved')} approved</span></summary>
      <form class="of" data-id="${o.id}" style="max-width:520px">
      <label>Title<input name="title" value="${esc(o.title)}" maxlength="80" required></label>
      <label>Provider name<input name="provider" value="${esc(o.provider)}" maxlength="60"></label>
      <label>Partner (needed for signed confirmations)<select name="partnerId"><option value="">None (manual evidence only)</option>${partners.map(p => oc(p.id, { cur: o.partnerId, l: esc(p.name) })).join('')}</select></label>
      <label>Provider zone / reference<input name="providerZoneId" value="${esc(o.providerZoneId)}" maxlength="60"></label>
      <label>Destination URL (https)<input name="destinationUrl" type="url" value="${esc(o.destinationUrl)}"></label>
      <label>Tracking parameter name<input name="trackingParam" value="${esc(o.trackingParam || 'click_id')}" maxlength="30"></label>
      <label>Activity type<select name="activityType">${types.map(([v, l]) => oc(v, { cur: o.activityType, l })).join('')}</select></label>
      <label>Reward (points)<input name="rewardPoints" type="number" min="0" step="1" value="${+o.rewardPoints || 0}"></label>
      <label>Cooldown (minutes)<input name="cooldownMinutes" type="number" min="1" step="1" value="${+o.cooldownMinutes || 30}"></label>
      <label>Requirements shown to users<textarea name="requirements" rows="3" maxlength="1000">${esc(o.requirements)}</textarea></label>
      <label><input type="checkbox" name="incentiveApproved" ${o.incentiveApproved ? 'checked' : ''}> The provider has given written permission for rewarded activity</label>
      <label>Where is that permission recorded?<input name="providerPermissionNote" value="${esc(o.providerPermissionNote)}" maxlength="500" placeholder="e.g. email from provider, date / reference"></label>
      <label><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Active (visible to users)</label>
      <button>Save</button></form></details>`;
    // ---- Manual payment requests ----
    const OPEN = ['pending', 'submission_failed', 'submission_error', 'needs_review'];
    const uf = id => users.find(u => u.id === id) || {}, local = ph => String(ph || '').replace(/^254/, '0');
    const toPay = wd.filter(w => OPEN.includes(w.status)).sort((a, b) => byDate(b, a)), done = wd.filter(w => !OPEN.includes(w.status)).sort(byDate);
    const payCard = w => { const u = uf(w.uid), how = [w.pointsDeducted ? pts(w.pointsDeducted) : '', w.cashDeducted ? kes(w.cashDeducted) + ' cash balance' : ''].filter(Boolean).join(' + ');
      return `<div class="card"><div class="paycard"><div>
      <b>${esc(w.name || u.name)}</b> <span class="tag ${esc(w.status)}">${esc(w.status)}</span><br>
      M-Pesa number: <b>${esc(local(w.phone))}</b> <span class="mute">(${esc(w.phone)})</span> <button type="button" class="alt" data-copy="${esc(w.phone)}">Copy</button><br>
      <span class="mute">Requested ${when(w.createdAt)} · Account: ${esc(u.status || 'unknown')}${u.flags?.length ? ' · ⚠ ' + esc(u.flags.join(', ')) : ''}</span></div>
      <div><div class="big">${kes(w.amount)}</div><div class="mute">${how ? 'Deducted: ' + how : ''}</div></div></div>
      ${['submission_error', 'needs_review'].includes(w.status) ? note('This may already have been sent through M-Pesa. Check your M-Pesa statement before paying again.') : ''}
      <p><button data-w="${w.id}" data-d="paid">Mark as paid</button> <button class="bad" data-w="${w.id}" data-d="rejected">Reject &amp; refund</button></p></div>`; };
    const attention = [['Payments to make', toPay.length, 'payments'], ['Awaiting review', queue.length, 'review'], ['Open support tickets', tix.filter(t => !t.reply).length, 'support']];
    const S = {};
    S.overview = `<h1>Overview</h1><div class="grid">${attention.map(([l, n, k]) => `<a class="card" href="#/admin/${k}"><div class="mute">${l}</div><div class="big">${n}</div></a>`).join('')}</div>
      <h2>Points</h2><div class="grid"><div class="card"><div class="mute">Pending points (all users)</div><div class="big">${ptsVal(sum('pendingPoints'))}</div></div>
      <div class="card"><div class="mute">Approved balance (all users)</div><div class="big">${ptsVal(sum('approvedPoints'))}</div></div>
      <div class="card"><div class="mute">Approved in last 7 days</div><div class="big">${ptsVal(apprSince(7))}</div></div>
      <div class="card"><div class="mute">Approved in last 30 days</div><div class="big">${ptsVal(apprSince(30))}</div></div></div>
      <p class="mute">Rate: ${PTS_PER_KES} points = KES 1. Counts come from SemaAfrica's own records (latest 200 activities), not from provider reports.</p>
      <h2>Profit (earlier cash tasks)</h2><div class="grid"><div class="card"><div class="mute">Last 24 hours</div><div class="big">${kes(prof(1))}</div></div>
      <div class="card"><div class="mute">Last 7 days</div><div class="big">${kes(prof(7))}</div></div><div class="card"><div class="mute">Last 30 days</div><div class="big">${kes(prof(30))}</div></div>
      <div class="card"><div class="mute">Rewards credited (all time)</div><div class="big">${kes(earn)}</div></div></div>`;
    S.review = RV.html(users, waiting, atts.filter(a => !['started', 'pending_review'].includes(a.status)));
    S.payments = `<h1>Payments</h1><h2>Payments to make (${toPay.length})</h2><p class="mute">Send the money manually from M-Pesa to the number shown, then press <b>Mark as paid</b> and enter the M-Pesa confirmation code. Reject refunds the user's balance.</p>
      ${toPay.map(payCard).join('') || '<p class="mute">No payment requests waiting.</p>'}
      <h2>Payment history</h2><div class="scroll"><table><tr><th>Requested</th><th>Name</th><th>M-Pesa number</th><th>Amount</th><th>Status</th><th>M-Pesa code / note</th></tr>
      ${done.map(w => `<tr><td>${when(w.createdAt)}</td><td>${esc(w.name)}</td><td>${esc(local(w.phone))}</td><td>${kes(w.amount)}</td><td class="${esc(w.status)}">${esc(w.status)}</td><td>${esc(w.mpesaReceipt || w.note || '')}</td></tr>`).join('') || '<tr><td colspan=6>None yet.</td></tr>'}</table></div>`;
    S.opportunities = `<h1>Opportunities</h1><p class="mute">${opps.length} opportunities. Tap one to edit it. New ones start paused: fill in the URL, reward and requirements, then tick Active.</p><p><button id="addbtn">Add a new BTN</button></p>${opps.length < 20 ? `<p><button id="seed">Create the missing BTN001–BTN020 entries</button> <span class="mute">${opps.length} of 20 exist. New ones start paused.</span></p>` : ''}
      ${opps.map(oppForm).join('')}`;
    S.users = `<h1>Users</h1><h2>Suspicious accounts</h2><div class="scroll"><table><tr><th>User</th><th>Phone</th><th>Status</th><th>Flags</th><th></th></tr>
      ${sus.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.phone)}</td><td class="${esc(u.status)}">${esc(u.status)}</td><td>${esc((u.flags || []).join(', '))}</td><td>${ub(u, 'suspended', 'Suspend')} ${ub(u, 'active', 'Clear')}</td></tr>`).join('') || '<tr><td colspan=5>Nothing flagged.</td></tr>'}</table></div>
      <h2>All users (${users.length})</h2><div class="scroll"><table><tr><th>Name</th><th>Phone</th><th>Status</th><th>Pending pts</th><th>Approved pts</th><th>Cash pending</th><th>Cash approved</th></tr>
      ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.phone)}</td><td class="${esc(u.status)}">${esc(u.status)}</td><td>${pts(u.pendingPoints)}</td><td>${pts(u.approvedPoints)}</td><td>${kes(u.pending)}</td><td>${kes(u.approved)}</td></tr>`).join('')}</table></div>`;
    S.partners = `<h1>Partners</h1><h2>Advertising partners</h2><form id="pf" class="wide row"><input name="n" placeholder="Partner name" required><button>Add partner</button></form>
      <div class="scroll"><table><tr><th>Partner</th><th>ID</th><th>Secret (give to partner)</th><th>Owed</th><th>Paid</th><th>Balance</th></tr>
      ${partners.map(p => `<tr><td>${esc(p.name)}</td><td>${p.id}</td><td>${esc(p.secret)}</td><td>${kes(owed(p.id))}</td><td>${kes(paid(p.id))}</td><td>${kes(paid(p.id) - owed(p.id))}</td></tr>`).join('') || '<tr><td colspan=6>No partners yet.</td></tr>'}</table></div>
      <h2>Record advertiser payment</h2><form id="payf"><select name="p">${partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <input name="a" type="number" min="1" placeholder="Amount received (KES)" required><input name="r" placeholder="Reference (bank / M-Pesa code)"><button>Record payment</button></form>`;
    S.campaigns = `<h1>Campaigns</h1><h2>Add campaign</h2><form id="cf" style="max-width:520px"><select name="p">${partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <input name="t" placeholder="Title" required><input name="u" type="url" placeholder="Partner tracking URL (https://…)" required>
      <input name="rw" type="number" min="1" placeholder="User reward (KES)" required><input name="po" type="number" min="1" placeholder="Advertiser pays you (KES)" required>
      <select name="ty"><option value="conversion">Pays on completed action</option><option value="cpc">Pays for valid click (partner-confirmed)</option></select>
      <textarea name="q" rows="3" placeholder="Requirements shown to users" required></textarea><button>Add campaign</button></form>
      <h2>All campaigns</h2><div class="scroll"><table><tr><th>Title</th><th>Partner</th><th>Reward</th><th>Active</th><th></th></tr>
      ${camps.map(c => `<tr><td>${esc(c.title)}</td><td>${pn(c.partnerId)}</td><td>${kes(c.reward)}</td><td>${c.active}</td><td><button class="alt" data-c="${c.id}" data-on="${!c.active}">${c.active ? 'Pause' : 'Resume'}</button></td></tr>`).join('') || '<tr><td colspan=5>No campaigns yet.</td></tr>'}</table></div>`;
    S.support = `<h1>Support tickets</h1>${tix.sort(byDate).map(t => `<div class="card" style="margin:.7rem 0"><b>${esc(t.subject)}</b> <span class="mute">${esc(users.find(u => u.id === t.uid)?.name)}</span><p>${esc(t.message)}</p>
      <form class="wide rf row" data-t="${t.id}"><input name="r" value="${esc(t.reply || '')}" placeholder="Reply"><button>Reply</button></form></div>`).join('') || '<p class="mute">No tickets.</p>'}`;
    S.top = `<h1>Top users</h1><p class="mute">Ranked by <b>approved</b> points only (reviewed and partner-confirmed). Flagged and suspended accounts are left out, and names are shortened. Only share names of members who are comfortable with it.</p>
      <div class="chips" id="topchips"><button type="button" data-p="week" class="on">This week</button><button type="button" data-p="month" class="alt">This month</button><button type="button" data-p="all" class="alt">All time</button></div>
      <div id="topbox"><p class="mute">Loading…</p></div>`;
    const tabs = [['overview', 'Overview', 0], ['review', 'Review', queue.length], ['payments', 'Payments', toPay.length], ['top', 'Top users', 0], ['opportunities', 'Opportunities', 0], ['users', 'Users', sus.length], ['partners', 'Partners', 0], ['campaigns', 'Campaigns', 0], ['support', 'Support', attention[2][1]]];
    const cur = S[tab] ? tab : 'overview';
    return `<div class="admin"><aside class="side"><div class="side-h">Admin</div><nav>${tabs.map(([k, l, n]) => `<a href="#/admin/${k}" class="${k === cur ? 'on' : ''}">${l}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('')}</nav></aside><section class="panel">${S[cur]}</section></div>`;
  }
};

const msg = (h, t) => { const m = $('#m'); if (m) m.innerHTML = note(t); };
const bind = {
  login() {
    let reg = false; const f = $('#f'); if (!f) return;
    const submit = f.querySelector('button'), tog = $('#tog');
    tog.onclick = () => {
      reg = !reg; flash = ''; $('#m').innerHTML = ''; $('#reg').hidden = !reg;
      submit.textContent = reg ? 'Create account' : 'Log in'; tog.textContent = reg ? 'I have an account' : 'Create account instead';
      f.pw.autocomplete = reg ? 'new-password' : 'current-password';
    };
    $('#forgot').onclick = async () => {
      const email = f.email.value.trim();
      if (!email) return msg(0, 'Type your email above first, then tap Forgot password.');
      try { await sendPasswordResetEmail(auth, email); } catch (x) { if (x.code !== 'auth/user-not-found') return msg(0, authErr(x)); }
      msg(0, 'If that email has an account, a reset link is on its way. Check your spam folder too.');
    };
    f.onsubmit = async e => {
      e.preventDefault(); flash = ''; $('#m').innerHTML = '';
      const d = Object.fromEntries(new FormData(f)); d.email = d.email.trim().toLowerCase();
      let phone = '';
      if (reg) {   // validate BEFORE creating the Firebase account
        d.name = (d.name || '').trim().replace(/\s+/g, ' '); phone = normPhone(d.phone);
        if (d.name.length < 2) return msg(0, 'Enter your full name.');
        if (!phoneOk(phone)) return msg(0, 'Enter a valid M-Pesa number, e.g. 0712345678.');
        if (d.pw.length < 8) return msg(0, 'Use a password of at least 8 characters.');
      }
      const label = submit.textContent; submit.disabled = tog.disabled = true; submit.textContent = 'Please wait…';
      let created = false; registering = reg;
      try {
        if (reg) {
          await createUserWithEmailAndPassword(auth, d.email, d.pw); created = true;
          await call('registerProfile')({ name: d.name, phone, deviceId, referralCode: localStorage.rh_ref || '' }); localStorage.removeItem('rh_ref');
        } else {
          const c = await signInWithEmailAndPassword(auth, d.email, d.pw);
          if (!(await getDoc(doc(db, 'users', c.user.uid))).exists()) { registering = false; location.hash = '#/setup'; return route(); }
        }
        registering = false; location.hash = '#/dashboard'; route();
      } catch (x) {
        if (created) await auth.currentUser?.delete().catch(() => {});   // only undo an account THIS attempt created
        registering = false; flash = authErr(x);
        submit.disabled = tog.disabled = false; submit.textContent = label; msg(0, flash);
      }
    };
  },
  setup() {
    const f = $('#f');
    f.onsubmit = async e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(f)), phone = normPhone(d.phone);
      if ((d.name || '').trim().length < 2 || !phoneOk(phone)) return msg(0, 'Enter your name and a valid M-Pesa number.');
      try { await call('registerProfile')({ name: d.name.trim(), phone, deviceId, referralCode: localStorage.rh_ref || '' }); localStorage.removeItem('rh_ref'); location.hash = '#/dashboard'; route(); } catch (x) { msg(0, err(x)); }
    };
  },
  dashboard: UI.bindDashboard,
  earn: UI.bindEarn,
  opportunity: UI.bindOpportunity,
  referrals: UI.bindReferrals,
  task(id) { const b = $('#go'); if (b) b.onclick = async () => { try { const r = await call('startTask')({ campaignId: id }); if (r.url) window.open(r.url, '_blank', 'noopener'); msg(0, 'Task started. Wait until the page has fully loaded, then come back to begin another task. If you leave early, your points will not be approved.'); b.remove(); } catch (x) { msg(0, err(x)); } }; },
  withdraw() {
    const f = $('#f'), btn = $('#req'), max = availKes(profile);
    // Button stays inactive unless the amount is a whole number between KES 100 and the available balance
    const ok = () => { const v = Number(f.amt.value); return Number.isInteger(v) && v >= MIN_PAY && v <= max; };
    const sync = () => { btn.disabled = !ok(); };
    f.amt.addEventListener('input', sync); sync();
    f.onsubmit = async e => {
      e.preventDefault(); if (!ok()) return; btn.disabled = true;
      try { await call('requestWithdrawal')({ amount: +f.amt.value }); location.hash = '#/withdraw'; route(); } catch (x) { msg(0, err(x)); sync(); }
    };
  },
  support() { const f = $('#f'); f.onsubmit = async e => { e.preventDefault(); await addDoc(collection(db, 'tickets'), { uid: user.uid, subject: f.s.value, message: f.m.value, createdAt: serverTimestamp(), reply: '' }); route(); }; },
  admin() {
    if (!isAdmin) return;   // page shows 'Admins only.'; nothing to bind
    const F = id => $(id) || {};   // forms exist only on some tabs
    const act = fn => async e => { try { await fn(e); route(); } catch (x) { alert(err(x)); } };
    $('#seed')?.addEventListener('click', act(() => call('adminSeedOpportunities')()));
    $('#addbtn')?.addEventListener('click', act(async () => { const r = await call('adminAddOpportunity')(); alert(`Created ${r.code} (paused). Open it, fill in the URL, reward and requirements, then tick Active.`); }));
    if ($('#topbox')) {   // Top users tab: analyse, show the best user, build a WhatsApp message
      const medals = ['🥇', '🥈', '🥉'], names = { week: 'this week', month: 'this month', all: 'of all time' };
      const load = async period => {
        $('#topbox').innerHTML = '<p class="mute">Analysing…</p>';
        try {
          const r = await call('adminTopUsers')({ period }), b = r.board;
          if (!b.length) { $('#topbox').innerHTML = note('No approved activity for this period yet.'); return; }
          const top = b[0], link = location.origin + location.pathname;
          const text = `🏆 SemaRewards top earners ${names[period]}\n\n` + b.slice(0, 5).map((u, i) => `${medals[i] || (i + 1) + '.'} ${u.name} · ${u.points.toLocaleString()} pts${u.activities != null ? ` · ${u.activities} tasks` : ''}`).join('\n')
            + `\n\nCongratulations! 🎉 You could be on the next list. Join SemaRewards: ${link}\n\nPoints are paid only after partner confirmation and review. Earnings are not guaranteed. 18+ only.`;
          $('#topbox').innerHTML = `<div class="hero-card"><div><div class="hc-label">Best overall user ${names[period]}</div><div class="hc-big">${esc(top.name)}</div>
            <div class="hc-sub">${pts(top.points)} · ≈ ${ptsKes(top.points)}${top.activities != null ? ` · ${top.activities} approved tasks` : ''}${top.streak ? ` · 🔥 ${top.streak}-day streak` : ''}</div></div></div>
            ${period === 'all' ? '' : `<div class="grid kpis"><div class="card kpi"><div class="mute">Active earners</div><div class="kv">${r.participants}</div></div><div class="card kpi"><div class="mute">Points approved</div><div class="kv">${pts(r.totalPoints)}</div></div></div>`}
            ${r.truncated ? note('Very busy period: only the latest 10,000 point entries were analysed, so totals may be slightly low.') : ''}
            <div class="scroll"><table><tr><th>#</th><th>User</th><th>Points</th><th>Tasks</th><th>Streak</th></tr>
            ${b.map((u, i) => `<tr><td>${medals[i] || i + 1}</td><td>${esc(u.name)}</td><td>${pts(u.points)}</td><td>${u.activities ?? '—'}</td><td>${u.streak || '—'}</td></tr>`).join('')}</table></div>
            <h2>WhatsApp message</h2><textarea id="topmsg" rows="9" class="wide" aria-label="WhatsApp message"></textarea>
            <div class="acts"><button class="gold" id="topcopy" type="button">Copy message</button><button id="topwa" type="button">Share on WhatsApp</button></div>`;
          $('#topmsg').value = text;
          $('#topcopy').onclick = () => navigator.clipboard?.writeText($('#topmsg').value).then(() => { $('#topcopy').textContent = 'Copied ✓'; }, () => {});
          $('#topwa').onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent($('#topmsg').value), '_blank', 'noopener');
        } catch (x) { $('#topbox').innerHTML = note(err(x)); }
      };
      $('#topchips').querySelectorAll('button').forEach(b => b.onclick = () => { $('#topchips').querySelectorAll('button').forEach(o => o.className = o === b ? 'on' : 'alt'); load(b.dataset.p); });
      load('week');
    }
    RV.bind();   // Review tab: search, filters, approve / reject, approve all per user
    app.querySelectorAll('.of').forEach(f => f.onsubmit = act(e => { e.preventDefault(); const v = n => f.elements[n].value;
      return call('adminUpdateOpportunity')({ id: f.dataset.id, title: v('title'), provider: v('provider'), partnerId: v('partnerId'), providerZoneId: v('providerZoneId'), destinationUrl: v('destinationUrl'),
        trackingParam: v('trackingParam'), activityType: v('activityType'), rewardPoints: +v('rewardPoints'), cooldownMinutes: +v('cooldownMinutes'), requirements: v('requirements'),
        incentiveApproved: f.elements.incentiveApproved.checked, providerPermissionNote: v('providerPermissionNote'), active: f.elements.active.checked }); }));
    app.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; }, () => {}));
    app.querySelectorAll('[data-w]').forEach(b => b.onclick = act(() => {
      const paid = b.dataset.d === 'paid';
      const n = prompt(paid ? 'Enter the M-Pesa confirmation code for this payment (e.g. SGH7K2L9QX):' : 'Reason for rejecting (the user\'s balance will be refunded):'); if (n === null) return;
      if (!paid || confirm('Confirm: you have already sent this payment through M-Pesa?')) return call('adminDecideWithdrawal')({ id: b.dataset.w, decision: b.dataset.d, note: n.trim() });
    }));
    app.querySelectorAll('[data-st]').forEach(b => b.onclick = act(() => call('adminSetUserStatus')({ uid: b.dataset.uid, status: b.dataset.st })));
    app.querySelectorAll('[data-c]').forEach(b => b.onclick = act(() => updateDoc(doc(db, 'campaigns', b.dataset.c), { active: b.dataset.on === 'true' })));
    app.querySelectorAll('.rf').forEach(f => f.onsubmit = act(e => { e.preventDefault(); return updateDoc(doc(db, 'tickets', f.dataset.t), { reply: f.r.value }); }));
    F('#pf').onsubmit = act(e => { e.preventDefault(); const s = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join(''); return addDoc(collection(db, 'partners'), { name: e.target.n.value, secret: s, createdAt: serverTimestamp() }); });
    F('#payf').onsubmit = act(e => { e.preventDefault(); const f = e.target; return addDoc(collection(db, 'partnerPayments'), { partnerId: f.p.value, amount: +f.a.value, ref: f.r.value, createdAt: serverTimestamp() }); });
    F('#cf').onsubmit = act(async e => { e.preventDefault(); const f = e.target; const r = await addDoc(collection(db, 'campaigns'), { partnerId: f.p.value, title: f.t.value, url: f.u.value, reward: +f.rw.value, type: f.ty.value, requirements: f.q.value, active: true, createdAt: serverTimestamp() }); await setDoc(doc(db, 'campaignCosts', r.id), { payout: +f.po.value }); });
  }
};
