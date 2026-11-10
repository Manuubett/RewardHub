require('dotenv').config();
const express = require('express'), cors = require('cors'), crypto = require('crypto'), rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require(process.env.SERVICE_ACCOUNT || './serviceAccountKey.json')) });
const db = admin.firestore(); const FV = admin.firestore.FieldValue;

const STATUS = { unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409 };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.status = STATUS[code] || 400; } }

const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '20kb' }));
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
app.use(rateLimit({ windowMs: 60e3, max: 60 }));          // basic abuse limit per IP

// Every /api/<name> call needs a valid Firebase ID token (Authorization: Bearer ...)
const api = (name, fn) => app.post('/api/' + name, async (req, res) => {
  try {
    const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) throw new HttpsError('unauthenticated', 'Sign in first.');
    const tok = await admin.auth().verifyIdToken(h.slice(7));
    res.json(await fn({ auth: { uid: tok.uid, token: tok }, data: req.body || {} }));
  } catch (e) {
    if (!(e instanceof HttpsError)) { console.error(e); e = e.code?.startsWith?.('auth/') ? new HttpsError('unauthenticated', 'Session expired. Log in again.') : new HttpsError('internal', 'Server error'); e.status = e.status === 400 ? 500 : e.status; }
    res.status(e.status).json({ error: e.message });
  }
});
app.get('/health', (_, r) => r.send('ok'));

