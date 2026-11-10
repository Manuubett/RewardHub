require('dotenv').config();
const express = require('express'), cors = require('cors'), crypto = require('crypto'), rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
// Key comes from SERVICE_ACCOUNT_JSON (hosting) or a local file (your PC)
let key;
try { key = process.env.SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.SERVICE_ACCOUNT_JSON) : require(process.env.SERVICE_ACCOUNT || './serviceAccountKey.json'); }
catch (e) { console.error('No Firebase key found. On Render set the SERVICE_ACCOUNT_JSON environment variable to the full contents of your key file (valid JSON).'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore(); const FV = admin.firestore.FieldValue;

const STATUS = { unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409 };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.status = STATUS[code] || 400; } }

const app = express(); app.set('trust proxy', 1);
app.use((req, _res, next) => { req.url = req.url.replace(/\/{2,}/g, '/'); next(); });   // tolerate // in URLs
 app.use(express.json({ limit: '20kb' }));
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
  const uid = uidOf({ auth }); const { name, deviceId } = data; let phone = String(data.phone || '').replace(/\s+/g, '').replace(/^\+/, ''); if (phone.startsWith('0')) phone = '254' + phone.slice(1);
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

// ---------- M-Pesa B2C (Daraja), adapted from your EarnHub starter ----------
const E = process.env;
const darajaBase = () => E.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const mpesaReady = () => ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SECURITY_CREDENTIAL', 'MPESA_SHORTCODE', 'MPESA_INITIATOR_NAME', 'PUBLIC_URL', 'CALLBACK_TOKEN'].every(k => E[k]);
async function darajaToken() {
  const raw = Buffer.from(`${E.MPESA_CONSUMER_KEY}:${E.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${raw}` } });
  const d = await r.json(); if (!r.ok || !d.access_token) throw new Error('Daraja auth failed');
  return d.access_token;
}
// decision: 'mpesa' (send via B2C) | 'paid' (you already paid manually) | 'rejected' (refund balance)
// Statuses: pending > submitting > submitted > paid | failed(refunded) | needs_review (timeout: reconcile manually, NO auto refund)
api('adminDecideWithdrawal', async ({ auth, data }) => {
  adminOnly({ auth }); const { id, decision, note = '' } = data; const wRef = db.doc('withdrawals/' + id);
  if (decision === 'mpesa') {
    if (!mpesaReady()) throw new HttpsError('failed-precondition', 'M-Pesa is not configured on the server (see README).');
    await db.runTransaction(async t => {   // lock first so it can never be sent twice
      const w = (await t.get(wRef)).data();
      if (!w || !['pending', 'submission_failed'].includes(w.status)) throw new HttpsError('failed-precondition', 'This request cannot be sent (already handled or needs manual review).');
      t.update(wRef, { status: 'submitting', approvedBy: auth.uid, updatedAt: FV.serverTimestamp() });
    });
    const w = (await wRef.get()).data();
    try {
      const r = await fetch(`${darajaBase()}/mpesa/b2c/v1/paymentrequest`, { method: 'POST',
        headers: { Authorization: 'Bearer ' + await darajaToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ InitiatorName: E.MPESA_INITIATOR_NAME, SecurityCredential: E.MPESA_SECURITY_CREDENTIAL, CommandID: 'BusinessPayment',
          Amount: w.amount, PartyA: E.MPESA_SHORTCODE, PartyB: w.phone, Remarks: 'RewardHub reward', Occasion: 'RH-' + id.slice(0, 10),
          QueueTimeOutURL: `${E.PUBLIC_URL}/mpesa/timeout?token=${E.CALLBACK_TOKEN}`, ResultURL: `${E.PUBLIC_URL}/mpesa/result?token=${E.CALLBACK_TOKEN}` }) });
      const d = await r.json();
      if (!r.ok || String(d.ResponseCode) !== '0') { await wRef.update({ status: 'submission_failed', darajaResponse: d, updatedAt: FV.serverTimestamp() }); throw new HttpsError('failed-precondition', 'Daraja rejected the request. You can retry or reject.'); }
      await wRef.update({ status: 'submitted', originatorConversationId: d.OriginatorConversationID || null, conversationId: d.ConversationID || null, updatedAt: FV.serverTimestamp() });
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpsError) throw e; console.error(e);
      await wRef.update({ status: 'submission_error', updatedAt: FV.serverTimestamp() });
      throw new HttpsError('internal', 'Unclear if money was sent. Check the Daraja portal before doing anything else.');
    }
  }
  if (!['paid', 'rejected'].includes(decision)) throw new HttpsError('invalid-argument', 'Bad decision');
  await db.runTransaction(async t => {
    const w = (await t.get(wRef)).data();
    if (!w || !['pending', 'submission_failed', 'submission_error', 'needs_review'].includes(w.status)) throw new HttpsError('failed-precondition', 'Already handled or still processing.');
    if (decision === 'paid') t.update(wRef, { status: 'paid', note, decidedAt: FV.serverTimestamp() });
    else {
      t.update(wRef, { status: 'rejected', note, decidedAt: FV.serverTimestamp() });
      t.update(db.doc('users/' + w.uid), { approved: FV.increment(w.amount) });
      ledger(t, { uid: w.uid, type: 'withdraw_refund', amount: w.amount, reward: 0, payout: 0, withdrawalId: id });
    }
  });
  return { ok: true };
});

