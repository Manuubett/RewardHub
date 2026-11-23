// Visit-time check. The SERVER measures the time (browser clocks and sessionStorage can be edited by users).
// Flow: startVisit (server records start) -> user visits partner page -> returns -> completeVisit (server computes elapsed).
// This does NOT award points. Points still need the partner confirmation + admin review.
const MIN = Number(process.env.VISIT_MIN_SECONDS) || 30;
const MAX = Number(process.env.VISIT_MAX_SECONDS) || 180;
const GATE = process.env.VISIT_GATE === 'on';                                   // unlocking is OFF until you set VISIT_GATE=on
const FREE = process.env.VISIT_FREE_TASKS ? +process.env.VISIT_FREE_TASKS : 3;   // tasks open from the start
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));   // Tasks 15 to 20 are never locked and never needed to unlock others

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

  // Called before startOpportunity. Rule: the first FREE tasks are open; every different task you pass opens one more.
  async function assertUnlocked(uid, oid) {
    if (!GATE) return;
    const [os, vs] = await Promise.all([db.collection('opportunities').where('active', '==', true).get(),
      db.collection('visits').where('uid', '==', uid).where('passed', '==', true).get()]);
    const chain = os.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => !ADULT.has(o.code)).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const i = chain.findIndex(o => o.id === oid); if (i < 0) return;   // adult-content or unknown tasks are not gated
    const passed = new Set(vs.docs.map(d => d.data().opportunityId));
    if (i >= FREE + chain.filter(o => passed.has(o.id)).length) throw new HttpsError('failed-precondition', 'This task is locked. Pass a task you have already unlocked to open the next one.');
  }
  return { assertUnlocked };
};
