import { auth, db, functions } from './firebase-config.js';
import { onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where, addDoc, setDoc, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kes = n => 'KES ' + Number(n || 0).toLocaleString();
const call = n => async d => (await httpsCallable(functions, n)(d)).data;
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
    isAdmin = (await u.getIdTokenResult(true)).claims.admin === true;
    unsub = onSnapshot(doc(db, 'users', u.uid), s => { profile = s.data() || null; if (!/login|support|admin|task/.test(location.hash)) route(); }, () => {});
  }
  route();
});
window.onhashchange = route;

function nav() {
  const L = user ? [['dashboard', 'Dashboard'], ['earn', 'Earn'], ['wallet', 'Wallet'], ['withdraw', 'Withdraw'], ['history', 'History'], ['support', 'Support']] : [['home', 'Home'], ['login', 'Log in']];
  if (isAdmin) L.push(['admin', 'Admin']);
  const cur = location.hash.split('/')[1] || 'home';
  $('#nav').innerHTML = L.map(([k, t]) => `<a href="#/${k}" class="${cur === k ? 'on' : ''}">${t}</a>`).join('') + (user ? '<a href="#" id="out">Log out</a>' : '');
  $('#out')?.addEventListener('click', e => { e.preventDefault(); signOut(auth); location.hash = '#/home'; });
}

async function route() {
  nav(); const [, p = 'home', arg] = location.hash.split('/');
  const open = ['home', 'login'];
  if (!user && !open.includes(p)) return (location.hash = '#/login');
  try { app.innerHTML = await (pages[p] || pages.home)(arg); bind[p]?.(arg); } catch (e) { app.innerHTML = note(err(e)); }
}

