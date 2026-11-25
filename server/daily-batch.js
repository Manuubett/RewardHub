// Daily batch approval. Instead of approving task by task, the admin approves one finished day at once.
// A task is eligible when the user stayed on the partner page long enough (activityAttempts.visitPassed === true).
// The "day" uses the SAME hours as Monetag's dashboard (BATCH_TZ, default America/New_York) so both sides cover the same period.
const NAIROBI_MS = 3 * 3600e3;
const TZ = process.env.BATCH_TZ || 'America/New_York';
const CAP = process.env.BATCH_DAILY_CAP ? Number(process.env.BATCH_DAILY_CAP) : 300;      // max points one user can get from one batch day
const WARN = process.env.BATCH_RATIO_WARN ? Number(process.env.BATCH_RATIO_WARN) : 1;      // claims / impressions above this is flagged (display only)
const MAX_TASKS = 200;                                                                     // per user per batch (keeps each transaction small)
const ADULT = new Set(Array.from({ length: 6 }, (_, i) => 'BTN0' + (15 + i)));             // Tasks 15 to 20 never count for streaks

module.exports = ({ api, db, admin, FV, adminOnly, HttpsError, referrals, streaks }) => {
  const TS = admin.firestore.Timestamp;

  // ---------- day boundaries in the network's time zone ----------
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
  const dayOf = ms => new Date(ms + offsetAt(ms)).toISOString().slice(0, 10);
  const nextDay = key => new Date(Date.parse(key + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  const dayStart = key => { const [y, m, d] = key.split('-').map(Number), base = Date.UTC(y, m - 1, d), o1 = offsetAt(base + 5 * 3600e3);
    let s = base - o1; const o2 = offsetAt(s); if (o2 !== o1) s = base - o2; return s; };
  const validDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v + 'T00:00:00Z'));
  const yesterday = () => dayOf(dayStart(dayOf(Date.now())) - 1);

  // ---------- helpers ----------
  const isClaim = a => a.status === 'approved' || a.status === 'pending_review' || (a.status === 'started' && a.visitPassed === true);
  const isOpen = a => a.status === 'pending_review' || (a.status === 'started' && a.visitPassed === true);   // still waiting for approval
  const pLedger = (t, e) => t.set(db.collection('pointLedger').doc(), { pendingDelta: 0, approvedDelta: 0, ...e, createdAt: FV.serverTimestamp() });

  async function loadDay(day) {
    const start = dayStart(day), end = dayStart(nextDay(day));
    const s = await db.collection('activityAttempts').where('createdAt', '>=', TS.fromMillis(start)).where('createdAt', '<', TS.fromMillis(end)).limit(20000).get();
    return { start, end, truncated: s.size >= 20000, attempts: s.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
  async function getUsers(uids) {
    const out = {};
    for (let i = 0; i < uids.length; i += 300) {
      const snaps = await db.getAll(...uids.slice(i, i + 300).map(id => db.doc('users/' + id)));
      snaps.forEach(s => { if (s.exists) out[s.id] = s.data(); });
    }
    return out;
  }

  // Decides, per user, which waiting tasks the batch would approve:
  //  1) only clean accounts, 2) per-BTN percentage (oldest tasks first), 3) the per-user daily cap.
  function plan(attempts, users, percent, skip, adminUid) {
    const per = {};
    attempts.filter(isOpen).forEach(a => { (per[a.uid] || (per[a.uid] = [])).push(a); });
    const used = {};   // points already approved by an earlier batch run for the same day: the cap is per user per DAY, not per run
    attempts.forEach(a => { if (a.status === 'approved' && a.batchDay) used[a.uid] = (used[a.uid] || 0) + (a.rewardPoints || 0); });
    return Object.entries(per).map(([uid, list]) => {
      const u = users[uid];
      const reason = !u ? 'no profile' : u.status !== 'active' ? 'account ' + u.status : (u.flags || []).length ? 'flagged' : uid === adminUid ? 'your own account' : skip.has(uid) ? 'unticked' : null;
      list.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
      const total = {}, seen = {}; list.forEach(a => { total[a.opportunityId] = (total[a.opportunityId] || 0) + 1; });
      let points = 0; const pick = [];
      for (const a of list) {
        const pc = percent[a.opportunityId] ?? 100, idx = seen[a.opportunityId] = (seen[a.opportunityId] || 0) + 1;
        if (idx > Math.floor(total[a.opportunityId] * pc / 100)) continue;
        const r = a.rewardPoints || 0; if ((used[uid] || 0) + points + r > CAP || pick.length >= MAX_TASKS) continue;
        points += r; pick.push(a);
      }
      return { uid, name: u?.name || '', open: list.length, openPoints: list.reduce((t, a) => t + (a.rewardPoints || 0), 0), reason, pick: reason ? [] : pick, points: reason ? 0 : points };
    });
  }

  // ---------- Preview: what users claimed for the day, per BTN and per user ----------
  api('adminBatchPreview', async ({ auth, data }) => {
    await adminOnly({ auth });
    const day = validDay(data.day) ? data.day : yesterday();
    const { start, end, truncated, attempts } = await loadDay(day);
    const [users, oppSnap, statSnap] = await Promise.all([getUsers([...new Set(attempts.map(a => a.uid))]), db.collection('opportunities').get(), db.doc('batchStats/' + day).get()]);
    const btn = {}; const blank = (id, code, title, zone, so) => ({ id, code, title, zone, sortOrder: so, claimed: 0, claimedPoints: 0, unverified: 0 });
    oppSnap.docs.forEach(d => { const o = d.data(); btn[d.id] = blank(d.id, o.code || d.id, o.title || '', o.providerZoneId || '', o.sortOrder || 0); });
    let doneBatchPoints = 0;
    attempts.forEach(a => {
      const b = btn[a.opportunityId] || (btn[a.opportunityId] = blank(a.opportunityId, a.opportunityCode || a.opportunityId, a.opportunityTitle || '', '', 999));
      if (isClaim(a)) { b.claimed++; b.claimedPoints += a.rewardPoints || 0; } else if (a.status === 'started') b.unverified++;
      if (a.status === 'approved' && a.batchDay === day) doneBatchPoints += a.rewardPoints || 0;
    });
    const rows = plan(attempts, users, {}, new Set(), auth.uid).map(p => ({ uid: p.uid, name: p.name, open: p.open, openPoints: p.openPoints, payable: p.points, reason: p.reason })).sort((a, b) => b.payable - a.payable);
    const st = statSnap.exists ? statSnap.data() : null;
    return { day, tz: TZ, startMs: start, endMs: end, cap: CAP, warn: WARN, truncated, doneBatchPoints,
      btns: Object.values(btn).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)), users: rows, stats: st ? { rate: st.rate, stats: st.stats } : null };
  });

  // ---------- Save the numbers typed from Monetag's dashboard (for comparison and history) ----------
  api('adminSaveBatchStats', async ({ auth, data }) => {
    await adminOnly({ auth });
    if (!validDay(data.day)) throw new HttpsError('invalid-argument', 'Bad day.');
    const rate = Number(data.rate); if (data.rate !== '' && data.rate != null && (!Number.isFinite(rate) || rate < 0)) throw new HttpsError('invalid-argument', 'Bad USD to KES rate.');
    const stats = {};
    Object.entries(data.stats || {}).slice(0, 300).forEach(([id, v]) => {
      const imp = Number(v?.impressions), usd = Number(v?.revenueUsd);
      stats[String(id).slice(0, 40)] = { impressions: Number.isFinite(imp) && imp >= 0 ? imp : null, revenueUsd: Number.isFinite(usd) && usd >= 0 ? usd : null };
    });
    await db.doc('batchStats/' + data.day).set({ day: data.day, rate: Number.isFinite(rate) ? rate : null, stats, updatedBy: auth.uid, updatedAt: FV.serverTimestamp() });
    return { ok: true };
  });

  // After points are approved for a user: referral check once, streak update once per Nairobi day.
  async function afterApprove(uid, atts) {
    try { await referrals.onPointsApproved(uid); } catch (e) { console.error('approve referral', e); }
    const days = new Set();
    for (const x of atts.slice().sort((p, q) => p.ms - q.ms)) {
      if (!x.ms || ADULT.has(x.code)) continue;
      const d = new Date(x.ms + NAIROBI_MS).toISOString().slice(0, 10); if (days.has(d)) continue; days.add(d);
      try { await streaks.onApproved(x.id); } catch (e) { console.error('approve streak', e); }
    }
  }

  // ---------- Approve one user's picked tasks in ONE transaction ----------
  async function approveUser(p, day, adminUid) {
    const uRef = db.doc('users/' + p.uid), refs = p.pick.map(a => db.doc('activityAttempts/' + a.id));
    const done = await db.runTransaction(async t => {
      const snaps = await t.getAll(uRef, ...refs);                     // fresh reads: a task already handled is skipped, so re-running is safe
      const u = snaps[0].data(); if (!u || u.status !== 'active' || (u.flags || []).length) return null;
      let pts = 0, pend = 0; const ok = [];
      snaps.slice(1).forEach((s, i) => {
        const a = s.data(); if (!a || a.uid !== p.uid || !isOpen(a)) return;
        ok.push({ ref: refs[i], a }); pts += a.rewardPoints || 0; if (a.status === 'pending_review') pend += a.rewardPoints || 0;
      });
      if (!ok.length) return null;
      ok.forEach(({ ref }) => t.update(ref, { status: 'approved', reviewedBy: adminUid, reviewedAt: FV.serverTimestamp(), reviewNote: 'Daily batch ' + day, batchDay: day }));
      t.update(uRef, { approvedPoints: FV.increment(pts), lifetimePointsEarned: FV.increment(pts), ...(pend ? { pendingPoints: FV.increment(-pend) } : {}) });
      pLedger(t, { uid: p.uid, type: 'daily_points', pendingDelta: -pend, approvedDelta: pts, batchDay: day, taskCount: ok.length, adminUid, note: `Daily points ${day}: ${ok.length} task${ok.length > 1 ? 's' : ''}` });
      t.set(db.collection('adminAudit').doc(), { type: 'daily_batch_user', adminUid, uid: p.uid, batchDay: day, taskCount: ok.length, points: pts, createdAt: FV.serverTimestamp() });
      return { n: ok.length, pts, atts: ok.map(({ ref, a }) => ({ id: ref.id, code: a.opportunityCode, ms: a.createdAt?.toMillis?.() || 0 })) };
    });
    if (!done) return null;
    await afterApprove(p.uid, done.atts);
    return done;
  }

  // ---------- "Approve all" in the Review tab (one user at a time) ----------
  // Same rules as the single approve in points.js. One ledger entry per request; referral and streak checks run afterwards.
  api('adminReviewBulk', async ({ auth, data }) => {
    await adminOnly({ auth });
    const uid = String(data.uid || ''), note = String(data.note || '').trim().slice(0, 500);
    const ids = [...new Set((Array.isArray(data.attemptIds) ? data.attemptIds : []).map(String))].slice(0, 300);
    if (!uid || !ids.length) throw new HttpsError('invalid-argument', 'Select at least one activity.');
    if (uid === auth.uid) throw new HttpsError('permission-denied', 'You cannot review your own activity.');
    const uRef = db.doc('users/' + uid), refs = ids.map(id => db.doc('activityAttempts/' + id));
    const done = await db.runTransaction(async t => {
      const snaps = await t.getAll(uRef, ...refs);               // fresh reads: anything already handled is skipped
      if (!snaps[0].exists) throw new HttpsError('not-found', 'User not found.');
      let pts = 0, pend = 0; const ok = [];
      snaps.slice(1).forEach((s, i) => {
        const a = s.data(); if (!a || a.uid !== uid || !['started', 'pending_review'].includes(a.status)) return;
        ok.push({ ref: refs[i], a }); const r = a.rewardPoints || 0; pts += r; if (a.status === 'pending_review') pend += r;
      });
      if (!ok.length) return null;
      if (ok.some(x => x.a.status === 'started') && note.length < 10) throw new HttpsError('invalid-argument', 'No provider confirmation yet. Write a note (10+ characters) describing the evidence you checked.');
      ok.forEach(({ ref }) => t.update(ref, { status: 'approved', reviewedBy: auth.uid, reviewedAt: FV.serverTimestamp(), reviewNote: note }));
      t.update(uRef, { approvedPoints: FV.increment(pts), lifetimePointsEarned: FV.increment(pts), ...(pend ? { pendingPoints: FV.increment(-pend) } : {}) });
      pLedger(t, { uid, type: 'reward_approved', pendingDelta: -pend, approvedDelta: pts, taskCount: ok.length, adminUid: auth.uid, note });
      t.set(db.collection('adminAudit').doc(), { type: 'activity_approve_bulk', adminUid: auth.uid, uid, count: ok.length, points: pts, note, createdAt: FV.serverTimestamp() });
      return { ids: ok.map(x => x.ref.id), atts: ok.map(({ ref, a }) => ({ id: ref.id, code: a.opportunityCode, ms: a.createdAt?.toMillis?.() || 0 })) };
    });
    if (!done) return { ok: true, approved: 0, skipped: ids.length, approvedIds: [] };
    await afterApprove(uid, done.atts);
    return { ok: true, approved: done.ids.length, skipped: ids.length - done.ids.length, approvedIds: done.ids };
  });

  api('adminApproveBatch', async ({ auth, data }) => {
    await adminOnly({ auth });
    if (!validDay(data.day)) throw new HttpsError('invalid-argument', 'Choose a day.');
    const day = data.day; if (day >= dayOf(Date.now())) throw new HttpsError('failed-precondition', 'Choose a day that has already finished.');
    const percent = {}; Object.entries(data.percent || {}).forEach(([k, v]) => { const n = Number(v); if (Number.isFinite(n)) percent[k] = Math.min(100, Math.max(0, n)); });
    const skip = new Set(Array.isArray(data.skipUsers) ? data.skipUsers.map(String) : []);
    const { truncated, attempts } = await loadDay(day);
    if (truncated) throw new HttpsError('failed-precondition', 'Too many activities in one day to batch safely. Contact the developer.');
    const users = await getUsers([...new Set(attempts.map(a => a.uid))]);
    const work = plan(attempts, users, percent, skip, auth.uid).filter(p => !p.reason && p.pick.length);
    const run = { users: 0, tasks: 0, points: 0 };
    for (let i = 0; i < work.length; i += 5) {   // 5 users at a time
      const res = await Promise.all(work.slice(i, i + 5).map(p => approveUser(p, day, auth.uid).catch(e => { console.error('batch user', p.uid, e); return null; })));
      res.forEach(r => { if (r) { run.users++; run.tasks += r.n; run.points += r.pts; } });
    }
    await db.collection('dailyBatchRuns').add({ day, adminUid: auth.uid, ...run, percent, skippedUsers: skip.size, createdAt: FV.serverTimestamp() });
    return { ok: true, ...run };
  });

  return { _test: { dayStart, dayOf, plan, yesterday } };   // exposed only for tests
};
