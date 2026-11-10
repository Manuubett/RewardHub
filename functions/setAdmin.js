// Usage: GOOGLE_APPLICATION_CREDENTIALS=key.json node setAdmin.js you@email.com
const admin = require('firebase-admin'); admin.initializeApp();
admin.auth().getUserByEmail(process.argv[2])
  .then(u => admin.auth().setCustomUserClaims(u.uid, { admin: true }))
  .then(() => console.log('Admin set. Sign out and in again.'));
