// Streaks and 7-day bonus. Server-only; days are counted by the day the task was DONE (Nairobi time).
const NAIROBI_MS = 3 * 3600e3, DAY = 864e5, CYCLE = 7;
const BONUS = Number.isFinite(+process.env.STREAK_BONUS_POINTS) ? +process.env.STREAK_BONUS_POINTS : 10;
const dayKey = ms => new Date(ms + NAIROBI_MS).toISOString().slice(0, 10);
const shift = (key, n) => dayKey(Date.parse(key + 'T00:00:00Z') + n * DAY);
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));   // Tasks 15 to 20

module.exports = ({ db, FV }) => ({
  async onApproved(attemptId) {
    const aS = await db.doc('activityAttempts/' + attemptId).get(); if (!aS.exists) return;
    const a = aS.data(); if (a.status !== 'approved' || !a.uid || ADULT.has(a.opportunityCode)) return;
    const ms = a.createdAt?.toMillis?.(); if (!ms) return;
    const day = dayKey(ms), uRef = db.doc('users/' + a.uid), sRef = db.doc('streaks/' + a.uid);

    await db.runTransaction(async t => {
      const [uS, sS] = await Promise.all([t.get(uRef), t.get(sRef)]); if (!uS.exists) return;
      const set = new Set([...(sS.data()?.days || []), day]);
      let start = day, end = day, len = 1;                       // the run of consecutive days containing this day
      while (set.has(shift(start, -1))) { start = shift(start, -1); len++; }
      while (set.has(shift(end, 1))) { end = shift(end, 1); len++; }
      const milestones = Array.from({ length: Math.floor(len / CYCLE) }, (_, i) => i + 1);
      const bRefs = milestones.map(k => db.doc(`streakBonuses/${a.uid}_${start}_${k}`));
      const bSnaps = await Promise.all(bRefs.map(r => t.get(r)));   // all reads before any write

      const last = [...set].sort().pop(), days = [...set].sort().slice(-120);
      let run = 1; while (set.has(shift(last, -run))) run++;        // streak ending on the latest day
      t.set(sRef, { uid: a.uid, days, updatedAt: FV.serverTimestamp() }, { merge: true });
      const upd = { streak: run, streakLastDay: last };
      let bonus = 0;
      if (uS.data().status === 'active' && BONUS > 0) bSnaps.forEach((s, i) => {
        if (s.exists) return; bonus += BONUS;
        t.create(bRefs[i], { uid: a.uid, runStart: start, milestone: milestones[i] * CYCLE, points: BONUS, createdAt: FV.serverTimestamp() });
        t.set(db.collection('pointLedger').doc(), { uid: a.uid, type: 'streak_bonus', pendingDelta: 0, approvedDelta: BONUS,
          note: `${milestones[i] * CYCLE}-day streak bonus`, createdAt: FV.serverTimestamp() });
      });
      if (bonus) { upd.approvedPoints = FV.increment(bonus); upd.lifetimePointsEarned = FV.increment(bonus); }
      t.update(uRef, upd);
    });
  },

  // Same rules as onApproved, but for many approved activities of ONE user at once (bulk approval):
  // one transaction, one write of the streak record and one write of the user, instead of that per activity.
  // items: [{ code, ms }]  (opportunity code and the activity's createdAt in milliseconds)
  async onApprovedBatch(uid, items) {
    const newDays = [...new Set((items || []).filter(x => x.ms && !ADULT.has(x.code)).map(x => dayKey(x.ms)))];
    if (!uid || !newDays.length) return;
    const uRef = db.doc('users/' + uid), sRef = db.doc('streaks/' + uid);

    await db.runTransaction(async t => {
      const [uS, sS] = await Promise.all([t.get(uRef), t.get(sRef)]); if (!uS.exists) return;
      const set = new Set([...(sS.data()?.days || []), ...newDays]);
      const runs = new Map();                                      // only runs that contain a NEW day, keyed by their first day (as in onApproved)
      for (const day of newDays) {
        let start = day, len = 1, end = day;
        while (set.has(shift(start, -1))) { start = shift(start, -1); len++; }
        while (set.has(shift(end, 1))) { end = shift(end, 1); len++; }
        runs.set(start, len);
      }
      const jobs = [];
      for (const [start, len] of runs) for (let k = 1; k <= Math.floor(len / CYCLE); k++) jobs.push({ ref: db.doc(`streakBonuses/${uid}_${start}_${k}`), start, k });
      const snaps = await Promise.all(jobs.map(j => t.get(j.ref)));   // all reads before any write

      const last = [...set].sort().pop(), days = [...set].sort().slice(-120);
      let run = 1; while (set.has(shift(last, -run))) run++;
      t.set(sRef, { uid, days, updatedAt: FV.serverTimestamp() }, { merge: true });
      const upd = { streak: run, streakLastDay: last };
      let bonus = 0;
      if (uS.data().status === 'active' && BONUS > 0) snaps.forEach((s, i) => {
        if (s.exists) return; bonus += BONUS;
        const { ref, start, k } = jobs[i];
        t.create(ref, { uid, runStart: start, milestone: k * CYCLE, points: BONUS, createdAt: FV.serverTimestamp() });
        t.set(db.collection('pointLedger').doc(), { uid, type: 'streak_bonus', pendingDelta: 0, approvedDelta: BONUS,
          note: `${k * CYCLE}-day streak bonus`, createdAt: FV.serverTimestamp() });
      });
      if (bonus) { upd.approvedPoints = FV.increment(bonus); upd.lifetimePointsEarned = FV.increment(bonus); }
      t.update(uRef, upd);
    });
  }
});