const MIN_WITHDRAW = 100;
const uidOf = c => { if (!c.auth) throw new HttpsError('unauthenticated', 'Sign in first.'); return c.auth.uid; };
const adminOnly = c => { if (!c.auth || c.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Admins only.'); };
const ledger = (t, e) => t.set(db.collection('ledger').doc(), { ...e, createdAt: FV.serverTimestamp() });

// Fraud #6: one phone per account; same device on another account => flagged
api('registerProfile', async ({ auth, data }) => {
  const uid = uidOf({ auth }); const { name, phone, deviceId } = data;
  if (!/^2547\d{8}$|^2541\d{8}$/.test(phone || '')) throw new HttpsError('invalid-argument', 'Phone must look like 2547XXXXXXXX.');
  if (!deviceId || !name) throw new HttpsError('invalid-argument', 'Missing details.');
  const ref = db.doc('users/' + uid); if ((await ref.get()).exists) return { ok: true };
  const dupPhone = await db.collection('users').where('phone', '==', phone).limit(1).get();
  if (!dupPhone.empty) throw new HttpsError('already-exists', 'That phone number is already registered.');
  const dupDev = await db.collection('users').where('deviceId', '==', deviceId).limit(1).get();
  const flags = dupDev.empty ? [] : ['Shared device with another account'];
  await ref.set({ name, phone, deviceId, flags, status: flags.length ? 'flagged' : 'active',
    pending: 0, approved: 0, totalEarned: 0, createdAt: FV.serverTimestamp() });
  return { ok: true };
});

// Creates the tracked click. Reward is NOT given here (Fraud #1).
api('startTask', async ({ auth, data }) => {
  const uid = uidOf({ auth }); const user = (await db.doc('users/' + uid).get()).data();
  if (!user || user.status === 'suspended') throw new HttpsError('permission-denied', 'Account suspended.');
  const c = await db.doc('campaigns/' + data.campaignId).get();
  if (!c.exists || !c.data().active) throw new HttpsError('not-found', 'Campaign unavailable.');
  const id = uid + '_' + c.id; const ref = db.doc('tasks/' + id);
  const existing = await ref.get(); if (existing.exists) return { url: null, status: existing.data().status };
  const clickId = crypto.randomBytes(12).toString('hex');
  await ref.set({ uid, campaignId: c.id, partnerId: c.data().partnerId, title: c.data().title, clickId,
    status: 'started', reward: c.data().reward, createdAt: FV.serverTimestamp() });
  const u = new URL(c.data().url); u.searchParams.set('click_id', clickId);
  return { url: u.toString(), status: 'started' };
});

// Partner server-to-server postback (Fraud #2,3,4,5)
// GET <server>/postback?partner=ID&click_id=..&txn_id=..&event=conversion|valid_click|approved|reversed&sig=HMAC_SHA256(secret, click_id|txn_id|event)
app.get('/postback', async (req, res) => {
  try {
    const { partner, click_id, txn_id, event, sig } = req.query;
    if (!partner || !click_id || !txn_id || !event || !sig) return res.status(400).send('missing params');
    const p = await db.doc('partners/' + partner).get(); if (!p.exists) return res.status(403).send('unknown partner');
    const want = crypto.createHmac('sha256', p.data().secret).update(`${click_id}|${txn_id}|${event}`).digest('hex');
    const a = Buffer.from(String(sig)), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('bad signature');
    const q = await db.collection('tasks').where('clickId', '==', click_id).limit(1).get();
    if (q.empty || q.docs[0].data().partnerId !== partner) return res.status(404).send('unknown click');
    const tRef = q.docs[0].ref;
    const out = await db.runTransaction(async t => {
      const pbRef = db.doc(`postbacks/${partner}_${txn_id}_${event}`);   // unique ID => no duplicate rewards
      if ((await t.get(pbRef)).exists) return 'duplicate';
      const task = (await t.get(tRef)).data(); const uRef = db.doc('users/' + task.uid);
      const cost = (await t.get(db.doc('campaignCosts/' + task.campaignId))).data() || {};
      const camp = (await t.get(db.doc('campaigns/' + task.campaignId))).data();
      const r = task.reward, pay = cost.payout || 0;
      const base = { uid: task.uid, taskId: tRef.id, partnerId: partner, txnId: txn_id };
      if (event === (camp.type === 'cpc' ? 'valid_click' : 'conversion') && task.status === 'started') {
        t.update(tRef, { status: 'pending', txnId: txn_id }); t.update(uRef, { pending: FV.increment(r) });
        ledger(t, { ...base, type: 'pending', amount: r, reward: r, payout: pay });
      } else if (event === 'approved' && task.status === 'pending') {
        t.update(tRef, { status: 'approved' });
        t.update(uRef, { pending: FV.increment(-r), approved: FV.increment(r), totalEarned: FV.increment(r) });
        ledger(t, { ...base, type: 'approve', amount: r, reward: 0, payout: 0 });
      } else if (event === 'reversed' && ['pending', 'approved'].includes(task.status)) {
        const was = task.status; t.update(tRef, { status: 'reversed' });
        t.update(uRef, was === 'pending' ? { pending: FV.increment(-r) }
          : { approved: FV.increment(-r), totalEarned: FV.increment(-r) });   // may go negative => blocks withdrawals
        ledger(t, { ...base, type: 'reverse', amount: -r, reward: -r, payout: -pay });
      } else return 'ignored';
      t.set(pbRef, { partner, txn_id, event, taskId: tRef.id, createdAt: FV.serverTimestamp() });
      return 'ok';
    });
    res.status(200).send(out);
  } catch (e) { console.error(e); res.status(500).send('error'); }
});

api('requestWithdrawal', async ({ auth, data }) => {
  const uid = uidOf({ auth }); const amount = Number(data.amount);
  if (!Number.isInteger(amount) || amount < MIN_WITHDRAW) throw new HttpsError('invalid-argument', `Minimum is KES ${MIN_WITHDRAW}.`);
  await db.runTransaction(async t => {
    const uRef = db.doc('users/' + uid); const u = (await t.get(uRef)).data();
    if (u.status !== 'active') throw new HttpsError('permission-denied', 'Account under review. Contact support.');
    if (u.approved < amount) throw new HttpsError('failed-precondition', 'Not enough approved balance.');
    const open = await db.collection('withdrawals').where('uid', '==', uid).where('status', '==', 'pending').limit(1).get();
    if (!open.empty) throw new HttpsError('failed-precondition', 'You already have a pending withdrawal.');
    const w = db.collection('withdrawals').doc();
    t.set(w, { uid, amount, phone: u.phone, name: u.name, status: 'pending', createdAt: FV.serverTimestamp() });
    t.update(uRef, { approved: FV.increment(-amount) });
    ledger(t, { uid, type: 'withdraw', amount: -amount, reward: 0, payout: 0, withdrawalId: w.id });
  });
  return { ok: true };
});

// Admin pays via M-Pesa (manual or add Daraja B2C here), then marks paid; reject refunds the balance.
api('adminDecideWithdrawal', async ({ auth, data }) => {
  adminOnly({ auth }); const { id, decision, note = '' } = data;
  await db.runTransaction(async t => {
    const wRef = db.doc('withdrawals/' + id); const w = (await t.get(wRef)).data();
    if (!w || w.status !== 'pending') throw new HttpsError('failed-precondition', 'Already handled.');
    if (decision === 'paid') t.update(wRef, { status: 'paid', note, decidedAt: FV.serverTimestamp() });
    else {
      t.update(wRef, { status: 'rejected', note, decidedAt: FV.serverTimestamp() });
      t.update(db.doc('users/' + w.uid), { approved: FV.increment(w.amount) });
      ledger(t, { uid: w.uid, type: 'withdraw_refund', amount: w.amount, reward: 0, payout: 0, withdrawalId: id });
    }
  });
  return { ok: true };
});

api('adminSetUserStatus', async ({ auth, data }) => {
  adminOnly({ auth }); if (!['active', 'flagged', 'suspended'].includes(data.status)) throw new HttpsError('invalid-argument', 'Bad status');
  await db.doc('users/' + data.uid).update({ status: data.status }); return { ok: true };
});

app.listen(process.env.PORT || 3000, () => console.log('RewardHub server running'));
