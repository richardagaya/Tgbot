require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getFirestore, getBucket, firebaseEnabled } = require('../firebase-app');

const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'catalog.json');
const DB_PATH = path.join(ROOT, 'db.json');
const ADMIN_STATE_PATH = path.join(ROOT, 'admin-state.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) out.push(...walkFiles(fp));
    else out.push(fp);
  }
  return out;
}

function relUploadObject(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

async function uploadExistingUploads(bucket, catalog, db) {
  if (!fs.existsSync(UPLOADS_DIR)) return { catalog, db };
  if (!Array.isArray(db.inventoryItems)) db.inventoryItems = [];

  const productsById = new Map((catalog.products || []).map((p) => [p.id, p]));
  for (const filePath of walkFiles(UPLOADS_DIR)) {
    if (!filePath.toLowerCase().endsWith('.zip')) continue;
    const objectName = relUploadObject(filePath);
    await bucket.upload(filePath, {
      destination: objectName,
      metadata: { contentType: 'application/zip' },
    });

    const parts = objectName.split('/');
    const productId = parts[1];
    const kind = parts[2];
    const product = productsById.get(productId);
    if (!product) continue;

    if (kind === 'delivery') {
      product.deliveryStoragePath = objectName;
      product.deliveryZipPath = null;
      product.filePath = null;
      product.deliveryFolder = null;
      product.inventoryFolder = null;
      product.inventoryStoragePrefix = null;
    }

    if (kind === 'inventory') {
      product.inventoryStoragePrefix = `uploads/${productId}/inventory`;
      product.inventoryFolder = null;
      product.filePath = null;
      product.deliveryFolder = null;
      product.deliveryZipPath = null;
      product.deliveryStoragePath = null;
      db.inventoryItems.push({
        id: `${productId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        productId,
        filename: path.basename(filePath),
        storagePath: objectName,
        status: 'available',
        createdAt: new Date().toISOString(),
      });
    }
  }

  return { catalog, db };
}

async function main() {
  if (!firebaseEnabled()) {
    throw new Error('Set FIREBASE_ENABLED=true and FIREBASE_STORAGE_BUCKET before running this migration.');
  }
  const firestore = getFirestore();
  const bucket = getBucket();

  const catalog = readJson(CATALOG_PATH, { products: [], store: [] });
  const db = readJson(DB_PATH, { users: {}, orders: [], pendingPayments: [], sectionStock: {}, inventoryItems: [] });
  const adminState = readJson(ADMIN_STATE_PATH, { revokedSellers: [], activity: [], sellers: [] });

  const migrated = await uploadExistingUploads(bucket, catalog, db);

  await firestore.collection('appState').doc('catalog').set(migrated.catalog);
  await firestore.collection('appState').doc('db').set(migrated.db);
  await firestore.collection('appState').doc('adminState').set(adminState);

  console.log('Firebase migration complete.');
  console.log(`Products: ${(migrated.catalog.products || []).length}`);
  console.log(`Orders: ${(migrated.db.orders || []).length}`);
  console.log(`Inventory items: ${(migrated.db.inventoryItems || []).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