const sameToken = q => { const a = Buffer.from(String(q || '')), b = Buffer.from(E.CALLBACK_TOKEN || ''); return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
app.post('/mpesa/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['result', 'timeout'].includes(kind) || !sameToken(req.query.token)) return res.status(403).send('Forbidden');
  try {
    const r = req.body?.Result; if (!r) throw new Error('No Result');
    const q = await db.collection('withdrawals').where('originatorConversationId', '==', r.OriginatorConversationID).limit(1).get();
    if (q.empty) { console.warn('Unmatched B2C callback', r.OriginatorConversationID); return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); }
    const wRef = q.docs[0].ref, cbRef = db.doc(`mpesaCallbacks/${kind}_${r.OriginatorConversationID}`), code = Number(r.ResultCode);
    await db.runTransaction(async t => {
      const [wS, cS] = await Promise.all([t.get(wRef), t.get(cbRef)]); if (cS.exists) return;   // duplicate callback
      const w = wS.data(); t.create(cbRef, { withdrawalId: wRef.id, kind, code, createdAt: FV.serverTimestamp() });
      if (['paid', 'failed', 'rejected'].includes(w.status)) return;
      if (kind === 'timeout') { if (w.status === 'submitted') t.update(wRef, { status: 'needs_review', updatedAt: FV.serverTimestamp() }); return; }  // ambiguous: never auto-refund
      if (code === 0) {
        const rec = (r.ResultParameters?.ResultParameter || []).find(x => x.Key === 'TransactionReceipt' || x.Key === 'ReceiptNo');
        t.update(wRef, { status: 'paid', mpesaReceipt: rec?.Value || null, resultDesc: r.ResultDesc || '', decidedAt: FV.serverTimestamp() });
      } else {
        t.update(wRef, { status: 'failed', resultCode: code, resultDesc: r.ResultDesc || '', decidedAt: FV.serverTimestamp() });
        t.update(db.doc('users/' + w.uid), { approved: FV.increment(w.amount) });
        ledger(t, { uid: w.uid, type: 'withdraw_refund', amount: w.amount, reward: 0, payout: 0, withdrawalId: wRef.id });
      }
    });
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (e) { console.error('B2C callback failed', e); res.status(500).json({ ResultCode: 1, ResultDesc: 'Processing failed' }); }
});

api('adminSetUserStatus', async ({ auth, data }) => {
  adminOnly({ auth }); if (!['active', 'flagged', 'suspended'].includes(data.status)) throw new HttpsError('invalid-argument', 'Bad status');
  await db.doc('users/' + data.uid).update({ status: data.status }); return { ok: true };
});

app.listen(process.env.PORT || 3000, () => console.log('RewardHub server running'));
