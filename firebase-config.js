// Paste your Firebase web config (Project settings > General > Your apps)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
const firebaseConfig = {
  apiKey: "AIzaSyBDbpJNfAdmkZ-fAfGsiUYY0OWPWJ_e_IM",
  authDomain: "manuu-27475.firebaseapp.com",
  projectId: "manuu-27475",
  storageBucket: "manuu-27475.firebasestorage.app",
  messagingSenderId: "443796877180",
  appId: "1:443796877180:web:b89c9aae6fb106e0047ef9",
  measurementId: "G-E7G5H7FTSB"
}};
export const auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, 'us-central1');
