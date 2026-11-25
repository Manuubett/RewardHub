// Admin extras: (1) add more BTN opportunities beyond BTN020, (2) "top users" report to share on WhatsApp.
module.exports = ({ api, db, admin, FV, adminOnly, HttpsError }) => {
  const TS = admin.firestore.Timestamp, MAX_BTN = 100;
  const mask = n => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : (p[0] || 'Member'); };

  // Creates the next BTN (BTN021, BTN022, ...) as a PAUSED opportunity. The admin then fills in URL, reward and ticks Active.
  api('adminAddOpportunity', async ({ auth }) => {
    await adminOnly({ auth });
    const snap = await db.collection('opportunities').get();
    let max = 0; snap.forEach(d => { const m = /^BTN(\d+)$/.exec(d.data().code || ''); if (m) max = Math.max(max, +m[1]); });
    for (let i = 1; i <= 5; i++) {
      const n = max + i; if (n > MAX_BTN) throw new HttpsError('failed-precondition', `Limit is BTN${MAX_BTN}.`);
      const code = 'BTN' + String(n).padStart(3, '0');
      try {
        await db.doc('opportunities/' + code).create({ code, title: 'Task ' + n, provider: '', partnerId: '', providerZoneId: '', destinationUrl: '',
          trackingParam: 'click_id', activityType: 'verified_offer', rewardPoints: 0, cooldownMinutes: 30, requirements: '',
          incentiveApproved: false, providerPermissionNote: '', active: false, sortOrder: n, createdAt: FV.serverTimestamp() });
        return { ok: true, code };
      } catch (e) { if (e.code !== 6) throw e; }   // 6 = already exists: try the next number
    }
    throw new HttpsError('already-exists', 'Could not create a new BTN. Try again.');
  });

  // Reject several activities at once (checkboxes in the Review tab). Same rules as the single reject in points.js:
  // a reason is required, only "started" / "pending_review" tasks can be rejected, you cannot review your own task.
  // Each user's balance is updated once, in one transaction.
  api('adminRejectMany', async ({ auth, data }) => {
    await adminOnly({ auth });
    const ids = [...new Set((Array.isArray(data.attemptIds) ? data.attemptIds : []).map(String))].slice(0, 200);
    const note = String(data.note || '').trim().slice(0, 500);
    if (!ids.length) throw new HttpsError('invalid-argument', 'Select at least one activity.');
    if (note.length < 3) throw new HttpsError('invalid-argument', 'A reason is required when rejecting.');
    const snaps = await db.getAll(...ids.map(id => db.doc('activityAttempts/' + id)));
    const byUser = {};
    snaps.forEach(s => { const a = s.exists && s.data(); if (a && ['started', 'pending_review'].includes(a.status) && a.uid !== auth.uid) (byUser[a.uid] || (byUser[a.uid] = [])).push(s.ref); });
    let rejected = 0; const rejectedIds = [];
    for (const [uid, refs] of Object.entries(byUser)) {
      const uRef = db.doc('users/' + uid);
      const res = await db.runTransaction(async t => {
        const fresh = await t.getAll(...refs);   // re-read: anything already handled in the meantime is skipped
        let pend = 0, n = 0; const ids = [];
        fresh.forEach(s => {
          const a = s.data(); if (!a || !['started', 'pending_review'].includes(a.status)) return;
          const wasPending = a.status === 'pending_review', r = a.rewardPoints || 0; n++; ids.push(s.id);
          t.update(s.ref, { status: 'rejected', reviewedBy: auth.uid, reviewedAt: FV.serverTimestamp(), reviewNote: note });
          if (wasPending) pend += r;
          t.set(db.collection('pointLedger').doc(), { uid, activityAttemptId: s.id, opportunityId: a.opportunityId, adminUid: auth.uid, note, type: 'reward_rejected',
            pendingDelta: wasPending ? -r : 0, approvedDelta: 0, createdAt: FV.serverTimestamp() });
        });
        if (!n) return { n: 0, ids: [] };
        if (pend) t.update(uRef, { pendingPoints: FV.increment(-pend) });
        t.set(db.collection('adminAudit').doc(), { type: 'activity_reject_many', adminUid: auth.uid, uid, count: n, note, createdAt: FV.serverTimestamp() });
        return { n, ids };
      });
      rejected += res.n; rejectedIds.push(...res.ids);
    }
    return { ok: true, rejected, skipped: ids.length - rejected, rejectedIds };   // rejectedIds: exactly which tasks were rejected, so the screen only removes those
  });

  // Best users by APPROVED points only (reviewed, partner-confirmed). Flagged or suspended accounts are excluded. Names are masked.
  api('adminTopUsers', async ({ auth, data }) => {
    await adminOnly({ auth });
    const period = ['week', 'month', 'all'].includes(data.period) ? data.period : 'week';
    const ok = u => u && u.status === 'active' && !(u.flags || []).length;
    let board = [], participants = 0, totalPoints = 0, truncated = false;
    if (period === 'all') {   // lifetime total (includes referral and streak bonuses)
      const s = await db.collection('users').orderBy('lifetimePointsEarned', 'desc').limit(50).get();
      board = s.docs.filter(d => ok(d.data())).slice(0, 10).map(d => ({ name: mask(d.data().name), points: d.data().lifetimePointsEarned || 0, activities: null, streak: d.data().streak || 0 }));
    } else {
      const since = TS.fromMillis(Date.now() - (period === 'week' ? 7 : 30) * 864e5);
      const s = await db.collection('pointLedger').where('createdAt', '>=', since).limit(10000).get();
      truncated = s.size >= 10000;
      const agg = {};
      s.forEach(d => { const x = d.data(); if (!x.uid || !['reward_approved', 'daily_points', 'reward_reversed'].includes(x.type)) return;
        const a = agg[x.uid] || (agg[x.uid] = { points: 0, activities: 0 }); a.points += x.approvedDelta || 0; a.activities += x.type === 'reward_reversed' ? -1 : (x.taskCount || 1); });
      const ids = Object.keys(agg).filter(id => agg[id].points > 0).sort((a, b) => agg[b].points - agg[a].points);
      participants = ids.length; totalPoints = ids.reduce((t, id) => t + agg[id].points, 0);
      const top = ids.slice(0, 30), docs = top.length ? await db.getAll(...top.map(id => db.doc('users/' + id))) : [];
      board = docs.filter(d => d.exists && ok(d.data())).slice(0, 10).map(d => ({ name: mask(d.data().name), points: agg[d.id].points, activities: agg[d.id].activities, streak: d.data().streak || 0 }));
    }
    return { period, board, participants, totalPoints, truncated };
  });
};
