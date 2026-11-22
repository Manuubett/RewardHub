// referrals.js: Refer & Earn rules. The referrer earns 50 points when the referred friend reaches 100 APPROVED points.
// Only the server writes referral data; users can never give themselves points.
const crypto = require('crypto');

module.exports = ({ db, FV }) => {
  const REF_BONUS = 50, REF_TARGET = 100;
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I so codes are easy to read out
  const makeCode = () => Array.from(crypto.randomBytes(8), b => ALPHA[b % ALPHA.length]).join('');
  const maskName = n => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || 'Friend'); };

  // Gives a user their own invite code (once). Also used for users who registered before referrals existed.
  async function ensureReferralCode(uid) {
    const ref = db.doc('users/' + uid), snap = await ref.get();
    if (!snap.exists) return '';
    if (snap.data().referralCode) return snap.data().referralCode;
    for (let i = 0; i < 5; i++) {
      const code = makeCode();
      if ((await db.collection('users').where('referralCode', '==', code).limit(1).get()).empty) { await ref.update({ referralCode: code }); return code; }
    }
    return '';
  }

  // Called right after a new users/{uid} document is created. Never throws.
  async function onRegister({ uid, referralCode, deviceId }) {
    try {
      await ensureReferralCode(uid);
      const code = String(referralCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return;
      const found = await db.collection('users').where('referralCode', '==', code).limit(1).get();
      if (found.empty || found.docs[0].id === uid) return;
      const referrer = found.docs[0], me = (await db.doc('users/' + uid).get()).data() || {};
      const sameDevice = !!deviceId && referrer.data().deviceId === deviceId;   // same device = probably the same person
      // Document id = the friend's uid, so a friend can only ever have ONE referrer and the bonus can only be paid once.
      await db.doc('referrals/' + uid).create({
        referrerUid: referrer.id, friendUid: uid, friendName: maskName(me.name), referralCode: code,
        status: sameDevice ? 'rejected' : 'signed_up', reason: sameDevice ? 'same_device' : '', friendPoints: 0, bonusPoints: 0, createdAt: FV.serverTimestamp()
      });
    } catch (e) { console.error('referral onRegister', e); }
  }

  // Called after points were approved for friendUid. Pays the bonus once the friend has 100 approved points.
  async function onPointsApproved(friendUid) {
    try {
      const refRef = db.doc('referrals/' + friendUid);
      await db.runTransaction(async t => {
        const [r, f, led] = await Promise.all([t.get(refRef), t.get(db.doc('users/' + friendUid)), t.get(db.collection('pointLedger').where('uid', '==', friendUid))]);
        if (!r.exists || r.data().status !== 'signed_up' || !f.exists) return;
        // Approved points the friend earned from activities (approvals minus reversals). Referral bonuses and adjustments do not count.
        const pts = led.docs.map(d => d.data()).filter(x => x.type === 'reward_approved' || x.type === 'reward_reversed').reduce((a, x) => a + (x.approvedDelta || 0), 0);
        if (pts < REF_TARGET) { if (pts !== r.data().friendPoints) t.update(refRef, { friendPoints: Math.max(0, pts) }); return; }
        const uRef = db.doc('users/' + r.data().referrerUid), u = await t.get(uRef);
        if (!u.exists || u.data().status !== 'active' || f.data().status !== 'active') { t.update(refRef, { status: 'rejected', reason: 'account_not_active', friendPoints: pts }); return; }
        t.update(uRef, { approvedPoints: FV.increment(REF_BONUS), lifetimePointsEarned: FV.increment(REF_BONUS) });
        t.set(db.collection('pointLedger').doc(), { uid: u.id, type: 'referral_bonus', pendingDelta: 0, approvedDelta: REF_BONUS, friendUid, note: 'Referral bonus', createdAt: FV.serverTimestamp() });
        t.update(refRef, { status: 'qualified', friendPoints: pts, bonusPoints: REF_BONUS, qualifiedAt: FV.serverTimestamp() });
      });
    } catch (e) { console.error('referral onPointsApproved', e); }
  }
  return { onRegister, onPointsApproved, ensureReferralCode, REF_BONUS, REF_TARGET };
};
