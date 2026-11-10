// Usage: node setAdmin.js you@email.com  (needs serviceAccountKey.json in this folder)
const admin = require('firebase-admin'); admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });
admin.auth().getUserByEmail(process.argv[2])
  .then(u => admin.auth().setCustomUserClaims(u.uid, { admin: true }))
  .then(() => console.log('Admin set. Sign out and in again.'));
