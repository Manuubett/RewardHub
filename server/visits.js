// Visit-time check. The SERVER measures the time (browser clocks and sessionStorage can be edited by users).
// Flow: startOpportunity (existing) -> startVisit (server records start) -> user visits partner page -> returns -> completeVisit (server computes elapsed).
// This does NOT award points. Points still need the partner confirmation + admin review.
const MIN = Number(process.env.VISIT_MIN_SECONDS) || 30;
const MAX = Number(process.env.VISIT_MAX_SECONDS) || 600;                       // 600 s: honest users who read the partner page are not punished
const GATE = process.env.VISIT_GATE === 'on';                                   // unlocking is OFF until you set VISIT_GATE=on
const FREE = process.env.VISIT_FREE_TASKS ? +process.env.VISIT_FREE_TASKS : 3;   // tasks open from the start
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));   // Tasks 15 to 20 are never locked and never needed to unlock others
const OK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const bySort = (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.code).localeCompare(String(b.code));   // same tie-break as the browser

module.exports = ({ api, db, FV, HttpsError, uidOf }) => {
  const ref = (uid, oid) => db.doc(`visits/${uid}_${oid}`);
  const cleanId = v => { const s = String(v || ''); if (!OK_ID.test(s)) throw new HttpsError('invalid-argument', 'Bad task.'); return s; };

  // Lets the browser read the real settings, so the page and the server can never disagree.
  api('visitConfig', async () => ({ gate: GATE, free: FREE, minSeconds: MIN, maxSeconds: MAX }));

  api('startVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = cleanId(data.opportunityId);
    const [o, cd] = await Promise.all([db.doc('opportunities/' + oid).get(), db.doc(`cooldowns/${uid}_${oid}`).get()]);
    if (!o.exists || !o.data().active) throw new HttpsError('not-found', 'Opportunity unavailable.');
    // A visit only counts after a real startOpportunity: its cooldown must still be running.
    if (!cd.exists || (cd.data().cooldownUntil?.toMillis?.() || 0) < Date.now()) throw new HttpsError('failed-precondition', 'Start the task first.');
    await assertUnlocked(uid, oid);
    // merge: keeps an earlier "passed" flag, only reopens the timer
    await ref(uid, oid).set({ uid, opportunityId: oid, status: 'open', startedAt: FV.serverTimestamp() }, { merge: true });
    return { ok: true };
  });

  api('completeVisit', async ({ auth, data }) => {
    const uid = uidOf({ auth }), oid = cleanId(data.opportunityId), r = ref(uid, oid);
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

  // Called before startOpportunity and inside startVisit. Rule: the first FREE tasks are open; every different task you pass opens one more.
  // Users who already had approved / pending-review activities before the gate existed keep that progress (grandfathered).
  async function assertUnlocked(uid, oid) {
    if (!GATE) return;
    const [os, vs, as] = await Promise.all([db.collection('opportunities').where('active', '==', true).get(),
      db.collection('visits').where('uid', '==', uid).where('passed', '==', true).get(),
      db.collection('activityAttempts').where('uid', '==', uid).get()]);
    const all = os.docs.map(d => ({ id: d.id, ...d.data() })), byCode = new Map(all.map(o => [o.code, o.id]));
    const chain = all.filter(o => !ADULT.has(o.code)).sort(bySort);
    const i = chain.findIndex(o => o.id === oid); if (i < 0) return;   // adult-content or unknown tasks are not gated
    const passed = new Set(vs.docs.map(d => d.data().opportunityId));
    as.docs.map(d => d.data()).filter(a => ['approved', 'pending_review'].includes(a.status))
      .forEach(a => { const id = a.opportunityId || byCode.get(a.opportunityCode); if (id) passed.add(id); });
    if (i >= FREE + chain.filter(o => passed.has(o.id)).length) throw new HttpsError('failed-precondition', 'This task is locked. Pass a task you have already unlocked to open the next one.');
  }
  return { assertUnlocked };
};
