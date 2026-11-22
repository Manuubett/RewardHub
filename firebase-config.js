import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { initializeFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBDbpJNfAdmkZ-fAfGsiUYY0OWPWJ_e_IM",
  authDomain: "manuu-27475.firebaseapp.com",
  projectId: "manuu-27475",
  storageBucket: "manuu-27475.firebasestorage.app",
  messagingSenderId: "443796877180",
  appId: "1:443796877180:web:b89c9aae6fb106e0047ef9",
  measurementId: "G-E7G5H7FTSB"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Auto-detect lets Firestore fall back to long polling when the streaming connection is blocked or unstable
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
// Your own server's address.
export const API_URL = 'https://rewardhub-7vgx.onrender.com';
