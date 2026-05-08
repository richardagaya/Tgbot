const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, 'catalog.json');

const DEFAULT_CATALOG = {
  products: [
    {
      id: 'p1',
      name: '📘 Sample product',
      description: 'Replace in catalog.json or use the admin page.',
      price: 1,
      fileId: null,
      filePath: null,
    },
  ],
  store: [
    {
      id: 'shop',
      name: '🛒 Shop',
      subs: [
        {
          id: 'all',
          name: '📦 All items',
          subs: [{ id: 'main', name: 'Main', productIds: ['p1'] }],
        },
      ],
    },
  ],
};

let cache = null;
let cacheMtime = 0;

function ensureCatalogFile() {
  if (!fs.existsSync(CATALOG_PATH)) {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(DEFAULT_CATALOG, null, 2), 'utf8');
  }
}

function readDiskMtime() {
  try {
    return fs.statSync(CATALOG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function loadCatalog() {
  ensureCatalogFile();
  const mtime = readDiskMtime();
  if (cache && mtime === cacheMtime) return cache;
  const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  cache = {
    products: Array.isArray(raw.products) ? raw.products.map(normalizeProduct) : [],
    store: Array.isArray(raw.store) ? raw.store : [],
  };
  cacheMtime = mtime;
  return cache;
}

function getProducts() {
  return loadCatalog().products;
}

function getStore() {
  return loadCatalog().store;
}

function findProduct(productId) {
  return getProducts().find((p) => p.id === productId) || null;
}

function invalidateCatalogCache() {
  cache = null;
  cacheMtime = 0;
}

function normalizeProduct(p) {
  const price = Number.parseFloat(p.price);
  return {
    id: String(p.id || '').trim(),
    name: String(p.name || '').trim(),
    description: String(p.description || '').trim(),
    price: Number.isFinite(price) ? Math.round(price * 100) / 100 : 0,
    fileId: p.fileId == null || p.fileId === '' ? null : String(p.fileId),
    filePath: p.filePath == null || p.filePath === '' ? null : String(p.filePath),
    /** Folder on disk (relative to project or absolute) — zipped and sent on purchase. */
    deliveryFolder: p.deliveryFolder == null || p.deliveryFolder === '' ? null : String(p.deliveryFolder),
    /** Pre-built zip file path (optional; sent as-is if set and file exists). */
    deliveryZipPath: p.deliveryZipPath == null || p.deliveryZipPath === '' ? null : String(p.deliveryZipPath),
  };
}

function eachLeaf(store, fn) {
  for (const cat of store) {
    for (const sub of cat.subs || []) {
      for (const ss of sub.subs || []) {
        fn(cat, sub, ss);
      }
    }
  }
}

function listStoreLeaves() {
  const out = [];
  eachLeaf(getStore(), (cat, sub, ss) => {
    out.push({
      path: `${cat.id}:${sub.id}:${ss.id}`,
      label: `${cat.name} › ${sub.name} › ${ss.name}`,
    });
  });
  return out;
}

function validateStoreReferences(products, store) {
  const ids = new Set(products.map((p) => p.id));
  eachLeaf(store, (_c, _s, ss) => {
    for (const pid of ss.productIds || []) {
      if (!ids.has(pid)) {
        throw new Error(`Store lists unknown product id: ${pid}`);
      }
    }
  });
}

function saveCatalog(data) {
  const products = (data.products || []).map(normalizeProduct);
  for (const p of products) {
    if (!p.id) throw new Error('Every product needs an id');
    if (!p.name) throw new Error(`Product ${p.id} needs a name`);
    if (p.price < 0) throw new Error(`Product ${p.id}: price cannot be negative`);
  }
  const seen = new Set();
  for (const p of products) {
    if (seen.has(p.id)) throw new Error(`Duplicate product id: ${p.id}`);
    seen.add(p.id);
  }
  const store = JSON.parse(JSON.stringify(data.store || []));
  validateStoreReferences(products, store);
  fs.writeFileSync(CATALOG_PATH, JSON.stringify({ products, store }, null, 2), 'utf8');
  invalidateCatalogCache();
}

function nextProductId(products) {
  let max = 0;
  for (const p of products) {
    const m = /^p(\d+)$/i.exec(p.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `p${max + 1}`;
}

function slugifyId(value, fallback = 'item') {
  const slug = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function uniqueId(base, existingIds) {
  const root = slugifyId(base);
  const seen = new Set(existingIds);
  if (!seen.has(root)) return root;
  for (let i = 2; i < 10000; i += 1) {
    const candidate = `${root}_${i}`;
    if (!seen.has(candidate)) return candidate;
  }
  throw new Error('Could not create a unique id');
}

function addCategory(opts) {
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('Category name is required');
  const cat = loadCatalog();
  const id = uniqueId(opts.id || name, cat.store.map((c) => c.id));
  cat.store.push({ id, name, subs: [] });
  saveCatalog(cat);
  return { id, name };
}

function addGroup(opts) {
  const cat = loadCatalog();
  const catId = String(opts.catId || '').trim();
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('Subcategory name is required');
  const hit = cat.store.find((c) => c.id === catId);
  if (!hit) throw new Error('Category not found');
  if (!Array.isArray(hit.subs)) hit.subs = [];
  const id = uniqueId(opts.id || name, hit.subs.map((s) => s.id));
  hit.subs.push({ id, name, subs: [] });
  saveCatalog(cat);
  return { id, name };
}

function addSection(opts) {
  const cat = loadCatalog();
  const catId = String(opts.catId || '').trim();
  const subId = String(opts.subId || '').trim();
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('Section name is required');
  const hitCat = cat.store.find((c) => c.id === catId);
  if (!hitCat) throw new Error('Category not found');
  const hitSub = (hitCat.subs || []).find((s) => s.id === subId);
  if (!hitSub) throw new Error('Subcategory not found');
  if (!Array.isArray(hitSub.subs)) hitSub.subs = [];
  const id = uniqueId(opts.id || name, hitSub.subs.map((s) => s.id));
  const section = {
    id,
    name,
    productIds: [],
  };
  const description = String(opts.description || '').trim();
  if (description) section.description = description;
  if (opts.quantityAvailable !== undefined && String(opts.quantityAvailable).trim() !== '') {
    const qty = Math.max(0, Math.floor(Number(opts.quantityAvailable)));
    if (!Number.isFinite(qty)) throw new Error('Quantity must be a whole number');
    section.quantityAvailable = qty;
  }
  hitSub.subs.push(section);
  saveCatalog(cat);
  return section;
}

function appendProductToLeaf(store, catId, subId, subsubId, productId) {
  const cat = store.find((c) => c.id === catId);
  if (!cat) throw new Error('Category not found');
  const sub = (cat.subs || []).find((s) => s.id === subId);
  if (!sub) throw new Error('Store branch not found');
  const ss = (sub.subs || []).find((x) => x.id === subsubId);
  if (!ss) throw new Error('Section not found');
  if (!Array.isArray(ss.productIds)) ss.productIds = [];
  if (!ss.productIds.includes(productId)) ss.productIds.push(productId);
}

/**
 * Add a new product and attach it to a store leaf (path: catId:midId:leafId in catalog.json).
 * @param {{ name: string, description: string, price: number|string, leaf: string }} opts leaf = "catId:subId:subsubId"
 */
function addProduct(opts) {
  const { name, description, price, leaf, fileId, filePath, deliveryFolder, deliveryZipPath } = opts;
  const parts = String(leaf || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 3) throw new Error('Leaf path must be category:mid:leaf (three ids)');

  const cat = loadCatalog();
  const id = nextProductId(cat.products);
  const product = normalizeProduct({ id, name, description, price, fileId, filePath, deliveryFolder, deliveryZipPath });
  cat.products.push(product);
  appendProductToLeaf(cat.store, parts[0], parts[1], parts[2], id);
  saveCatalog(cat);
  return product;
}

function updateProduct(productId, patch) {
  const cat = loadCatalog();
  const idx = cat.products.findIndex((p) => p.id === productId);
  if (idx === -1) throw new Error('Product not found');
  cat.products[idx] = normalizeProduct({ ...cat.products[idx], ...patch, id: productId });
  saveCatalog(cat);
  return cat.products[idx];
}

function encodeStorePath(parts) {
  if (!parts || parts.length === 0) return 'browse';
  return `st:${parts.join(':')}`;
}

function decodeStorePath(data) {
  if (data === 'browse' || data === 'browse_store') return [];
  if (String(data).startsWith('st:')) return String(data).slice(3).split(':').filter(Boolean);
  return null;
}

function resolveStore(parts) {
  const STORE = getStore();
  if (!parts.length) return { kind: 'root' };
  const cat = STORE.find((c) => c.id === parts[0]);
  if (!cat) return null;
  if (parts.length === 1) return { kind: 'cat', cat };
  const sub = (cat.subs || []).find((s) => s.id === parts[1]);
  if (!sub) return null;
  if (parts.length === 2) return { kind: 'sub', cat, sub };
  const subsubRaw = (sub.subs || []).find((x) => x.id === parts[2]);
  if (!subsubRaw) return null;
  const productIds = Array.isArray(subsubRaw.productIds) ? subsubRaw.productIds : [];
  return {
    kind: 'leaf',
    cat,
    sub,
    subsub: { ...subsubRaw, productIds },
    parentPath: [parts[0], parts[1]],
  };
}

module.exports = {
  CATALOG_PATH,
  ensureCatalogFile,
  loadCatalog,
  getProducts,
  getStore,
  findProduct,
  saveCatalog,
  listStoreLeaves,
  addCategory,
  addGroup,
  addSection,
  addProduct,
  updateProduct,
  invalidateCatalogCache,
  encodeStorePath,
  decodeStorePath,
  resolveStore,
};
