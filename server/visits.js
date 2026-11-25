// Visit-time check. The SERVER measures the time (browser clocks and sessionStorage can be edited by users).
// Flow: startVisit (server records start) -> user visits partner page -> returns -> completeVisit (server computes elapsed).
// The result is also written on the task itself (activityAttempts.visitPassed) so the daily batch knows which tasks are eligible.
// This does NOT award points. Points are only credited when the admin approves (daily batch or Review tab).
const MIN = Number(process.env.VISIT_MIN_SECONDS) || 30;
const MAX = Number(process.env.VISIT_MAX_SECONDS) || 180;
const GATE = process.env.VISIT_GATE === 'on';                                   // unlocking is OFF until you set VISIT_GATE=on
const FREE = process.env.VISIT_FREE_TASKS ? +process.env.VISIT_FREE_TASKS : 3;   // tasks open from the start
const WINDOW_MS = (Number(process.env.VISIT_ATTEMPT_WINDOW_MIN) || 60) * 60e3;   // a visit can only be linked to a task started this recently
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));   // Tasks 15 to 20 are never locked and never needed to unlock others

module.exports = ({ api, db, FV, HttpsError, uidOf }) => {
  const ref = (uid, oid) => db.doc(`visits/${uid}_${oid}`);

  api('startVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = String(data.opportunityId || '');
    const [o, c] = await Promise.all([db.doc('opportunities/' + oid).get(), db.doc(`cooldowns/${uid}_${oid}`).get()]);
    if (!o.exists || !o.data().active) throw new HttpsError('not-found', 'Opportunity unavailable.');
    // link this visit to the task that startOpportunity just created (must be the user's own, still "started", and recent)
    let attemptId = null; const aid = c.exists ? c.data().lastAttemptId : null;
    if (aid) {
      const a = await db.doc('activityAttempts/' + aid).get(), ad = a.data();
      if (a.exists && ad.uid === uid && ad.opportunityId === oid && ad.status === 'started' && ad.createdAt && Date.now() - ad.createdAt.toMillis() <= WINDOW_MS) attemptId = aid;
    }
    // merge: keeps an earlier "passed" flag, only reopens the timer
    await ref(uid, oid).set({ uid, opportunityId: oid, attemptId, status: 'open', startedAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true };
  });

  api('completeVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = String(data.opportunityId || ''), r = ref(uid, oid);
    return db.runTransaction(async t => {
      const v = (await t.get(r)).data();
      if (!v || v.status !== 'open' || !v.startedAt) return { result: 'none' };   // nothing waiting (already checked once)
      const aRef = v.attemptId ? db.doc('activityAttempts/' + v.attemptId) : null;
      const att = aRef ? (await t.get(aRef)).data() : null;                       // read before any write
      const elapsed = Math.floor((Date.now() - v.startedAt.toMillis()) / 1000);   // server time only; the browser's number is never used
      const done = { elapsed, checkedAt: FV.serverTimestamp() };
      if (elapsed < MIN || elapsed > MAX) {
        const result = elapsed < MIN ? 'too_fast' : 'too_slow';
        t.update(r, { ...done, status: result });
        if (att && att.visitPassed !== true) t.update(aRef, { visitPassed: false, visitElapsed: elapsed });   // never flip an earlier pass back
        return elapsed < MIN ? { result, elapsed, minSeconds: MIN } : { result, elapsed, maxSeconds: MAX };
      }
      t.update(r, { ...done, status: 'passed', passed: true, passedAt: FV.serverTimestamp() });
      if (att) t.update(aRef, { visitPassed: true, visitElapsed: elapsed, visitPassedAt: FV.serverTimestamp() });
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
    if (i >= FREE + chain.filter(o => passed.has(o.id)).length) throw new HttpsError('failed-precondition', 'This task is locked. Pass a task you have unlocked to open the next one.');
  }
  return { assertUnlocked };
};
