import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: "AIzaSyA1i_yuMePpMJ0P2nL9j3kH_-TEfqpJQIE",
  authDomain: "rewardhub-33659.firebaseapp.com",
  projectId: "rewardhub-33659",
  storageBucket: "rewardhub-33659.firebasestorage.app",
  messagingSenderId: "469096404213",
  appId: "1:469096404213:web:ce79199bba1badf91e61bc",
  measurementId: "G-H8F4X3J20D"
};


const app = initializeApp(firebaseConfig);
export const auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, 'us-central1');
