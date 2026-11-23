// Visit-time check. The SERVER measures the time (browser clocks and sessionStorage can be edited by users).
// Flow: startVisit (server records start) -> user visits partner page -> returns -> completeVisit (server computes elapsed).
// This does NOT award points. Points still need the partner confirmation + admin review.
const MIN = Number(process.env.VISIT_MIN_SECONDS) || 15;
const MAX = Number(process.env.VISIT_MAX_SECONDS) || 180;
const GATE = process.env.VISIT_GATE !== 'off';   // one-task-at-a-time lock is ON unless VISIT_GATE=off

module.exports = ({ api, db, FV, HttpsError, uidOf }) => {
  const ref = (uid, oid) => db.doc(`visits/${uid}_${oid}`);

  api('startVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = String(data.opportunityId || '');
    const o = await db.doc('opportunities/' + oid).get();
    if (!o.exists || !o.data().active) throw new HttpsError('not-found', 'Opportunity unavailable.');
    // merge: keeps an earlier "passed" flag, only reopens the timer
    await ref(uid, oid).set({ uid, opportunityId: oid, status: 'open', startedAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true };
  });

  api('completeVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = String(data.opportunityId || ''), r = ref(uid, oid);
    return db.runTransaction(async t => {
      const v = (await t.get(r)).data();
      if (!v || v.status !== 'open' || !v.startedAt) return { result: 'none' };   // nothing waiting (already checked once)
      const elapsed = Math.floor((Date.now() - v.startedAt.toMillis()) / 1000);   // server time only; the browser's number is never used
      const done = { elapsed, checkedAt: FV.serverTimestamp() };
      if (elapsed < MIN) { t.update(r, { ...done, status: 'too_fast' }); return { result: 'too_fast', elapsed, minSeconds: MIN }; }
      if (elapsed > MAX) { t.update(r, { ...done, status: 'too_slow' }); return { result: 'too_slow', elapsed, maxSeconds: MAX }; }
      t.update(r, { ...done, status: 'passed', passed: true, passedAt: FV.serverTimestamp() });
      return { result: 'passed', elapsed };
    });
  });

  // Called before startOpportunity. Rule: ONE TASK AT A TIME. While the user has an open visit for task X
  // (started, not yet passed, still inside the MAX window), every other task is blocked until X is passed.
  // An open visit older than MAX can no longer pass, so it stops blocking (nobody gets stuck forever).
  async function assertUnlocked(uid, oid) {
    if (!GATE) return;
    const vs = await db.collection('visits').where('uid', '==', uid).where('status', '==', 'open').get();
    const live = vs.docs.map(d => d.data()).find(v => v.opportunityId !== oid && v.startedAt && (Date.now() - v.startedAt.toMillis()) / 1000 <= MAX);
    if (!live) return;
    const o = await db.doc('opportunities/' + live.opportunityId).get();
    const code = o.exists ? o.data().code : 'your current task';
    throw new HttpsError('failed-precondition', `Finish ${code} first. Come back here and tap "I'm back: check my visit" to unlock other tasks.`);
  }
  return { assertUnlocked };
};
