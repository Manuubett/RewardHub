// ads.js: "Watch & Earn" for the Telegram Mini App.
// Flow: startAd (server opens a session) > user watches the ad > claimAd (server checks timing + limits, then credits points).
// Points go straight to approvedPoints, so users can use the existing "Request payment" flow (10 points = KES 1).
// Add to server.js (after the daily-batch require):  require('./ads')({ api, db, admin, HttpsError, uidOf });
const crypto = require('crypto');

module.exports = function registerAds({ api, db, admin, HttpsError, uidOf }) {
  const FV = admin.firestore.FieldValue;

  // ---- TUNE THESE after you see your real Monetag CPM in the Statistics tab ----
  const ADS_PER_POINT = 3;        // 3 ads = 1 point = KES 0.10. Pay out well under what each ad earns you.
  const DAILY_CAP = 24;           // max ads per user per day (keep a multiple of ADS_PER_POINT)
  const MIN_WATCH_MS = 12000;     // a claim sooner than this after startAd is rejected (ad cannot have played)
  const MAX_AGE_MS = 10 * 60e3;   // a session older than this is expired
  const GAP_MS = 20000;           // minimum gap between two ads

  const dayKey = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   // Nairobi day
  const shape = (n, extra = {}) => ({ count: n, cap: DAILY_CAP, perPoint: ADS_PER_POINT, toNext: (ADS_PER_POINT - n % ADS_PER_POINT) % ADS_PER_POINT, ...extra });

  api('adStatus', async ({ auth }) => {
    const uid = uidOf({ auth }), d = await db.doc(`adDays/${uid}_${dayKey()}`).get();
    return shape(d.exists ? d.data().count : 0);
  });

  api('startAd', async ({ auth }) => {
    const uid = uidOf({ auth });
    const uRef = db.doc('users/' + uid), sRef = db.doc('adSessions/' + uid), dRef = db.doc(`adDays/${uid}_${dayKey()}`);
    return db.runTransaction(async t => {
      const [u, s, d] = await Promise.all([t.get(uRef), t.get(sRef), t.get(dRef)]);
      if (!u.exists || u.data().status !== 'active') throw new HttpsError('permission-denied', 'Account not available. Contact support.');
      if ((d.exists ? d.data().count : 0) >= DAILY_CAP) throw new HttpsError('resource-exhausted', 'Daily limit reached. Come back tomorrow.');
      const now = Date.now(), last = s.exists ? s.data().lastClaimMs || 0 : 0;
      if (now - last < GAP_MS) throw new HttpsError('resource-exhausted', 'Please wait a few seconds before the next ad.');
      const token = crypto.randomBytes(16).toString('hex');
      t.set(sRef, { token, startedMs: now, lastClaimMs: last });
      return { token };
    });
  });

  api('claimAd', async ({ auth, data }) => {
    const uid = uidOf({ auth }), token = String(data.token || '');
    const uRef = db.doc('users/' + uid), sRef = db.doc('adSessions/' + uid), dRef = db.doc(`adDays/${uid}_${dayKey()}`);
    return db.runTransaction(async t => {
      const [s, d] = await Promise.all([t.get(sRef), t.get(dRef)]);
      const ses = s.data(), now = Date.now();
      if (!ses || !ses.token || ses.token !== token) throw new HttpsError('failed-precondition', 'No ad in progress.');   // one claim per session
      const age = now - ses.startedMs;
      if (age < MIN_WATCH_MS) throw new HttpsError('failed-precondition', 'The ad was not completed. No points added.');
      if (age > MAX_AGE_MS) throw new HttpsError('failed-precondition', 'That ad expired. Try again.');
      const n = d.exists ? d.data().count : 0;
      if (n >= DAILY_CAP) throw new HttpsError('resource-exhausted', 'Daily limit reached. Come back tomorrow.');
      const n1 = n + 1, award = n1 % ADS_PER_POINT === 0 ? 1 : 0;
      t.set(dRef, { uid, day: dayKey(), count: n1, points: (d.exists ? d.data().points || 0 : 0) + award, updatedAt: FV.serverTimestamp() }, { merge: true });
      t.update(sRef, { token: null, lastClaimMs: now });
      if (award) {
        t.update(uRef, { approvedPoints: FV.increment(1), lifetimePointsEarned: FV.increment(1) });
        t.set(db.collection('pointLedger').doc(), { pendingDelta: 0, approvedDelta: 1, type: 'ad_reward', uid, note: `Watched ${ADS_PER_POINT} ads`, createdAt: FV.serverTimestamp() });
      }
      return shape(n1, { awarded: award });
    });
  });
};
