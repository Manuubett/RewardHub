// admin-bulk.js: approve MANY activities of ONE user in a single request.
// Compared with calling adminReviewActivity once per activity, this means:
//  - 1 request per user (the server allows only 60 requests per minute per IP),
//  - the user's balance document is written once per batch, not once per activity,
//  - one audit entry per batch, and the referral and streak checks run once per user.
// Each approved activity still gets its own pointLedger entry, so history and the Top users report stay exact.
module.exports = ({ api, db, FV, HttpsError, adminOnly, referrals, streaks }) => {
  const CHUNK = 100;   // activities per transaction (2 writes each + 2 shared writes, safely under Firestore's 500 limit)
  const MAX = 300;     // activities per request

  api('adminReviewBulk', async ({ auth, data }) => {
    await adminOnly({ auth });
    const uid = String(data.uid || '');
    const ids = [...new Set((Array.isArray(data.attemptIds) ? data.attemptIds : []).map(String).filter(Boolean))];
    const note = String(data.note || 'Approved by admin').trim().slice(0, 500);
    if (!uid || !ids.length) throw new HttpsError('invalid-argument', 'Missing user or activities.');
    if (ids.length > MAX) throw new HttpsError('invalid-argument', `At most ${MAX} activities per request.`);
    if (note.length < 10) throw new HttpsError('invalid-argument', 'Write a note of 10+ characters.');   // same rule as approving without partner confirmation
    if (uid === auth.uid) throw new HttpsError('permission-denied', 'You cannot review your own activity.');

    const approvedIds = [], streakItems = []; let points = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const res = await db.runTransaction(async t => {
        const uRef = db.doc('users/' + uid), refs = part.map(id => db.doc('activityAttempts/' + id));
        const [uS, ...snaps] = await Promise.all([t.get(uRef), ...refs.map(r => t.get(r))]);   // all reads first
        if (!uS.exists) throw new HttpsError('not-found', 'User not found.');
        const ok = []; snaps.forEach((s, k) => {
          const a = s.data();   // skip anything already handled or belonging to someone else, instead of failing the whole batch
          if (a && a.uid === uid && ['started', 'pending_review'].includes(a.status)) ok.push({ ref: refs[k], a });
        });
        if (!ok.length) return { ids: [], pts: 0, items: [] };
        let total = 0, pend = 0;
        for (const { ref, a } of ok) {
          const r = Number(a.rewardPoints) || 0, wasPending = a.status === 'pending_review';
          t.update(ref, { status: 'approved', reviewedBy: auth.uid, reviewedAt: FV.serverTimestamp(), reviewNote: note });
          t.set(db.collection('pointLedger').doc(), { pendingDelta: wasPending ? -r : 0, approvedDelta: r, type: 'reward_approved', uid,
            activityAttemptId: ref.id, opportunityId: a.opportunityId, adminUid: auth.uid, note, createdAt: FV.serverTimestamp() });
          total += r; if (wasPending) pend += r;
        }
        t.update(uRef, { approvedPoints: FV.increment(total), lifetimePointsEarned: FV.increment(total), ...(pend ? { pendingPoints: FV.increment(-pend) } : {}) });
        t.set(db.collection('adminAudit').doc(), { type: 'activity_approve_bulk', adminUid: auth.uid, uid, count: ok.length, activityAttemptIds: ok.map(x => x.ref.id), note, createdAt: FV.serverTimestamp() });
        return { ids: ok.map(x => x.ref.id), pts: total, items: ok.map(x => ({ code: x.a.opportunityCode, ms: x.a.createdAt?.toMillis?.() || 0 })) };
      });
      approvedIds.push(...res.ids); points += res.pts; streakItems.push(...res.items);
    }
    if (approvedIds.length) {   // once per user, after the points are safely saved; never fail an approval because of these
      try { await referrals.onPointsApproved(uid); } catch (e) { console.error('bulk referral', e); }
      try { await streaks.onApprovedBatch(uid, streakItems); } catch (e) { console.error('bulk streak', e); }
    }
    return { ok: true, approved: approvedIds.length, skipped: ids.length - approvedIds.length, points, approvedIds };
  });
};
