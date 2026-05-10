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
    /** Folder of individual stock documents; one file is delivered per quantity purchased. */
    inventoryFolder: p.inventoryFolder == null || p.inventoryFolder === '' ? null : String(p.inventoryFolder),
  };
}

function walkStore(nodes, fn, pathParts = [], labelParts = []) {
  for (const node of nodes || []) {
    const nextPath = [...pathParts, node.id];
    const nextLabels = [...labelParts, node.name];
    fn(node, nextPath, nextLabels);
    if (Array.isArray(node.subs) && node.subs.length) {
      walkStore(node.subs, fn, nextPath, nextLabels);
    }
  }
}

function eachLeaf(store, fn) {
  walkStore(store, (node, pathParts, labelParts) => {
    if (Array.isArray(node.subs) && node.subs.length) return;
    fn(node, pathParts, labelParts);
  });
}

function listStoreLeaves() {
  const out = [];
  eachLeaf(getStore(), (node, pathParts, labelParts) => {
    out.push({
      path: pathParts.join(':'),
      label: labelParts.join(' › '),
    });
  });
  return out;
}

function listStoreNodes() {
  const out = [];
  walkStore(getStore(), (node, pathParts, labelParts) => {
    out.push({
      path: pathParts.join(':'),
      label: labelParts.join(' › '),
      hasChildren: Array.isArray(node.subs) && node.subs.length > 0,
    });
  });
  return out;
}

function validateStoreReferences(products, store) {
  const ids = new Set(products.map((p) => p.id));
  walkStore(store, (node) => {
    for (const pid of node.productIds || []) {
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
  const parentPath = splitPath(opts.parentPath);
  const parent = parentPath.length ? resolveStoreNode(parentPath, cat.store)?.node : null;
  const siblings = parent ? parent.subs || [] : cat.store;
  const id = uniqueId(opts.id || name, siblings.map((c) => c.id));
  const node = { id, name, subs: [] };
  const description = String(opts.description || '').trim();
  if (description) node.description = description;
  if (parent) {
    if (!Array.isArray(parent.subs)) parent.subs = [];
    parent.subs.push(node);
  } else {
    cat.store.push(node);
  }
  saveCatalog(cat);
  return node;
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
  const { name, description, price, leaf, fileId, filePath, deliveryFolder, deliveryZipPath, inventoryFolder } = opts;
  const parts = splitPath(leaf);
  if (!parts.length) throw new Error('Choose where this product should appear');

  const cat = loadCatalog();
  const id = nextProductId(cat.products);
  const product = normalizeProduct({
    id,
    name,
    description,
    price,
    fileId,
    filePath,
    deliveryFolder,
    deliveryZipPath,
    inventoryFolder,
  });
  cat.products.push(product);
  appendProductToPath(cat.store, parts, id);
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

function splitPath(value) {
  return String(value || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveStoreNode(parts, storeOverride = null) {
  const STORE = storeOverride || getStore();
  const pathParts = Array.isArray(parts) ? parts.filter(Boolean) : splitPath(parts);
  if (!pathParts.length) return { kind: 'root', node: null, children: STORE, path: [] };

  let children = STORE;
  let node = null;
  for (const part of pathParts) {
    node = (children || []).find((c) => c.id === part);
    if (!node) return null;
    children = node.subs || [];
  }

  return {
    kind: 'node',
    node,
    children,
    path: pathParts,
    parentPath: pathParts.slice(0, -1),
    productIds: Array.isArray(node.productIds) ? node.productIds : [],
  };
}

function appendProductToPath(store, parts, productId) {
  const hit = resolveStoreNode(parts, store);
  if (!hit || !hit.node) throw new Error('Category not found');
  if (!Array.isArray(hit.node.productIds)) hit.node.productIds = [];
  if (!hit.node.productIds.includes(productId)) hit.node.productIds.push(productId);
}

function updateStoreNode(pathKey, patch) {
  const cat = loadCatalog();
  const hit = resolveStoreNode(splitPath(pathKey), cat.store);
  if (!hit || !hit.node) throw new Error('Category not found');
  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new Error('Name is required');
    hit.node.name = name;
  }
  if (patch.description !== undefined) {
    const description = String(patch.description || '').trim();
    if (description) hit.node.description = description;
    else delete hit.node.description;
  }
  if (patch.quantityAvailable !== undefined) {
    if (patch.quantityAvailable === null || String(patch.quantityAvailable).trim() === '') {
      delete hit.node.quantityAvailable;
    } else {
      const qty = Math.max(0, Math.floor(Number(patch.quantityAvailable)));
      if (!Number.isFinite(qty)) throw new Error('Quantity must be a whole number');
      hit.node.quantityAvailable = qty;
    }
  }
  saveCatalog(cat);
  return hit.node;
}

function deleteStoreNode(pathKey) {
  const cat = loadCatalog();
  const parts = splitPath(pathKey);
  if (!parts.length) throw new Error('Choose a category to delete');

  const parentHit = parts.length === 1 ? { children: cat.store } : resolveStoreNode(parts.slice(0, -1), cat.store);
  if (!parentHit || !Array.isArray(parentHit.children)) throw new Error('Parent category not found');

  const idx = parentHit.children.findIndex((node) => node.id === parts[parts.length - 1]);
  if (idx === -1) throw new Error('Category not found');

  const [removed] = parentHit.children.splice(idx, 1);
  saveCatalog(cat);
  return removed;
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
  listStoreNodes,
  addCategory,
  addGroup,
  addSection,
  addProduct,
  updateProduct,
  updateStoreNode,
  deleteStoreNode,
  invalidateCatalogCache,
  encodeStorePath,
  decodeStorePath,
  resolveStore,
  resolveStoreNode,
};
