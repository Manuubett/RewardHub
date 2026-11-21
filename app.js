import { auth, db, API_URL } from './firebase-config.js';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where, addDoc, setDoc, updateDoc, serverTimestamp, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const $ = s => document.querySelector(s), app = $('#app');
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
const LEDGER_TXT = { reward_pending: 'Partner confirmed (pending)', reward_approved: 'Approved', reward_rejected: 'Rejected', reward_reversed: 'Reversed by partner', admin_adjustment: 'Adjustment', payment_request: 'Payment requested', payment_refund: 'Payment refunded' };
const stat = s => `<span class="${esc(s)}">${esc(STATUS_TXT[s] || s)}</span>`;
const left = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`; };
let timer = null;
// Shows "Available again in ..." for every [data-until] element. The browser only DISPLAYS the cooldown; the server enforces it.
function countdowns() {
  clearInterval(timer); const els = [...app.querySelectorAll('[data-until]')]; if (!els.length) return;
  const tick = () => els.forEach(el => { const ms = +el.dataset.until - Date.now(); el.textContent = ms > 0 ? 'Available again in ' + left(ms) : 'Available now'; if (ms <= 0) $('#go')?.removeAttribute('disabled'); });
  tick(); timer = setInterval(tick, 1000);
}
const call = n => async d => {
  const r = await fetch(API_URL.replace(/\/+$/, '') + '/api/' + n, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await auth.currentUser.getIdToken() }, body: JSON.stringify(d || {}) });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Could not reach the server.'); e.data = j; throw e; } return j;
};
const when = t => t?.toDate ? t.toDate().toLocaleString() : '';
const rows = async (q) => (await getDocs(q)).docs.map(d => ({ id: d.id, ...d.data() }));
const byDate = (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
const note = (m) => `<div class="msg" role="status">${esc(m)}</div>`;
const err = e => (e.message || String(e)).replace(/^.*?: /, '');
const deviceId = localStorage.rh_dev || (localStorage.rh_dev = crypto.randomUUID());
let user = null, profile = null, isAdmin = false, unsub = null;

onAuthStateChanged(auth, async u => {
  user = u; unsub?.(); profile = null; isAdmin = false;
  if (u) {
    // Admin = custom claim `admin: true` OR a document at admins/{uid} (same rule as the server and Firestore rules).
    isAdmin = await u.getIdTokenResult(true).then(t => t.claims.admin === true, () => false)
      || await getDoc(doc(db, 'admins', u.uid)).then(d => d.exists(), () => false);
    unsub = onSnapshot(doc(db, 'users', u.uid), s => { profile = s.data() || null; if (!/login|support|admin|task|opportunity/.test(location.hash)) route(); }, () => {});
  }
  route();
});
window.onhashchange = route;

function nav() {
  const L = user ? [['dashboard', 'Dashboard'], ['earn', 'Earn'], ['wallet', 'Wallet'], ['withdraw', 'Request Payment'], ['history', 'History'], ['support', 'Support']] : [['home', 'Home'], ['login', 'Log in']];
  if (isAdmin) L.push(['admin', 'Admin']);
  const cur = location.hash.split('/')[1] || 'home';
  $('#nav').innerHTML = L.map(([k, t]) => `<a href="#/${k}" class="${cur === k ? 'on' : ''}">${t}</a>`).join('') + (user ? '<a href="#" id="out">Log out</a>' : '');
  $('#out')?.addEventListener('click', e => { e.preventDefault(); signOut(auth); location.hash = '#/home'; });
}

async function route() {
  clearInterval(timer); nav(); const [, p = 'home', arg] = location.hash.split('/');
  const open = ['home', 'login'];
  if (!user && !open.includes(p)) return (location.hash = '#/login');
  try { app.innerHTML = await (pages[p] || pages.home)(arg); bind[p]?.(arg); } catch (e) { app.innerHTML = note(err(e)); }
}

const pages = {
  home: () => `<section class="hero"><h1>Earn points for sponsored tasks partners confirm.</h1>
  <p>Open a sponsored task, complete the requirements and earn points once the partner confirms your activity and we approve it. Clicking alone never earns points.</p>
  <a class="btn gold" href="#/${user ? 'earn' : 'login'}">${user ? 'See opportunities' : 'Create free account'}</a></section>
  <h2>How it works</h2><ol class="steps"><li><b>Pick an opportunity</b><br><span class="mute">Read the requirements and reward first.</span></li>
  <li><b>Complete it</b><br><span class="mute">Follow the partner's steps exactly.</span></li>
  <li><b>Confirmation and review</b><br><span class="mute">Points show as pending, then approved after review.</span></li>
  <li><b>Request payment</b><br><span class="mute">Request payment for your approved balance. 10 points = KES 1.</span></li></ol>
  <h2>Fair play</h2><p class="mute">One account per person and phone. Each opportunity has a waiting time before you can repeat it. Rewards the partner later reverses are removed. Accounts showing bot or duplicate activity are suspended.</p>`,

  login: () => user ? (location.hash = '#/dashboard', '') : `<h1>Welcome</h1><form id="f">
  <div id="reg" hidden><label>Full name<input name="name" autocomplete="name"></label>
  <label>M-Pesa phone (e.g. 0712345678)<input name="phone" inputmode="numeric" autocomplete="tel"></label></div>
  <label>Email<input name="email" type="email" required autocomplete="email"></label>
  <label>Password (6+ characters)<input name="pw" type="password" required minlength="6" autocomplete="current-password"></label>
  <button>Log in</button> <button type="button" class="alt" id="tog">Create account instead</button><div id="m"></div></form>`,

  dashboard: async () => {
    if (!profile) return note('Setting up your account…');
    const [a, t] = await Promise.all([rows(query(collection(db, 'activityAttempts'), where('uid', '==', user.uid))), rows(query(collection(db, 'tasks'), where('uid', '==', user.uid)))]);
    const n = s => a.filter(x => x.status === s).length, m = s => t.filter(x => x.status === s).length;
    const legacy = profile.totalEarned || profile.approved || profile.pending || t.length;
    return `<h1>Hi, ${esc(profile.name.split(' ')[0])}</h1>${profile.status !== 'active' ? note('Your account is under review. Contact Support.') : ''}
    <div class="grid"><div class="card"><div class="mute">Approved points</div><div class="big">${ptsVal(profile.approvedPoints)}</div></div>
    <div class="card"><div class="mute">Pending (awaiting review)</div><div class="big">${ptsVal(profile.pendingPoints)}</div></div>
    <div class="card"><div class="mute">Lifetime points earned</div><div class="big">${ptsVal(profile.lifetimePointsEarned)}</div></div>
    <div class="card"><div class="mute">Activities approved / awaiting review / rejected</div><div class="big">${n('approved')} / ${n('pending_review')} / ${n('rejected') + n('reversed')}</div></div></div>
    ${RATE_NOTE}<p><a class="btn gold" href="#/earn">Find an opportunity</a></p>
    ${legacy ? `<h2>Cash balance (earlier tasks)</h2><div class="grid"><div class="card"><div class="mute">Available</div><div class="big">${kes(profile.approved)}</div></div>
    <div class="card"><div class="mute">Pending partner confirmation</div><div class="big">${kes(profile.pending)}</div></div>
    <div class="card"><div class="mute">Total earned</div><div class="big">${kes(profile.totalEarned)}</div></div>
    <div class="card"><div class="mute">Tasks approved / pending / reversed</div><div class="big">${m('approved')} / ${m('pending')} / ${m('reversed')}</div></div></div>` : ''}`;
  },

  earn: async () => {
    const [opps, cds, c] = await Promise.all([rows(query(collection(db, 'opportunities'), where('active', '==', true))),
      rows(query(collection(db, 'cooldowns'), where('uid', '==', user.uid))), rows(query(collection(db, 'campaigns'), where('active', '==', true)))]);
    opps.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const until = Object.fromEntries(cds.map(x => [x.opportunityId, x.cooldownUntil?.toMillis?.() || 0]));
    return `<h1>Opportunities</h1>${RATE_NOTE}` + (opps.length ? `<div class="grid">${opps.map(x => `<div class="card"><span class="tag">${esc(x.code)}</span> <span class="mute">${esc(x.provider)}</span><br><b>${esc(x.title)}</b>
    <div class="big">${ptsVal(x.rewardPoints)}</div><div class="mute">After partner confirmation and review · repeat every ${x.cooldownMinutes} min</div>
    <div class="mute" data-until="${until[x.id] || 0}"></div>
    <p><a class="btn" href="#/opportunity/${esc(x.id)}">View details</a></p></div>`).join('')}</div>` : note('No opportunities right now. Check back soon.'))
    + (c.length ? `<h2>Cash tasks (KES)</h2><div class="grid">${c.map(x => `<div class="card"><b>${esc(x.title)}</b>
    <div class="big">${kes(x.reward)}</div><div class="mute">${x.type === 'cpc' ? 'Paid for a valid click' : 'Paid on completed action'}</div>
    <p><a class="btn" href="#/task/${x.id}">View details</a></p></div>`).join('')}</div>` : '');
  },

  opportunity: async id => {
    const o = await getDoc(doc(db, 'opportunities', id)); if (!o.exists() || !o.data().active) return note('This opportunity is not available.');
    const x = o.data(), c = await getDoc(doc(db, 'cooldowns', `${user.uid}_${id}`)), until = c.exists() ? c.data().cooldownUntil?.toMillis?.() || 0 : 0;
    return `<h1>${esc(x.title)}</h1><div class="card"><span class="tag">${esc(x.code)}</span> <span class="mute">${esc(x.provider)}</span>
    <div class="big">${ptsVal(x.rewardPoints)}</div><h2>Requirements</h2><p style="white-space:pre-wrap">${esc(x.requirements)}</p>
    <p class="mute">Points are added only after the partner confirms your activity and SemaAfrica approves it. Opening the link on its own does not earn points. You can repeat this every ${x.cooldownMinutes} minutes.</p>
    <p class="mute" id="cd" data-until="${until}"></p>
    <button id="go" ${until > Date.now() ? 'disabled' : ''}>Open sponsored task</button><div id="m"></div></div>`;
  },

  task: async id => {
    const c = await getDoc(doc(db, 'campaigns', id)); if (!c.exists()) return note('Task not found.');
    const x = c.data(), t = await getDoc(doc(db, 'tasks', `${user.uid}_${id}`));
    return `<h1>${esc(x.title)}</h1><div class="card"><div class="big">${kes(x.reward)}</div>
    <h2>Requirements</h2><p style="white-space:pre-wrap">${esc(x.requirements)}</p>
    <p class="mute">Reward stays pending until the advertiser confirms. Reversed conversions are deducted.</p>
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
    const [opps, atts, pled] = await Promise.all([rows(collection(db, 'opportunities')),
      rows(query(collection(db, 'activityAttempts'), orderBy('createdAt', 'desc'), limit(200))), rows(query(collection(db, 'pointLedger'), orderBy('createdAt', 'desc'), limit(500)))]);
    opps.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const un = id => esc(users.find(u => u.id === id)?.name || id), sum = f => users.reduce((a, u) => a + (u[f] || 0), 0);
    const apprSince = d => pled.filter(x => x.type === 'reward_approved' && x.createdAt?.seconds > now - d * 864e2).reduce((a, x) => a + (x.approvedDelta || 0), 0);
    const actions = a => ['started', 'pending_review'].includes(a.status) ? `<button data-ra="${a.id}" data-dec="approve">Approve</button> <button class="bad" data-ra="${a.id}" data-dec="reject">Reject</button>` : '';
    const arow = (a, st) => `<tr><td>${when(a.createdAt)}</td><td>${un(a.uid)}</td><td>${esc(a.opportunityCode)}</td><td title="${esc(a.trackingRef)}">${esc(String(a.trackingRef || '').slice(0, 8))}…</td><td>${pts(a.rewardPoints)}</td>
      ${st ? `<td>${stat(a.status)}</td>` : ''}<td>${a.providerEventId ? 'Yes (' + esc(a.providerEventId) + ')' : 'No'}</td><td>${esc(a.reviewNote)}</td><td>${actions(a)}</td></tr>`;
    const queue = atts.filter(a => a.status === 'pending_review');
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
    S.review = `<h1>Review</h1><h2>Awaiting review (provider confirmed)</h2><div class="scroll"><table><tr><th>When</th><th>User</th><th>Code</th><th>Ref</th><th>Points</th><th>Provider event</th><th>Note</th><th></th></tr>
      ${queue.map(a => arow(a, false)).join('') || '<tr><td colspan=8>Nothing waiting.</td></tr>'}</table></div>
      <h2>Recent activity</h2><p class="mute">"Started" means no provider confirmation yet. Approve those only with real evidence and write what you checked in the note.</p>
      <div class="scroll"><table><tr><th>When</th><th>User</th><th>Code</th><th>Ref</th><th>Points</th><th>Status</th><th>Provider event</th><th>Note</th><th></th></tr>
      ${atts.slice(0, 100).map(a => arow(a, true)).join('') || '<tr><td colspan=9>No activity yet.</td></tr>'}</table></div>`;
    S.payments = `<h1>Payments</h1><h2>Payments to make (${toPay.length})</h2><p class="mute">Send the money manually from M-Pesa to the number shown, then press <b>Mark as paid</b> and enter the M-Pesa confirmation code. Reject refunds the user's balance.</p>
      ${toPay.map(payCard).join('') || '<p class="mute">No payment requests waiting.</p>'}
      <h2>Payment history</h2><div class="scroll"><table><tr><th>Requested</th><th>Name</th><th>M-Pesa number</th><th>Amount</th><th>Status</th><th>M-Pesa code / note</th></tr>
      ${done.map(w => `<tr><td>${when(w.createdAt)}</td><td>${esc(w.name)}</td><td>${esc(local(w.phone))}</td><td>${kes(w.amount)}</td><td class="${esc(w.status)}">${esc(w.status)}</td><td>${esc(w.mpesaReceipt || w.note || '')}</td></tr>`).join('') || '<tr><td colspan=6>None yet.</td></tr>'}</table></div>`;
    S.opportunities = `<h1>Opportunities</h1><p class="mute">BTN001–BTN020. Tap one to edit it.</p>${opps.length < 20 ? `<p><button id="seed">Create the missing BTN001–BTN020 entries</button> <span class="mute">${opps.length} of 20 exist. New ones start paused.</span></p>` : ''}
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
    const tabs = [['overview', 'Overview', 0], ['review', 'Review', queue.length], ['payments', 'Payments', toPay.length], ['opportunities', 'Opportunities', 0], ['users', 'Users', sus.length], ['partners', 'Partners', 0], ['campaigns', 'Campaigns', 0], ['support', 'Support', attention[2][1]]];
    const cur = S[tab] ? tab : 'overview';
    return `<div class="admin"><aside class="side"><div class="side-h">Admin</div><nav>${tabs.map(([k, l, n]) => `<a href="#/admin/${k}" class="${k === cur ? 'on' : ''}">${l}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('')}</nav></aside><section class="panel">${S[cur]}</section></div>`;
  }
};

