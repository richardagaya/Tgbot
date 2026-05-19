const admin = require('firebase-admin');

function envEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.FIREBASE_ENABLED || ''));
}

function firebaseEnabled() {
  return Boolean(
    envEnabled() ||
      process.env.FIREBASE_STORAGE_BUCKET ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT
  );
}

function appOptions() {
  const opts = {};
  if (process.env.FIREBASE_STORAGE_BUCKET) opts.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (process.env.FIREBASE_PROJECT_ID) opts.projectId = process.env.FIREBASE_PROJECT_ID;
  return opts;
}

function getFirebaseApp() {
  if (!firebaseEnabled()) return null;
  if (admin.apps.length) return admin.app();
  return admin.initializeApp(appOptions());
}

function getFirestore() {
  const app = getFirebaseApp();
  return app ? admin.firestore(app) : null;
}

function getBucket() {
  const app = getFirebaseApp();
  if (!app) return null;
  return admin.storage(app).bucket();
}

module.exports = {
  admin,
  firebaseEnabled,
  getFirebaseApp,
  getFirestore,
  getBucket,
};
