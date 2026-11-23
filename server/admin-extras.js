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
      s.forEach(d => { const x = d.data(); if (!x.uid || !['reward_approved', 'reward_reversed'].includes(x.type)) return;
        const a = agg[x.uid] || (agg[x.uid] = { points: 0, activities: 0 }); a.points += x.approvedDelta || 0; a.activities += x.type === 'reward_approved' ? 1 : -1; });
      const ids = Object.keys(agg).filter(id => agg[id].points > 0).sort((a, b) => agg[b].points - agg[a].points);
      participants = ids.length; totalPoints = ids.reduce((t, id) => t + agg[id].points, 0);
      const top = ids.slice(0, 30), docs = top.length ? await db.getAll(...top.map(id => db.doc('users/' + id))) : [];
      board = docs.filter(d => d.exists && ok(d.data())).slice(0, 10).map(d => ({ name: mask(d.data().name), points: agg[d.id].points, activities: agg[d.id].activities, streak: d.data().streak || 0 }));
    }
    return { period, board, participants, totalPoints, truncated };
  });
};