const msg = (h, t) => { const m = $('#m'); if (m) m.innerHTML = note(t); };
const bind = {
  login() {
    let reg = false; const f = $('#f'); if (!f) return;
    $('#tog').onclick = () => { reg = !reg; $('#reg').hidden = !reg; f.querySelector('button').textContent = reg ? 'Create account' : 'Log in'; $('#tog').textContent = reg ? 'I have an account' : 'Create account instead'; };
    f.onsubmit = async e => {
      e.preventDefault(); const d = Object.fromEntries(new FormData(f));
      try {
        if (reg) { await createUserWithEmailAndPassword(auth, d.email, d.pw); await call('registerProfile')({ name: d.name, phone: d.phone, deviceId }); }
        else await signInWithEmailAndPassword(auth, d.email, d.pw);
        location.hash = '#/dashboard';
      } catch (x) { if (reg && auth.currentUser) { await auth.currentUser.delete().catch(() => {}); } msg(0, err(x)); }
    };
  },
  earn() { countdowns(); },
  opportunity(id) {
    const b = $('#go'); if (!b) return; countdowns();
    const setUntil = ms => { $('#cd').dataset.until = ms; b.disabled = ms > Date.now(); countdowns(); };
    b.onclick = async () => {
      b.disabled = true; const w = window.open('about:blank', '_blank');   // opened first so mobile pop-up blockers allow it
      try {
        const r = await call('startOpportunity')({ opportunityId: id });
        if (w) { w.opener = null; w.location.href = r.url; $('#m').innerHTML = note('Task opened in a new tab. Complete the requirements. Points show as pending once the partner confirms, then become approved after review.'); }
        else $('#m').innerHTML = `<div class="msg"><a href="${esc(r.url)}" target="_blank" rel="noopener">Pop-up blocked: tap here to open your task</a></div>`;
        setUntil(r.cooldownUntilMs);
      } catch (x) { w?.close(); b.disabled = false; if (x.data?.cooldownUntilMs) setUntil(x.data.cooldownUntilMs); msg(0, err(x)); }
    };
  },
  task(id) { const b = $('#go'); if (b) b.onclick = async () => { try { const r = await call('startTask')({ campaignId: id }); if (r.url) window.open(r.url, '_blank', 'noopener'); msg(0, 'Task started. Complete the steps; your reward appears as pending once the partner confirms.'); b.remove(); } catch (x) { msg(0, err(x)); } }; },
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
    app.querySelectorAll('[data-ra]').forEach(b => b.onclick = act(() => {
      const n = prompt(b.dataset.dec === 'approve' ? 'Note (required if the partner has not confirmed: what evidence did you check?)' : 'Reason for rejecting (required)'); if (n === null) return;
      return call('adminReviewActivity')({ attemptId: b.dataset.ra, decision: b.dataset.dec, note: n });
    }));
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
