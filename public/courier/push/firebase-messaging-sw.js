/* Firebase Messaging worker for the courier PWA. It lives under /push/ so it
 * does not replace Flutter's app-shell worker at the /courier/ scope. */
importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDWuuoCCc430zTLnsi5zTJYSLhYCwcYdCc',
  authDomain: 'farmanorte-notificaciones.firebaseapp.com',
  projectId: 'farmanorte-notificaciones',
  storageBucket: 'farmanorte-notificaciones.firebasestorage.app',
  messagingSenderId: '348754050469',
  appId: '1:348754050469:web:b265fc86d2172127a73c4c',
});

// FCM displays notification payloads while the PWA is in the background. The
// server includes an fcm_options.link with the delivery/chat deep link.
firebase.messaging();
