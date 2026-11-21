// SemaAfrica points system: opportunities (BTN001-BTN020), server-enforced cooldowns,
// provider confirmation, admin review and an append-only points ledger.
// Points are kept completely separate from the legacy KES balances.
const crypto = require('crypto');

module.exports = function registerPoints({ app, api, db, admin, HttpsError, uidOf, adminOnly }) {
  const FV = admin.firestore.FieldValue, TS = admin.firestore.Timestamp;

  const OPP_COUNT = 20;
  const ATTEMPT_TTL_DAYS = 7;   // a provider confirmation arriving later than this is ignored
  const ACTIVITY_TYPES = ['verified_offer', 'signup', 'install', 'survey', 'permitted_click'];
  const codeOf = i => 'BTN' + String(i).padStart(3, '0');
  const CODE_RE = /^BTN\d{3}$/;

  // Append-only: entries are only ever created, never updated or deleted.
  // pendingDelta / approvedDelta are signed changes to the user's balances.
  const pLedger = (t, e) => t.set(db.collection('pointLedger').doc(), { pendingDelta: 0, approvedDelta: 0, ...e, createdAt: FV.serverTimestamp() });
  const audit = (t, e) => t.set(db.collection('adminAudit').doc(), { ...e, createdAt: FV.serverTimestamp() });

  // ---------- Opportunities (admin) ----------
  api('adminSeedOpportunities', async ({ auth }) => {
    await adminOnly({ auth });
    const refs = Array.from({ length: OPP_COUNT }, (_, i) => db.doc('opportunities/' + codeOf(i + 1)));
    const snaps = await db.getAll(...refs); const batch = db.batch(); let made = 0;
    snaps.forEach((s, i) => {
      if (s.exists) return; made++;
      batch.set(refs[i], {
        code: codeOf(i + 1), title: 'Sponsored opportunity ' + String(i + 1).padStart(2, '0'),
        provider: '', partnerId: '', providerZoneId: '', destinationUrl: '', trackingParam: 'click_id',
        activityType: 'verified_offer', requirements: 'Complete the approved offer steps.',
        rewardPoints: 10, cooldownMinutes: 30, sortOrder: i + 1,
        incentiveApproved: false, providerPermissionNote: '',   // must be confirmed before the button can go live
        active: false, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp()
      });
    });
    if (made) await batch.commit();
    return { created: made };
  });

  const str = (v, max, name, req = false) => {
    v = String(v ?? '').trim();
    if (req && !v) throw new HttpsError('invalid-argument', name + ' is required.');
    if (v.length > max) throw new HttpsError('invalid-argument', `${name} is too long (max ${max}).`);
    return v;
  };
  const int = (v, lo, hi, name) => {
    const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpsError('invalid-argument', `${name} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };

  api('adminUpdateOpportunity', async ({ auth, data }) => {
    await adminOnly({ auth });
    const id = String(data.id || ''); if (!CODE_RE.test(id)) throw new HttpsError('invalid-argument', 'Bad opportunity code.');
    const f = {
      title: str(data.title, 80, 'Title', true), provider: str(data.provider, 60, 'Provider'),
      providerZoneId: str(data.providerZoneId, 60, 'Provider zone/reference'),
      requirements: str(data.requirements, 1000, 'Requirements', true),
      providerPermissionNote: str(data.providerPermissionNote, 500, 'Permission note'),
      trackingParam: str(data.trackingParam || 'click_id', 30, 'Tracking parameter'),
      rewardPoints: int(data.rewardPoints, 0, 100000, 'Reward points'),
      cooldownMinutes: int(data.cooldownMinutes, 1, 43200, 'Cooldown (minutes)'),
      incentiveApproved: data.incentiveApproved === true, active: data.active === true
    };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.trackingParam)) throw new HttpsError('invalid-argument', 'Tracking parameter may only contain letters, numbers and underscores.');
    if (!ACTIVITY_TYPES.includes(data.activityType)) throw new HttpsError('invalid-argument', 'Bad activity type.');
    f.activityType = data.activityType;
    f.partnerId = str(data.partnerId, 60, 'Partner');
    if (f.partnerId && !(await db.doc('partners/' + f.partnerId).get()).exists) throw new HttpsError('invalid-argument', 'Unknown partner.');
    f.destinationUrl = str(data.destinationUrl, 2000, 'Destination URL');
    if (f.destinationUrl) { let u; try { u = new URL(f.destinationUrl); } catch { u = null; } if (!u || u.protocol !== 'https:') throw new HttpsError('invalid-argument', 'Destination URL must be a valid https:// link.'); }
    if (f.incentiveApproved && f.providerPermissionNote.length < 5) throw new HttpsError('invalid-argument', 'Describe where the provider\'s written permission for rewarded activity is recorded (e.g. email date/reference).');
    if (f.active) {
      if (!f.destinationUrl) throw new HttpsError('invalid-argument', 'Add a destination URL before activating.');
      if (!f.incentiveApproved) throw new HttpsError('invalid-argument', 'Confirm the provider permits rewarded activity before activating. Do not reward ordinary ad clicks.');
    }
    const ref = db.doc('opportunities/' + id);
    await db.runTransaction(async t => {
      if (!(await t.get(ref)).exists) throw new HttpsError('not-found', 'Opportunity not found. Create BTN001-BTN020 first.');
      t.update(ref, { ...f, updatedAt: FV.serverTimestamp() });
      audit(t, { type: 'opportunity_updated', adminUid: auth.uid, opportunityId: id, active: f.active, rewardPoints: f.rewardPoints, cooldownMinutes: f.cooldownMinutes });
    });
    return { ok: true };
  });

  // ---------- User starts an opportunity ----------
  // The browser only sends the opportunity ID. Identity, reward, cooldown and status all come from the server.
  api('startOpportunity', async ({ auth, data }) => {
    const uid = uidOf({ auth }); const oppId = String(data.opportunityId || '');
    if (!CODE_RE.test(oppId)) throw new HttpsError('invalid-argument', 'Bad opportunity.');
    const uRef = db.doc('users/' + uid), oRef = db.doc('opportunities/' + oppId), cRef = db.doc(`cooldowns/${uid}_${oppId}`);
    const aRef = db.collection('activityAttempts').doc(), trackingRef = crypto.randomBytes(16).toString('hex');
    const out = await db.runTransaction(async t => {   // atomic: two simultaneous requests cannot both pass the cooldown check
      const [uS, oS, cS] = await Promise.all([t.get(uRef), t.get(oRef), t.get(cRef)]);
      const u = uS.data(), o = oS.data();
      if (!u || u.status === 'suspended') throw new HttpsError('permission-denied', 'Account suspended.');
      if (!o || !o.active || !o.incentiveApproved || !o.destinationUrl) throw new HttpsError('not-found', 'This opportunity is not available.');
      const now = Date.now(), until = cS.exists ? cS.data().cooldownUntil.toMillis() : 0;
      if (until > now) throw new HttpsError('resource-exhausted', 'This opportunity is on cooldown. Try again later.', { cooldownUntilMs: until });
      const cooldownUntil = TS.fromMillis(now + o.cooldownMinutes * 60e3);
      t.set(aRef, {
        uid, opportunityId: oppId, opportunityCode: o.code, opportunityTitle: o.title, provider: o.provider || '', partnerId: o.partnerId || '',
        trackingRef, status: 'started', rewardPoints: o.rewardPoints, activityType: o.activityType,
        createdAt: FV.serverTimestamp(), cooldownUntil, expiresAt: TS.fromMillis(now + ATTEMPT_TTL_DAYS * 864e5),
        providerEventId: null, reviewedBy: null, reviewedAt: null, reviewNote: null
      });
      t.set(cRef, { uid, opportunityId: oppId, cooldownUntil, lastAttemptId: aRef.id, updatedAt: FV.serverTimestamp() });
      return { dest: o.destinationUrl, param: o.trackingParam || 'click_id', cooldownUntilMs: cooldownUntil.toMillis() };
    });
    const url = new URL(out.dest); url.searchParams.set(out.param, trackingRef);
    return { url: url.toString(), cooldownUntilMs: out.cooldownUntilMs };
  });

  // ---------- Provider confirmation (server-to-server) ----------
  // GET /postback/points?partner=ID&click_id=<trackingRef>&txn_id=..&event=conversion|reversed&sig=HMAC_SHA256(secret, click_id|txn_id|event)
  // A confirmation only moves the attempt to pending_review. An admin still approves before any points become spendable.
  app.get('/postback/points', async (req, res) => {
    try {
      const { partner, click_id, txn_id, event, sig } = req.query;
      if (!partner || !click_id || !txn_id || !event || !sig) return res.status(400).send('missing params');
      const p = await db.doc('partners/' + partner).get(); if (!p.exists) return res.status(403).send('unknown partner');
      const want = crypto.createHmac('sha256', p.data().secret).update(`${click_id}|${txn_id}|${event}`).digest('hex');
      const a = Buffer.from(String(sig)), b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('bad signature');
      const q = await db.collection('activityAttempts').where('trackingRef', '==', String(click_id)).limit(1).get();
      if (q.empty || q.docs[0].data().partnerId !== partner) return res.status(404).send('unknown click');   // also rejects another provider's reference
      const aRef = q.docs[0].ref;
      const out = await db.runTransaction(async t => {
        const evRef = db.doc(`providerEvents/${partner}_${txn_id}_${event}`);   // deterministic ID => one provider event, at most one effect
        const [evS, aS] = await Promise.all([t.get(evRef), t.get(aRef)]);
        if (evS.exists) return 'duplicate';
        const att = aS.data(), r = att.rewardPoints, uRef = db.doc('users/' + att.uid);
        const base = { uid: att.uid, activityAttemptId: aRef.id, opportunityId: att.opportunityId, providerEventId: String(txn_id) };
        const okEvent = event === 'conversion' || (event === 'valid_click' && att.activityType === 'permitted_click');
        if (okEvent && att.status === 'started') {
          if (att.expiresAt.toMillis() < Date.now()) return 'expired';
          t.update(aRef, { status: 'pending_review', providerEventId: String(txn_id), providerConfirmedAt: FV.serverTimestamp() });
          t.update(uRef, { pendingPoints: FV.increment(r) });
          pLedger(t, { ...base, type: 'reward_pending', pendingDelta: r, note: 'Provider confirmed activity' });
        } else if (event === 'reversed' && ['pending_review', 'approved'].includes(att.status)) {
          const was = att.status; t.update(aRef, { status: 'reversed', reversedAt: FV.serverTimestamp() });
          if (was === 'pending_review') { t.update(uRef, { pendingPoints: FV.increment(-r) }); pLedger(t, { ...base, type: 'reward_reversed', pendingDelta: -r, note: 'Provider reversed before approval' }); }
          else { t.update(uRef, { approvedPoints: FV.increment(-r), lifetimePointsEarned: FV.increment(-r) }); pLedger(t, { ...base, type: 'reward_reversed', approvedDelta: -r, note: 'Provider reversed after approval' }); }
        } else return 'ignored';
        t.set(evRef, { partner, txn_id: String(txn_id), event, activityAttemptId: aRef.id, createdAt: FV.serverTimestamp() });
        return 'ok';
      });
      res.status(200).send(out);
    } catch (e) { console.error(e); res.status(500).send('error'); }
  });

  // ---------- Admin review ----------
  // approve: credits points exactly once (the attempt must still be started / pending_review).
  // reject: records the decision and the reason; no points are credited.
  api('adminReviewActivity', async ({ auth, data }) => {
    await adminOnly({ auth });
    const { attemptId, decision } = data; const note = String(data.note || '').trim().slice(0, 500);
    if (!['approve', 'reject'].includes(decision)) throw new HttpsError('invalid-argument', 'Bad decision.');
    if (!attemptId) throw new HttpsError('invalid-argument', 'Missing activity.');
    const aRef = db.doc('activityAttempts/' + attemptId);
    await db.runTransaction(async t => {
      const a = (await t.get(aRef)).data();
      if (!a || !['started', 'pending_review'].includes(a.status)) throw new HttpsError('failed-precondition', 'This activity was already handled.');
      if (a.uid === auth.uid) throw new HttpsError('permission-denied', 'You cannot review your own activity.');
      const wasPending = a.status === 'pending_review', r = a.rewardPoints, uRef = db.doc('users/' + a.uid);
      const base = { uid: a.uid, activityAttemptId: aRef.id, opportunityId: a.opportunityId, adminUid: auth.uid, note };
      if (decision === 'approve') {
        if (!wasPending && note.length < 10) throw new HttpsError('invalid-argument', 'No provider confirmation yet. Write a note (10+ characters) describing the evidence you checked.');
        t.update(aRef, { status: 'approved', reviewedBy: auth.uid, reviewedAt: FV.serverTimestamp(), reviewNote: note });
        t.update(uRef, { approvedPoints: FV.increment(r), lifetimePointsEarned: FV.increment(r), ...(wasPending ? { pendingPoints: FV.increment(-r) } : {}) });
        pLedger(t, { ...base, type: 'reward_approved', pendingDelta: wasPending ? -r : 0, approvedDelta: r });
      } else {
        if (note.length < 3) throw new HttpsError('invalid-argument', 'A reason is required when rejecting.');
        t.update(aRef, { status: 'rejected', reviewedBy: auth.uid, reviewedAt: FV.serverTimestamp(), reviewNote: note });
        if (wasPending) t.update(uRef, { pendingPoints: FV.increment(-r) });
        pLedger(t, { ...base, type: 'reward_rejected', pendingDelta: wasPending ? -r : 0 });
      }
      audit(t, { type: 'activity_' + decision, adminUid: auth.uid, activityAttemptId: aRef.id, uid: a.uid, note });
    });
    return { ok: true };
  });
};
