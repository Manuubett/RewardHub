// Usage: node setAdmin.js you@email.com   (needs serviceAccountKey.json in this folder)
// Grants the Firebase custom claim `admin: true`. This is one of two ways to be an admin (the other is a
// document at admins/{uid} created in the Firebase console). The user must sign out and in again afterwards.
const admin = require('firebase-admin'); admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
const email = process.argv[2]; if (!email) { console.error('Usage: node setAdmin.js you@email.com'); process.exit(1); }
admin.auth().getUserByEmail(email)
  .then(u => admin.auth().setCustomUserClaims(u.uid, { admin: true }))
  .then(() => { console.log('Admin set for ' + email + '. Sign out and in again.'); process.exit(0); })
  .catch(e => { console.error('Failed:', e.message); process.exit(1); });
