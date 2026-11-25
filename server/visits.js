// Visit-time check. The SERVER measures the time (browser clocks and sessionStorage can be edited by users).
// Flow: startVisit (server records start) -> user visits partner page -> returns -> completeVisit (server computes elapsed).
// The result is also written on the task itself (activityAttempts.visitPassed) so the daily batch knows which tasks are eligible.
// Also enforced here, on the server: ONE TASK AT A TIME per account (visitLocks) and phones only (MOBILE_ONLY).
// This does NOT award points. Points are only credited when the admin approves (daily batch or Review tab).
const MIN = Number(process.env.VISIT_MIN_SECONDS) || 15;
const MAX = Number(process.env.VISIT_MAX_SECONDS) || 180;
const GATE = process.env.VISIT_GATE === 'on';                                   // unlocking is OFF until you set VISIT_GATE=on
const FREE = process.env.VISIT_FREE_TASKS ? +process.env.VISIT_FREE_TASKS : 3;   // tasks open from the start
const WINDOW_MS = (Number(process.env.VISIT_ATTEMPT_WINDOW_MIN) || 60) * 60e3;   // a visit can only be linked to a task started this recently
const LOCK_MS = (MAX + 30) * 1000;                                              // a task lock expires by itself if the user never comes back
const MOBILE_ONLY = process.env.MOBILE_ONLY !== 'off';                          // phones only; set MOBILE_ONLY=off on Render to allow computers
const MOBILE_UA = /Android|iPhone|iPod|Mobile|Windows Phone|IEMobile|Opera Mini|BlackBerry/i;
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));   // Tasks 15 to 20 are never locked and never needed to unlock others

module.exports = ({ api, db, FV, HttpsError, uidOf }) => {
  const ref = (uid, oid) => db.doc(`visits/${uid}_${oid}`);
  const lockRef = uid => db.doc('visitLocks/' + uid);

  // Phones only. Admins are exempt. (The browser's device description can be faked, so this is a speed bump, not a wall.)
  async function assertMobile(c) {
    if (!MOBILE_ONLY || MOBILE_UA.test(c.ua || '')) return;
    if (c.auth?.token?.admin === true || (await db.doc('admins/' + c.auth?.uid).get()).exists) return;
    throw new HttpsError('permission-denied', 'Please use your phone to do tasks. Computers are not supported.');
  }

  // One task at a time per ACCOUNT (tabs, devices and scripts all share this lock). Atomic: two simultaneous starts cannot both win.
  // Same task again is allowed (retry / double tap). Returns { fresh }: true when this call created the lock.
  function acquire(uid, oid) {
    return db.runTransaction(async t => {
      const l = (await t.get(lockRef(uid))).data(), now = Date.now(), live = !!l && l.expiresAtMs > now;
      if (live && l.opportunityId !== oid) throw new HttpsError('failed-precondition', 'Finish your current task first. Go to the partner page, wait for it to load, then come back and tap "I\'m back".', { busyUntilMs: l.expiresAtMs });
      if (live) return { fresh: false };   // already held by this same task: no extra write (saves Firestore writes)
      t.set(lockRef(uid), { uid, opportunityId: oid, expiresAtMs: now + LOCK_MS, updatedAt: FV.serverTimestamp() });
      return { fresh: true };
    });
  }
  const release = uid => lockRef(uid).delete().catch(e => console.error('release lock', e));

  api('startVisit', async ({ auth, data, ua }) => {
    const uid = uidOf({ auth }), oid = String(data.opportunityId || '');
    await assertMobile({ auth, ua });
    const [o, c] = await Promise.all([db.doc('opportunities/' + oid).get(), db.doc(`cooldowns/${uid}_${oid}`).get()]);
    if (!o.exists || !o.data().active) throw new HttpsError('not-found', 'Opportunity unavailable.');
    await acquire(uid, oid);   // also covers "Try again" after a failed check: a retry still needs the lock
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
      const att = aRef ? (await t.get(aRef)).data() : null;                       // reads first, then writes
      const lk = (await t.get(lockRef(uid))).data();
      const elapsed = Math.floor((Date.now() - v.startedAt.toMillis()) / 1000);   // server time only; the browser's number is never used
      const done = { elapsed, checkedAt: FV.serverTimestamp() };
      if (lk && lk.opportunityId === oid) t.delete(lockRef(uid));                 // the visit is closed (pass or fail), so the account is free again
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
  return { assertUnlocked, assertMobile, acquire, release };
};
