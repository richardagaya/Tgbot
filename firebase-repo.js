const fs = require('fs');
const path = require('path');
const { firebaseEnabled, getFirestore, admin } = require('./firebase-app');
const { runtimeFile } = require('./runtime-paths');

const DEFAULT_DB = { users: {}, orders: [], pendingPayments: [], sectionStock: {}, inventoryItems: [] };
const DEFAULT_ADMIN_STATE = { revokedSellers: [], activity: [], sellers: [] };

const cache = {
  catalog: null,
  db: null,
  adminState: null,
};

let initialized = false;
let writeQueue = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return clone(fallback);
  }
}

function localCatalogFallback() {
  return readJsonFile(runtimeFile('catalog.json'), { products: [], store: [] });
}

function localDbFallback() {
  const db = readJsonFile(runtimeFile('db.json'), DEFAULT_DB);
  return normalizeDb(db);
}

function localAdminStateFallback() {
  const state = readJsonFile(runtimeFile('admin-state.json'), DEFAULT_ADMIN_STATE);
  return normalizeAdminState(state);
}

function normalizeDb(db) {
  return {
    users: db && db.users && typeof db.users === 'object' ? db.users : {},
    orders: Array.isArray(db?.orders) ? db.orders : [],
    pendingPayments: Array.isArray(db?.pendingPayments) ? db.pendingPayments : [],
    sectionStock: db && db.sectionStock && typeof db.sectionStock === 'object' ? db.sectionStock : {},
    inventoryItems: Array.isArray(db?.inventoryItems) ? db.inventoryItems : [],
  };
}

function normalizeAdminState(state) {
  return {
    revokedSellers: Array.isArray(state?.revokedSellers) ? state.revokedSellers : [],
    activity: Array.isArray(state?.activity) ? state.activity : [],
    sellers: Array.isArray(state?.sellers) ? state.sellers : [],
  };
}

function docRef(name) {
  return getFirestore().collection('appState').doc(name);
}

async function loadDoc(name, fallback) {
  const snap = await docRef(name).get();
  if (snap.exists) return snap.data();
  await docRef(name).set(fallback);
  return fallback;
}

async function initializeFirebaseRepo() {
  if (initialized) return;
  if (!firebaseEnabled()) {
    cache.catalog = localCatalogFallback();
    cache.db = localDbFallback();
    cache.adminState = localAdminStateFallback();
    initialized = true;
    return;
  }

  const firestore = getFirestore();
  firestore.settings({ ignoreUndefinedProperties: true });

  const [catalog, db, adminState] = await Promise.all([
    loadDoc('catalog', localCatalogFallback()),
    loadDoc('db', localDbFallback()),
    loadDoc('adminState', localAdminStateFallback()),
  ]);

  cache.catalog = {
    products: Array.isArray(catalog.products) ? catalog.products : [],
    store: Array.isArray(catalog.store) ? catalog.store : [],
  };
  cache.db = normalizeDb(db);
  cache.adminState = normalizeAdminState(adminState);
  initialized = true;
}

function assertInitialized() {
  if (!initialized) {
    throw new Error('Firebase repository has not been initialized. Call initializeFirebaseRepo() before handling requests.');
  }
}

function enqueueWrite(name, data) {
  if (!firebaseEnabled()) return Promise.resolve();
  const payload = clone(data);
  writeQueue = writeQueue
    .then(() => docRef(name).set({ ...payload, updatedAt: admin.firestore.FieldValue.serverTimestamp() }))
    .catch((err) => {
      console.error(`[firebase:${name}] write failed`, err.message);
    });
  return writeQueue;
}

function waitForPendingWrites() {
  return writeQueue;
}

function getCatalog() {
  assertInitialized();
  return cache.catalog;
}

function saveCatalog(data) {
  assertInitialized();
  cache.catalog = clone(data);
  if (!firebaseEnabled()) {
    fs.writeFileSync(runtimeFile('catalog.json'), JSON.stringify(cache.catalog, null, 2), 'utf8');
  }
  return enqueueWrite('catalog', cache.catalog);
}

function getDb() {
  assertInitialized();
  return cache.db;
}

function saveDb(data) {
  assertInitialized();
  cache.db = normalizeDb(clone(data));
  if (!firebaseEnabled()) {
    fs.writeFileSync(runtimeFile('db.json'), JSON.stringify(cache.db, null, 2), 'utf8');
  }
  return enqueueWrite('db', cache.db);
}

function getAdminState() {
  assertInitialized();
  return cache.adminState;
}

function saveAdminState(data) {
  assertInitialized();
  cache.adminState = normalizeAdminState(clone(data));
  if (!firebaseEnabled()) {
    fs.writeFileSync(runtimeFile('admin-state.json'), JSON.stringify(cache.adminState, null, 2), 'utf8');
  }
  return enqueueWrite('adminState', cache.adminState);
}

function exportLocalSeed() {
  return {
    catalogPath: path.resolve(runtimeFile('catalog.json')),
    dbPath: path.resolve(runtimeFile('db.json')),
    adminStatePath: path.resolve(runtimeFile('admin-state.json')),
  };
}

module.exports = {
  DEFAULT_DB,
  DEFAULT_ADMIN_STATE,
  initializeFirebaseRepo,
  waitForPendingWrites,
  getCatalog,
  saveCatalog,
  getDb,
  saveDb,
  getAdminState,
  saveAdminState,
  exportLocalSeed,
};