const pages = {
  home: () => `<section class="hero"><h1>Get paid in M-Pesa for tasks advertisers confirm.</h1>
  <p>Try offers from real advertising partners. You are paid when the partner confirms your task, not when you click.</p>
  <a class="btn gold" href="#/${user ? 'earn' : 'login'}">${user ? 'See tasks' : 'Create free account'}</a></section>
  <h2>How it works</h2><ol class="steps"><li><b>Pick a task</b><br><span class="mute">Read the requirements and reward first.</span></li>
  <li><b>Complete it</b><br><span class="mute">Follow the partner's steps exactly.</span></li>
  <li><b>Partner confirms</b><br><span class="mute">Reward shows as pending, then approved.</span></li>
  <li><b>Withdraw</b><br><span class="mute">Request M-Pesa payout from KES 100.</span></li></ol>
  <h2>Fair play</h2><p class="mute">One account per person and phone. Rewards from conversions that advertisers later reverse are removed. Accounts showing bot or duplicate activity are suspended.</p>`,

  login: () => user ? (location.hash = '#/dashboard', '') : `<h1>Welcome</h1><form id="f">
  <div id="reg" hidden><label>Full name<input name="name" autocomplete="name"></label>
  <label>M-Pesa phone (2547XXXXXXXX)<input name="phone" inputmode="numeric" autocomplete="tel"></label></div>
  <label>Email<input name="email" type="email" required autocomplete="email"></label>
  <label>Password (6+ characters)<input name="pw" type="password" required minlength="6" autocomplete="current-password"></label>
  <button>Log in</button> <button type="button" class="alt" id="tog">Create account instead</button><div id="m"></div></form>`,

  dashboard: async () => {
    if (!profile) return note('Setting up your account…');
    const t = await rows(query(collection(db, 'tasks'), where('uid', '==', user.uid)));
    const n = s => t.filter(x => x.status === s).length;
    return `<h1>Hi, ${esc(profile.name.split(' ')[0])}</h1>${profile.status !== 'active' ? note('Your account is under review. Withdrawals are paused. Contact Support.') : ''}
    <div class="grid"><div class="card"><div class="mute">Available</div><div class="big">${kes(profile.approved)}</div></div>
    <div class="card"><div class="mute">Pending partner confirmation</div><div class="big">${kes(profile.pending)}</div></div>
    <div class="card"><div class="mute">Total earned</div><div class="big">${kes(profile.totalEarned)}</div></div>
    <div class="card"><div class="mute">Tasks approved / pending / reversed</div><div class="big">${n('approved')} / ${n('pending')} / ${n('reversed')}</div></div></div>
    <p><a class="btn gold" href="#/earn">Find a task</a></p>`;
  },

  earn: async () => {
    const c = (await rows(query(collection(db, 'campaigns'), where('active', '==', true))));
    return `<h1>Available tasks</h1>` + (c.length ? `<div class="grid">${c.map(x => `<div class="card"><b>${esc(x.title)}</b>
    <div class="big">${kes(x.reward)}</div><div class="mute">${x.type === 'cpc' ? 'Paid for a valid click' : 'Paid on completed action'}</div>
    <p><a class="btn" href="#/task/${x.id}">View details</a></p></div>`).join('')}</div>` : note('No tasks right now. Check back soon.'));
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
    const l = (await rows(query(collection(db, 'ledger'), where('uid', '==', user.uid)))).sort(byDate);
    return `<h1>Wallet</h1><div class="grid"><div class="card"><div class="mute">Pending</div><div class="big">${kes(profile?.pending)}</div></div>
    <div class="card"><div class="mute">Approved (withdrawable)</div><div class="big">${kes(profile?.approved)}</div></div></div>
    <h2>Transactions</h2><div class="scroll"><table><tr><th>Date</th><th>Type</th><th>Amount</th></tr>
    ${l.map(x => `<tr><td>${when(x.createdAt)}</td><td>${x.type.replace('_', ' ')}</td><td>${kes(x.amount)}</td></tr>`).join('') || '<tr><td colspan=3>No transactions yet.</td></tr>'}</table></div>`;
  },

  withdraw: async () => {
    const w = (await rows(query(collection(db, 'withdrawals'), where('uid', '==', user.uid)))).sort(byDate);
    return `<h1>Withdraw to M-Pesa</h1><form id="f"><p>Available: <b>${kes(profile?.approved)}</b><br><span class="mute">Sent to ${esc(profile?.phone)}. Minimum KES 100.</span></p>
    <label>Amount (KES)<input name="amt" type="number" min="100" step="1" required></label><button>Request withdrawal</button><div id="m"></div></form>
    <h2>Your requests</h2><div class="scroll"><table><tr><th>Date</th><th>Amount</th><th>Status</th><th>Note</th></tr>
    ${w.map(x => `<tr><td>${when(x.createdAt)}</td><td>${kes(x.amount)}</td><td class="${x.status}">${x.status}</td><td>${esc(x.note)}</td></tr>`).join('') || '<tr><td colspan=4>None yet.</td></tr>'}</table></div>`;
  },

  history: async () => {
    const t = (await rows(query(collection(db, 'tasks'), where('uid', '==', user.uid)))).sort(byDate);
    return `<h1>History</h1><div class="scroll"><table><tr><th>Date</th><th>Task</th><th>Reward</th><th>Status</th></tr>
    ${t.map(x => `<tr><td>${when(x.createdAt)}</td><td>${esc(x.title)}</td><td>${kes(x.reward)}</td><td class="${x.status}">${x.status}</td></tr>`).join('') || '<tr><td colspan=4>No tasks yet.</td></tr>'}</table></div>
    <p class="mute">Payments appear under Wallet and Withdraw.</p>`;
  },

  support: async () => {
    const k = (await rows(query(collection(db, 'tickets'), where('uid', '==', user.uid)))).sort(byDate);
    return `<h1>Support</h1><form id="f"><label>Subject<input name="s" required maxlength="100"></label>
    <label>Describe the problem or complaint<textarea name="m" rows="5" required maxlength="2000"></textarea></label><button>Send</button><div id="m"></div></form>
    <h2>Your messages</h2>${k.map(x => `<div class="card"><b>${esc(x.subject)}</b><p>${esc(x.message)}</p>${x.reply ? `<p class="msg">Support: ${esc(x.reply)}</p>` : '<span class="mute">Awaiting reply</span>'}</div>`).join('') || '<p class="mute">No messages yet.</p>'}`;
  },

  admin: async () => {
    if (!isAdmin) return note('Admins only.');
    const [users, wd, led, partners, pays, camps, tix] = await Promise.all(['users', 'withdrawals', 'ledger', 'partners', 'partnerPayments', 'campaigns', 'tickets'].map(c => rows(collection(db, c))));
    const now = Date.now() / 1e3, prof = d => led.filter(x => x.createdAt?.seconds > now - d * 864e2).reduce((a, x) => a + (x.payout || 0) - (x.reward || 0), 0);
    const earn = led.filter(x => x.type === 'pending').reduce((a, x) => a + x.reward, 0);
    const owed = p => led.filter(x => x.partnerId === p).reduce((a, x) => a + (x.payout || 0), 0), paid = p => pays.filter(x => x.partnerId === p).reduce((a, x) => a + x.amount, 0);
    const pn = id => esc(partners.find(p => p.id === id)?.name || id), sus = users.filter(u => u.status !== 'active' || u.flags?.length);
    const ub = (u, s, t) => `<button class="alt" data-st="${s}" data-uid="${u.id}">${t}</button>`;
    return `<h1>Admin</h1><h2>Profit</h2><div class="grid"><div class="card"><div class="mute">Last 24 hours</div><div class="big">${kes(prof(1))}</div></div>
    <div class="card"><div class="mute">Last 7 days</div><div class="big">${kes(prof(7))}</div></div><div class="card"><div class="mute">Last 30 days</div><div class="big">${kes(prof(30))}</div></div>
    <div class="card"><div class="mute">Rewards credited (all time)</div><div class="big">${kes(earn)}</div></div></div>
    <h2>Withdrawal requests</h2><div class="scroll"><table><tr><th>When</th><th>User</th><th>Phone</th><th>Amount</th><th>Status</th><th></th></tr>
    ${wd.sort(byDate).map(w => `<tr><td>${when(w.createdAt)}</td><td>${esc(w.name)}</td><td>${esc(w.phone)}</td><td>${kes(w.amount)}</td><td class="${w.status}">${w.status}</td>
    <td>${w.status === 'pending' ? `<button data-w="${w.id}" data-d="paid">Mark paid</button> <button class="bad" data-w="${w.id}" data-d="rejected">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan=6>None.</td></tr>'}</table></div>
    <h2>Suspicious accounts</h2><div class="scroll"><table><tr><th>User</th><th>Phone</th><th>Status</th><th>Flags</th><th></th></tr>
    ${sus.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.phone)}</td><td class="${u.status}">${u.status}</td><td>${esc((u.flags || []).join(', '))}</td><td>${ub(u, 'suspended', 'Suspend')} ${ub(u, 'active', 'Clear')}</td></tr>`).join('') || '<tr><td colspan=5>Nothing flagged.</td></tr>'}</table></div>
    <h2>Advertising partners</h2><form id="pf" class="wide" style="display:flex;gap:.5rem"><input name="n" placeholder="Partner name" required><button>Add partner</button></form>
    <div class="scroll"><table><tr><th>Partner</th><th>ID</th><th>Secret (give to partner)</th><th>Owed</th><th>Paid</th><th>Balance</th></tr>
    ${partners.map(p => `<tr><td>${esc(p.name)}</td><td>${p.id}</td><td>${esc(p.secret)}</td><td>${kes(owed(p.id))}</td><td>${kes(paid(p.id))}</td><td>${kes(paid(p.id) - owed(p.id))}</td></tr>`).join('')}</table></div>
    <h2>Advertiser payments</h2><form id="payf" style="max-width:520px"><select name="p">${partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    <input name="a" type="number" min="1" placeholder="Amount received (KES)" required><input name="r" placeholder="Reference (bank / M-Pesa code)"><button>Record payment</button></form>
    <h2>Campaigns</h2><form id="cf" style="max-width:520px"><select name="p">${partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
    <input name="t" placeholder="Title" required><input name="u" type="url" placeholder="Partner tracking URL (https://…)" required>
    <input name="rw" type="number" min="1" placeholder="User reward (KES)" required><input name="po" type="number" min="1" placeholder="Advertiser pays you (KES)" required>
    <select name="ty"><option value="conversion">Pays on completed action</option><option value="cpc">Pays for valid click (partner-confirmed)</option></select>
    <textarea name="q" rows="3" placeholder="Requirements shown to users" required></textarea><button>Add campaign</button></form>
    <div class="scroll"><table><tr><th>Title</th><th>Partner</th><th>Reward</th><th>Active</th><th></th></tr>
    ${camps.map(c => `<tr><td>${esc(c.title)}</td><td>${pn(c.partnerId)}</td><td>${kes(c.reward)}</td><td>${c.active}</td><td><button class="alt" data-c="${c.id}" data-on="${!c.active}">${c.active ? 'Pause' : 'Resume'}</button></td></tr>`).join('')}</table></div>
    <h2>Users (${users.length})</h2><div class="scroll"><table><tr><th>Name</th><th>Phone</th><th>Status</th><th>Pending</th><th>Approved</th><th>Earned</th></tr>
    ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.phone)}</td><td class="${u.status}">${u.status}</td><td>${kes(u.pending)}</td><td>${kes(u.approved)}</td><td>${kes(u.totalEarned)}</td></tr>`).join('')}</table></div>
    <h2>Support tickets</h2>${tix.sort(byDate).map(t => `<div class="card"><b>${esc(t.subject)}</b> <span class="mute">${esc(users.find(u => u.id === t.uid)?.name)}</span><p>${esc(t.message)}</p>
    <form class="wide rf" data-t="${t.id}" style="display:flex;gap:.5rem"><input name="r" value="${esc(t.reply || '')}" placeholder="Reply"><button>Reply</button></form></div>`).join('')}`;
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
  task(id) { const b = $('#go'); if (b) b.onclick = async () => { try { const r = await call('startTask')({ campaignId: id }); if (r.url) window.open(r.url, '_blank', 'noopener'); msg(0, 'Task started. Complete the steps; your reward appears as pending once the partner confirms.'); b.remove(); } catch (x) { msg(0, err(x)); } }; },
  withdraw() { const f = $('#f'); f.onsubmit = async e => { e.preventDefault(); try { await call('requestWithdrawal')({ amount: +f.amt.value }); location.hash = '#/withdraw'; route(); } catch (x) { msg(0, err(x)); } }; },
  support() { const f = $('#f'); f.onsubmit = async e => { e.preventDefault(); await addDoc(collection(db, 'tickets'), { uid: user.uid, subject: f.s.value, message: f.m.value, createdAt: serverTimestamp(), reply: '' }); route(); }; },
  admin() {
    const act = fn => async e => { try { await fn(e); route(); } catch (x) { alert(err(x)); } };
    app.querySelectorAll('[data-w]').forEach(b => b.onclick = act(() => call('adminDecideWithdrawal')({ id: b.dataset.w, decision: b.dataset.d, note: prompt('Note (optional, e.g. M-Pesa code)') || '' })));
    app.querySelectorAll('[data-st]').forEach(b => b.onclick = act(() => call('adminSetUserStatus')({ uid: b.dataset.uid, status: b.dataset.st })));
    app.querySelectorAll('[data-c]').forEach(b => b.onclick = act(() => updateDoc(doc(db, 'campaigns', b.dataset.c), { active: b.dataset.on === 'true' })));
    app.querySelectorAll('.rf').forEach(f => f.onsubmit = act(e => { e.preventDefault(); return updateDoc(doc(db, 'tickets', f.dataset.t), { reply: f.r.value }); }));
    $('#pf').onsubmit = act(e => { e.preventDefault(); const s = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join(''); return addDoc(collection(db, 'partners'), { name: e.target.n.value, secret: s, createdAt: serverTimestamp() }); });
    $('#payf').onsubmit = act(e => { e.preventDefault(); const f = e.target; return addDoc(collection(db, 'partnerPayments'), { partnerId: f.p.value, amount: +f.a.value, ref: f.r.value, createdAt: serverTimestamp() }); });
    $('#cf').onsubmit = act(async e => { e.preventDefault(); const f = e.target; const r = await addDoc(collection(db, 'campaigns'), { partnerId: f.p.value, title: f.t.value, url: f.u.value, reward: +f.rw.value, type: f.ty.value, requirements: f.q.value, active: true, createdAt: serverTimestamp() }); await setDoc(doc(db, 'campaignCosts', r.id), { payout: +f.po.value }); });
  }
};
