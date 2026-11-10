// Paste your Firebase web config (Project settings > General > Your apps)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
const app = initializeApp({
  apiKey: 'YOUR_API_KEY', authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT', appId: 'YOUR_APP_ID'
});
export const auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, 'us-central1');
