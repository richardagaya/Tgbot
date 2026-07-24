const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const Busboy = require('busboy');
const catalog = require('./catalog');
const auth = require('./admin-auth');
const { renderAdminDashboard } = require('./admin-dashboard');
const { renderSellerDashboard } = require('./seller-dashboard');
const { DATA_DIR, runtimeDir, projectRelativeOrAbsolute, resolveProjectPath, PROJECT_DIR } = require('./runtime-paths');
const firebaseRepo = require('./firebase-repo');
const firebaseStorage = require('./firebase-storage');

const ADMIN_PATH = '/admin/catalog';
const LOGO_PATH = '/admin/logo';
const UPLOADS_DIR = runtimeDir('uploads');
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 200);
const MAX_UPLOAD_FILE_MB = Number(process.env.MAX_UPLOAD_FILE_MB || 30);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function redirectToAdmin(res, headers = {}) {
  res.writeHead(303, { Location: ADMIN_PATH, ...headers });
  res.end();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanFilename(name) {
  const base = path.basename(String(name || 'file').replace(/\0/g, ''));
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}

function relativeProjectPath(absPath) {
  return projectRelativeOrAbsolute(absPath);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readMultipart(req, limitMb = MAX_UPLOAD_FILE_MB) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const writes = [];
    const tmpDir = path.join(os.tmpdir(), `catalog-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    ensureDir(tmpDir);

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: MAX_UPLOAD_FILES, fileSize: limitMb * 1024 * 1024, fields: 80 },
    });

    busboy.on('field', (name, val) => {
      fields[name] = val;
    });

    busboy.on('file', (fieldname, file, info) => {
      const originalName = cleanFilename(info.filename);
      if (!originalName) {
        file.resume();
        return;
      }
      const tempPath = path.join(tmpDir, `${Date.now()}-${files.length}-${originalName}`);
      const out = fs.createWriteStream(tempPath);
      let size = 0;
      writes.push(
        new Promise((resolveWrite, rejectWrite) => {
          out.on('close', () => {
            if (size > 0) files.push({ fieldname, originalName, tempPath, size });
            else {
              try {
                fs.unlinkSync(tempPath);
              } catch (_) {}
            }
            resolveWrite();
          });
          out.on('error', rejectWrite);
        })
      );
      file.on('data', (chunk) => {
        size += chunk.length;
      });
      file.pipe(out);
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      Promise.all(writes)
        .then(() => resolve({ fields, files }))
        .catch(reject);
    });
    req.pipe(busboy);
  });
}

// Streams files directly to GCS (no temp disk). Returns files with objectName instead of tempPath.
function readMultipartGCS(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const uploads = [];

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: MAX_UPLOAD_FILES, fileSize: MAX_UPLOAD_FILE_MB * 1024 * 1024, fields: 80 },
    });

    busboy.on('field', (name, val) => {
      fields[name] = val;
    });

    busboy.on('file', (fieldname, stream, info) => {
      const originalName = cleanFilename(info.filename);
      if (!originalName) {
        stream.resume();
        return;
      }

      // Determine object path from fields accumulated so far.
      const knownProductId = fields.productId;
      const uploadKind = fields.action === 'add_inventory_files' ? 'inventory' : 'delivery';
      const prefix = knownProductId
        ? firebaseStorage.storageObjectName('products', knownProductId, uploadKind)
        : firebaseStorage.storageObjectName('uploads', 'pending', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const objectName = firebaseStorage.storageObjectName(prefix, `${Date.now()}-${files.length}-${originalName}`);

      let sizeBytes = 0;
      const sizeTracker = new Transform({
        transform(chunk, _enc, cb) {
          sizeBytes += chunk.length;
          this.push(chunk);
          cb();
        },
      });

      const p = firebaseStorage
        .uploadStream(stream.pipe(sizeTracker), objectName)
        .then(() => {
          files.push({ fieldname, originalName, objectName, sizeBytes, tempPath: null, size: sizeBytes });
        })
        .catch((e) => {
          stream.resume();
          return Promise.reject(e);
        });

      uploads.push(p);
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      Promise.all(uploads)
        .then(() => resolve({ fields, files }))
        .catch(reject);
    });
    req.pipe(busboy);
  });
}

function cleanupFiles(files) {
  for (const f of files || []) {
    if (!f.tempPath) continue;
    try {
      if (fs.existsSync(f.tempPath)) fs.unlinkSync(f.tempPath);
    } catch (_) {}
  }
}

function inventoryCount(product) {
  if (product.inventoryStoragePrefix) {
    const db = firebaseRepo.getDb();
    return (db.inventoryItems || []).filter(
      (item) => item.productId === product.id && item.status !== 'sold' && item.storagePath
    ).length;
  }
  const folder = resolveProjectPath(product.inventoryFolder);
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return 0;
  return fs
    .readdirSync(folder)
    .filter((name) => !name.startsWith('.') && name !== '_sold')
    .map((name) => path.join(folder, name))
    .filter((fp) => fs.statSync(fp).isFile() && fp.toLowerCase().endsWith('.zip')).length;
}

function productDeliveryLabel(product) {
  if (product.deliveryStoragePath || product.deliveryZipPath) return 'Reusable ZIP';
  if (product.inventoryStoragePrefix || product.inventoryFolder) return `${inventoryCount(product)} stock file(s)`;
  return 'No file';
}

async function moveDeliveryZipFile(product, files, { replace = false } = {}) {
  if (!files || files.length !== 1) throw new Error('Upload exactly one ZIP for reusable or single-sale files');
  const [file] = files;
  if (!String(file.originalName || '').toLowerCase().endsWith('.zip')) {
    throw new Error('Only .zip files can be uploaded');
  }
  if (file.objectName) {
    // File was already streamed to GCS via readMultipartGCS — no further upload needed.
    const prefix = firebaseStorage.storageObjectName('products', product.id, 'delivery');
    if (replace) await firebaseStorage.deletePrefix(`${prefix}/`);
    return {
      patch: {
        deliveryStoragePath: file.objectName,
        deliveryFileSizeBytes: file.sizeBytes || null,
        deliveryZipPath: null,
        filePath: null,
        deliveryFolder: null,
        inventoryFolder: null,
        inventoryStoragePrefix: null,
      },
    };
  }
  if (firebaseStorage.storageEnabled()) {
    const prefix = firebaseStorage.storageObjectName('products', product.id, 'delivery');
    if (replace) await firebaseStorage.deletePrefix(`${prefix}/`);
    const objectName = firebaseStorage.storageObjectName(prefix, `${Date.now()}-${file.originalName}`);
    await firebaseStorage.uploadLocalFile(file.tempPath, objectName);
    try {
      fs.unlinkSync(file.tempPath);
    } catch (_) {}
    return {
      patch: {
        deliveryStoragePath: objectName,
        deliveryFileSizeBytes: file.size || null,
        deliveryZipPath: null,
        filePath: null,
        deliveryFolder: null,
        inventoryFolder: null,
        inventoryStoragePrefix: null,
      },
    };
  }
  const destDir = path.join(UPLOADS_DIR, product.id, 'delivery');
  if (replace && fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  ensureDir(destDir);
  const dest = path.join(destDir, file.originalName);
  fs.renameSync(file.tempPath, dest);
  return {
    patch: {
      deliveryZipPath: relativeProjectPath(dest),
      deliveryStoragePath: null,
      filePath: null,
      deliveryFolder: null,
      inventoryFolder: null,
      inventoryStoragePrefix: null,
    },
  };
}

async function moveInventoryFiles(product, files, { replace = false } = {}) {
  if (!files || files.length === 0) return { patch: {}, count: 0 };
  for (const f of files) {
    if (!String(f.originalName || '').toLowerCase().endsWith('.zip')) {
      throw new Error('Only .zip files can be uploaded');
    }
  }
  if (files[0].objectName) {
    // Files already streamed to GCS via readMultipartGCS — register them without re-uploading.
    const db = firebaseRepo.getDb();
    if (!Array.isArray(db.inventoryItems)) db.inventoryItems = [];
    const prefix = firebaseStorage.storageObjectName('products', product.id, 'inventory');
    if (replace) {
      db.inventoryItems = db.inventoryItems.filter((item) => item.productId !== product.id || item.status === 'sold');
    }
    for (const f of files) {
      db.inventoryItems.push({
        id: `${product.id}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        productId: product.id,
        filename: f.originalName,
        storagePath: f.objectName,
        sizeBytes: f.sizeBytes || 0,
        status: 'available',
        createdAt: new Date().toISOString(),
      });
    }
    firebaseRepo.saveDb(db);
    const count = db.inventoryItems.filter((item) => item.productId === product.id && item.status !== 'sold').length;
    return {
      patch: {
        inventoryStoragePrefix: prefix,
        inventoryFolder: null,
        filePath: null,
        deliveryFolder: null,
        deliveryZipPath: null,
        deliveryStoragePath: null,
      },
      count,
    };
  }
  if (firebaseStorage.storageEnabled()) {
    const db = firebaseRepo.getDb();
    if (!Array.isArray(db.inventoryItems)) db.inventoryItems = [];
    const prefix = firebaseStorage.storageObjectName('products', product.id, 'inventory');
    if (replace) {
      await firebaseStorage.deletePrefix(`${prefix}/`);
      db.inventoryItems = db.inventoryItems.filter((item) => item.productId !== product.id || item.status === 'sold');
    }
    for (const f of files) {
      const objectName = firebaseStorage.storageObjectName(prefix, `${Date.now()}-${Math.random().toString(16).slice(2)}-${f.originalName}`);
      await firebaseStorage.uploadLocalFile(f.tempPath, objectName);
      db.inventoryItems.push({
        id: `${product.id}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        productId: product.id,
        filename: f.originalName,
        storagePath: objectName,
        status: 'available',
        createdAt: new Date().toISOString(),
      });
      try {
        fs.unlinkSync(f.tempPath);
      } catch (_) {}
    }
    firebaseRepo.saveDb(db);
    const count = db.inventoryItems.filter((item) => item.productId === product.id && item.status !== 'sold').length;
    return {
      patch: {
        inventoryStoragePrefix: prefix,
        inventoryFolder: null,
        filePath: null,
        deliveryFolder: null,
        deliveryZipPath: null,
        deliveryStoragePath: null,
      },
      count,
    };
  }
  const destDir = path.join(UPLOADS_DIR, product.id, 'inventory');
  if (replace && fs.existsSync(destDir)) {
    for (const name of fs.readdirSync(destDir)) {
      if (name === '_sold') continue;
      fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
    }
  }
  ensureDir(destDir);

  for (const f of files) {
    let dest = path.join(destDir, f.originalName);
    if (fs.existsSync(dest)) dest = path.join(destDir, `${Date.now()}-${f.originalName}`);
    fs.renameSync(f.tempPath, dest);
  }

  return {
    patch: {
      inventoryFolder: relativeProjectPath(destDir),
      inventoryStoragePrefix: null,
      filePath: null,
      deliveryFolder: null,
      deliveryZipPath: null,
      deliveryStoragePath: null,
    },
    count: inventoryCount({ inventoryFolder: relativeProjectPath(destDir) }),
  };
}

function productLocationPaths(productId) {
  const paths = [];
  for (const node of catalog.listStoreNodes()) {
    const hit = catalog.resolveStoreNode(node.path);
    if (hit?.node && (hit.node.productIds || []).includes(productId)) paths.push(node.path);
  }
  return paths;
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function renderErrorCard(title, err) {
  return `<section class="card"><h2>${esc(title)}</h2><p class="err">${esc(err?.message || err || 'Unknown error')}</p></section>`;
}

function categoryEditOptions() {
  try {
    const nodes = catalog.listStoreNodes();
    if (!nodes.length) return '<option value="">No categories yet</option>';
    return nodes.map((n) => `<option value="${esc(n.path)}">${esc(n.label)}</option>`).join('\n');
  } catch (e) {
    return `<option value="">Could not load categories: ${esc(e.message)}</option>`;
  }
}

function productSortValue(product) {
  const m = /^p(\d+)$/i.exec(product.id || '');
  return m ? Number(m[1]) : 0;
}

function renderRecentProducts(session, limit = 25) {
  try {
  const visibleProducts = catalog
    .getProducts()
    .filter((p) => session.role === 'admin' || p.sellerUsername === session.username);
  const products = [...visibleProducts]
    .sort((a, b) => productSortValue(b) - productSortValue(a))
    .slice(0, limit);
  if (!products.length) return '<p class="muted">No files have been added yet.</p>';

  return `<table><thead><tr><th>File</th><th>Category</th><th>Price</th><th>Type</th><th>Delivery</th><th>Description</th><th>Update delivery</th><th>Delete</th></tr></thead><tbody>${products
    .map((p) => {
      const locations = productLocationPaths(p.id)
        .map((pathKey) => {
          const node = catalog.listStoreNodes().find((n) => n.path === pathKey);
          return node ? node.label : pathKey;
        })
        .join('<br>') || '<span class="muted">Not shown in shop</span>';
      const updateForm =
        p.purchaseType === 'limited'
          ? `<form class="inline-form" method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
              <input type="hidden" name="action" value="add_inventory_files" />
              <input type="hidden" name="productId" value="${esc(p.id)}" />
              <input name="files" type="file" accept=".zip,application/zip" multiple required />
              <p class="hint">Add stock in batches. Current server limit: ${esc(MAX_UPLOAD_FILES)} files per upload.</p>
              <button type="submit" class="small-btn">Add stock ZIPs</button>
            </form>`
          : `<form class="inline-form" method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
              <input type="hidden" name="action" value="upload_product_file" />
              <input type="hidden" name="productId" value="${esc(p.id)}" />
              <input name="files" type="file" accept=".zip,application/zip" required />
              <button type="submit" class="small-btn">Replace ZIP</button>
            </form>`;
      const deleteForm = `<form class="inline-form" method="post" action="${ADMIN_PATH}" onsubmit="return confirm('Delete ${esc(p.name)}? This cannot be undone.')">
        <input type="hidden" name="action" value="delete_product" />
        <input type="hidden" name="productId" value="${esc(p.id)}" />
        <button type="submit" class="small-btn danger">Delete</button>
      </form>`;
      return `<tr><td><code>${esc(p.id)}</code><br>${esc(p.name)}<br><span class="muted">seller: ${esc(
        p.sellerUsername || 'admin'
      )}</span></td><td>${locations}</td><td>$${Number(
        p.price
      ).toFixed(2)}</td><td>${esc(p.purchaseType || 'reusable')}</td><td>${esc(productDeliveryLabel(p))}</td><td>${esc(
        p.description || ''
      )}</td><td>${updateForm}</td><td>${deleteForm}</td></tr>`;
    })
    .join('\n')}</tbody></table>`;
  } catch (e) {
    return renderErrorCard('Recently Added', e);
  }
}

function renderAddCategoryCard() {
  return `<section class="card">
    <h2>Add Category</h2>
    <form method="post" action="${ADMIN_PATH}">
      <input type="hidden" name="action" value="add_category" />
      <input type="hidden" name="parentPath" id="categoryParentPath" />
      <label>Put New Category Inside</label>
      <select id="categoryParentCat"></select>
      <div id="categoryParentSubWrap">
        <label>Sub Category</label>
        <select id="categoryParentSub"></select>
      </div>
      <div id="categoryParentSubSubWrap">
        <label>Sub Sub Category</label>
        <select id="categoryParentSubSub"></select>
      </div>
      <p class="hint" id="categoryParentHint"></p>
      <label>New Category Name</label>
      <input name="name" required maxlength="120" placeholder="Example: Utility bills" />
      <button type="submit">Create Category</button>
    </form>
  </section>`;
}

function loginHtml({ err } = {}) {
  const banner = err ? `<p class="err">${esc(err)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>STIX Market — Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a0a;
      color: #f0f0f0;
      padding: 1rem;
    }
    .login-wrap {
      width: 100%;
      max-width: 22rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
    }
    .logo {
      width: 220px;
      height: 220px;
      object-fit: contain;
      border-radius: 20px;
    }
    .card {
      width: 100%;
      background: #141414;
      border: 1px solid #2a2a2a;
      border-radius: 20px;
      padding: 1.75rem 1.5rem;
      box-shadow: 0 0 40px rgba(0,255,65,0.08);
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 800;
      color: #39ff14;
      margin-bottom: 0.25rem;
      letter-spacing: 0.04em;
    }
    .card-sub {
      font-size: 0.85rem;
      color: #667085;
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      margin-top: 1rem;
      font-size: 0.82rem;
      font-weight: 700;
      color: #a0a0a0;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      margin-top: 0.35rem;
      padding: 0.75rem 1rem;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      font: inherit;
      background: #0d0d0d;
      color: #f0f0f0;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #39ff14; }
    button {
      width: 100%;
      margin-top: 1.5rem;
      padding: 0.85rem 1rem;
      border: 0;
      border-radius: 999px;
      background: linear-gradient(135deg, #39ff14 0%, #00c853 100%);
      color: #0a0a0a;
      font: inherit;
      font-weight: 900;
      font-size: 1rem;
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: opacity 0.2s, transform 0.1s;
    }
    button:hover { opacity: 0.9; }
    button:active { transform: scale(0.98); }
    .err {
      margin-top: 1rem;
      background: rgba(180,35,24,0.15);
      border: 1px solid #b42318;
      color: #fca5a5;
      padding: 0.75rem 1rem;
      border-radius: 12px;
      font-size: 0.88rem;
    }
  </style>
</head>
<body>
  <div class="login-wrap">
    <img src="${LOGO_PATH}" alt="STIX Market" class="logo" />
    <div class="card">
      <p class="card-title">STIX Market</p>
      <p class="card-sub">Sign in to manage your store</p>
      ${banner}
      <form method="post" action="${ADMIN_PATH}">
        <input type="hidden" name="action" value="login" />
        <label>Username</label>
        <input name="username" required autocomplete="username" placeholder="Enter username" />
        <label>Password</label>
        <input name="password" type="password" required autocomplete="current-password" placeholder="Enter password" />
        <button type="submit">Sign In</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function pageHtml(session, { ok, err, activeTab } = {}) {
  let catalogError = null;
  let store = [];
  try {
    store = catalog.getStore();
  } catch (e) {
    catalogError = e;
  }
  const banner = ok
    ? `<p class="ok">${esc(ok)}</p>`
    : err
      ? `<p class="err">${esc(err)}</p>`
      : catalogError
        ? `<p class="err">Catalog could not be loaded: ${esc(catalogError.message)}</p>`
        : '';
  const storeJson = jsonForScript(store);
  const isAdmin = session.role === 'admin';
  const allowedTabs = isAdmin ? ['dashboard', 'add-file', 'categories', 'recent'] : ['dashboard', 'add-file', 'recent'];
  const tab = allowedTabs.includes(activeTab) ? activeTab : 'dashboard';
  let dashboard;
  try {
    dashboard = isAdmin ? renderAdminDashboard() : renderSellerDashboard(session, renderAddCategoryCard());
  } catch (e) {
    dashboard = renderErrorCard('Dashboard', e);
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shop Admin</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 70rem; margin: 2rem auto; padding: 0 1rem 3rem; background: #f6f7f9; color: #151515; }
    h1 { margin: 0 0 0.25rem; font-size: 1.8rem; }
    h2 { margin: 0 0 0.8rem; font-size: 1.05rem; }
    label { display: block; margin-top: 0.75rem; font-weight: 700; font-size: 0.88rem; }
    input, select, textarea { width: 100%; box-sizing: border-box; margin-top: 0.3rem; padding: 0.7rem; border: 1px solid #d1d5db; border-radius: 12px; font: inherit; background: white; }
    textarea { min-height: 5rem; resize: vertical; }
    button { margin-top: 1rem; padding: 0.72rem 1.1rem; border: 0; border-radius: 999px; background: #111827; color: white; font: inherit; font-weight: 800; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; vertical-align: top; padding: 0.65rem 0.35rem; border-bottom: 1px solid #e5e7eb; }
    code { font-size: 0.85em; }
    ul { padding-left: 1.25rem; }
    li { margin: 0.55rem 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1rem; margin-top: 1rem; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 1rem; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    .full { grid-column: 1 / -1; }
    .tabs { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem 0; }
    .tab-btn { margin: 0; border: 1px solid #d1d5db; background: white; color: #111827; }
    .tab-btn.active { background: #111827; color: white; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; margin: 0.75rem 0; }
    .metric { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 14px; padding: 0.85rem; }
    .metric strong { display: block; font-size: 1.35rem; }
    .metric span { color: #667085; font-size: 0.85rem; }
    .inline-form { margin: 0; }
    .seller-form { max-width: 26rem; }
    .small-btn { margin: 0; padding: 0.45rem 0.7rem; font-size: 0.82rem; }
    .err-inline { color: #b42318; font-size: 0.85rem; font-weight: 700; }
    .muted { color: #667085; font-size: 0.9rem; }
    .hint { color: #667085; font-size: 0.82rem; margin-top: 0.35rem; }
    .ok { background: #ecfdf3; border: 1px solid #abefc6; padding: 0.85rem 1rem; border-radius: 12px; }
    .err { background: #fef3f2; border: 1px solid #fecdca; padding: 0.85rem 1rem; border-radius: 12px; }
    .warn { background: #fffaeb; border: 1px solid #fedf89; padding: 0.85rem 1rem; border-radius: 12px; }
    .pill { display: inline-block; margin: 0.3rem 0.25rem 0 0; padding: 0.18rem 0.5rem; border-radius: 999px; background: #eef2ff; color: #312e81; font-size: 0.82rem; }
    .danger { background: #b42318; }
  </style>
</head>
<body>
  <h1>Shop Admin</h1>
  <p class="muted">Signed in as <strong>${esc(session.username)}</strong> (${esc(session.role)}). Add files, choose exactly where they appear in the shop, and manage categories from one simple page.</p>
  <form method="post" action="${ADMIN_PATH}" style="margin:0 0 1rem">
    <input type="hidden" name="action" value="logout" />
    <button type="submit" class="tab-btn">Log Out</button>
  </form>
  ${banner}

  <div class="tabs">
    <button type="button" class="tab-btn ${tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">Dashboard</button>
    <button type="button" class="tab-btn ${tab === 'add-file' ? 'active' : ''}" data-tab="add-file">Add File</button>
    ${isAdmin ? `<button type="button" class="tab-btn ${tab === 'categories' ? 'active' : ''}" data-tab="categories">Categories</button>` : ''}
    <button type="button" class="tab-btn ${tab === 'recent' ? 'active' : ''}" data-tab="recent">Recently Added</button>
  </div>

  ${dashboard.replace('tab-panel active', `tab-panel ${tab === 'dashboard' ? 'active' : ''}`)}

  <section class="card tab-panel ${tab === 'add-file' ? 'active' : ''}" id="tab-add-file">
    <h2>Add File</h2>
    <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data" id="addProductForm">
      <input type="hidden" name="action" value="add_product" />
      <input type="hidden" name="leaf" id="productLeaf" />
      <input type="hidden" name="uploadedObjectNames" id="uploadedObjectNames" />
      <label>Category</label>
      <select id="productCat" required></select>
      <div id="productSubWrap">
        <label>Sub Category</label>
        <select id="productSub"></select>
      </div>
      <div id="productSubSubWrap">
        <label>Sub Sub Category</label>
        <select id="productSubSub"></select>
      </div>
      <p class="hint" id="productPathHint"></p>
      <label>File Name</label>
      <input name="name" required maxlength="200" placeholder="Example: January pack" />
      <label>Description users see before purchase</label>
      <textarea name="description" maxlength="2000" placeholder="Explain what this file contains"></textarea>
      <label>Price Per File (USD)</label>
      <input name="price" type="number" min="0" step="0.01" required placeholder="9.99" />
      <label>Purchase Type</label>
      <select name="purchaseType">
        <option value="reusable">Reusable - every user can buy the same file</option>
        <option value="single">Single sale - first buyer only</option>
        <option value="limited">Limited stock - one uploaded ZIP per sale</option>
      </select>
      <label>Upload File</label>
      <input name="files" type="file" accept=".zip,application/zip" multiple required id="fileInput" />
      <p class="hint">${firebaseStorage.storageEnabled()
        ? 'Files upload directly to cloud storage (no size limit). Large files may take longer to upload.'
        : `Files up to ${esc(String(MAX_UPLOAD_FILE_MB))} MB each. Limited stock: one ZIP per available sale. For large stock, upload the first batch here, then add more from Recently Added.`
      }</p>
      <button type="submit" id="submitBtn">Upload File</button>
      <div id="uploadProgress" style="display:none; margin-top:10px;">
        <progress value="0" max="100" id="progressBar"></progress>
        <span id="progressText">Uploading...</span>
      </div>
    </form>
  </section>

  ${
    isAdmin
      ? `<section class="tab-panel ${tab === 'categories' ? 'active' : ''}" id="tab-categories">
    <div class="two">
      ${renderAddCategoryCard()}

      <section class="card">
        <h2>Modify Category</h2>
        <form method="post" action="${ADMIN_PATH}">
          <input type="hidden" name="action" value="update_category" />
          <label>Current Category</label>
          <select name="path" id="editCategoryPath" required>${categoryEditOptions()}</select>
          <label>Category Name</label>
          <input name="name" id="editCategoryName" required maxlength="120" />
          <label>Description</label>
          <textarea name="description" id="editCategoryDescription" maxlength="1500"></textarea>
          <button type="submit">Save Category</button>
        </form>
      </section>

      <section class="card">
        <h2>Delete Category</h2>
        <form method="post" action="${ADMIN_PATH}" id="deleteCategoryForm">
          <input type="hidden" name="action" value="delete_category" />
          <input type="hidden" name="path" id="deleteCategoryPath" />
          <label>Category</label>
          <select id="deleteCategoryCat" required></select>
          <div id="deleteCategorySubWrap">
            <label>Sub Category</label>
            <select id="deleteCategorySub"></select>
          </div>
          <div id="deleteCategorySubSubWrap">
            <label>Sub Sub Category</label>
            <select id="deleteCategorySubSub"></select>
          </div>
          <p class="hint" id="deleteCategoryHint"></p>
          <button type="submit" class="danger">Delete Category</button>
        </form>
      </section>
    </div>
  </section>`
      : ''
  }

  <section class="card tab-panel ${tab === 'recent' ? 'active' : ''}" id="tab-recent">
    <h2>Recently Added</h2>
    ${renderRecentProducts(session)}
  </section>

  <script>
    const STORE = ${storeJson};

    function childrenFor(path) {
      let children = STORE;
      for (const part of path) {
        const node = (children || []).find((item) => item.id === part);
        if (!node) return [];
        children = node.subs || [];
      }
      return children || [];
    }

    function nodeFor(path) {
      let children = STORE;
      let node = null;
      for (const part of path) {
        node = (children || []).find((item) => item.id === part);
        if (!node) return null;
        children = node.subs || [];
      }
      return node;
    }

    function setOptions(select, items, placeholder) {
      select.innerHTML = '';
      if (placeholder !== null) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = placeholder;
        select.appendChild(option);
      }
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        select.appendChild(option);
      }
    }

    function selectedPath(ids) {
      return ids.map((id) => document.getElementById(id).value).filter(Boolean);
    }

    function labelFor(path) {
      const labels = [];
      let children = STORE;
      for (const part of path) {
        const node = (children || []).find((item) => item.id === part);
        if (!node) break;
        labels.push(node.name);
        children = node.subs || [];
      }
      return labels.join(' > ');
    }

    function setupProductCascade() {
      const cat = document.getElementById('productCat');
      const sub = document.getElementById('productSub');
      const subSub = document.getElementById('productSubSub');
      const subWrap = document.getElementById('productSubWrap');
      const subSubWrap = document.getElementById('productSubSubWrap');
      const hidden = document.getElementById('productLeaf');
      const hint = document.getElementById('productPathHint');

      function refresh() {
        const catPath = selectedPath(['productCat']);
        const subItems = catPath.length ? childrenFor(catPath) : [];
        subWrap.style.display = subItems.length ? '' : 'none';
        if (!subItems.some((item) => item.id === sub.value)) setOptions(sub, subItems, 'Choose sub category');

        const subPath = selectedPath(['productCat', 'productSub']);
        const subSubItems = subPath.length >= 2 ? childrenFor(subPath) : [];
        subSubWrap.style.display = subSubItems.length ? '' : 'none';
        if (!subSubItems.some((item) => item.id === subSub.value)) setOptions(subSub, subSubItems, 'Choose sub sub category');

        const path = selectedPath(['productCat', 'productSub', 'productSubSub']);
        hidden.value = path.join(':');
        const hasMore = path.length ? childrenFor(path).length > 0 : false;
        hint.textContent = path.length
          ? (hasMore ? 'Choose the next category level before uploading.' : 'File will appear under: ' + labelFor(path))
          : 'Choose a category before uploading.';
      }

      setOptions(cat, STORE, 'Choose category');
      cat.addEventListener('change', () => {
        setOptions(sub, [], 'Choose sub category');
        setOptions(subSub, [], 'Choose sub sub category');
        refresh();
      });
      sub.addEventListener('change', () => {
        setOptions(subSub, [], 'Choose sub sub category');
        refresh();
      });
      subSub.addEventListener('change', refresh);
      refresh();
    }

    function setupCategoryParentCascade() {
      const cat = document.getElementById('categoryParentCat');
      const sub = document.getElementById('categoryParentSub');
      const subSub = document.getElementById('categoryParentSubSub');
      const subWrap = document.getElementById('categoryParentSubWrap');
      const subSubWrap = document.getElementById('categoryParentSubSubWrap');
      const hidden = document.getElementById('categoryParentPath');
      const hint = document.getElementById('categoryParentHint');
      if (!cat || !sub || !subSub || !hidden || !hint) return;

      function refresh() {
        const catPath = selectedPath(['categoryParentCat']);
        const subItems = catPath.length ? childrenFor(catPath) : [];
        subWrap.style.display = subItems.length ? '' : 'none';
        if (!subItems.some((item) => item.id === sub.value)) setOptions(sub, subItems, 'Choose sub category');

        const subPath = selectedPath(['categoryParentCat', 'categoryParentSub']);
        const subSubItems = subPath.length >= 2 ? childrenFor(subPath) : [];
        subSubWrap.style.display = subSubItems.length ? '' : 'none';
        if (!subSubItems.some((item) => item.id === subSub.value)) setOptions(subSub, subSubItems, 'Choose sub sub category');

        const path = selectedPath(['categoryParentCat', 'categoryParentSub', 'categoryParentSubSub']);
        hidden.value = path.join(':');
        hint.textContent = path.length ? 'New category will be created inside: ' + labelFor(path) : 'New category will be created at the top level.';
      }

      setOptions(cat, STORE, 'Top level category');
      cat.addEventListener('change', () => {
        setOptions(sub, [], 'Choose sub category');
        setOptions(subSub, [], 'Choose sub sub category');
        refresh();
      });
      sub.addEventListener('change', () => {
        setOptions(subSub, [], 'Choose sub sub category');
        refresh();
      });
      subSub.addEventListener('change', refresh);
      refresh();
    }

    function setupCategoryEdit() {
      const select = document.getElementById('editCategoryPath');
      const name = document.getElementById('editCategoryName');
      const description = document.getElementById('editCategoryDescription');
      if (!select || !select.value) return;
      function refresh() {
        const path = (select.value || '').split(':').filter(Boolean);
        const node = nodeFor(path);
        name.value = node ? node.name || '' : '';
        description.value = node ? node.description || '' : '';
      }
      select.addEventListener('change', refresh);
      refresh();
    }

    function setupCategoryDeleteCascade() {
      const cat = document.getElementById('deleteCategoryCat');
      const sub = document.getElementById('deleteCategorySub');
      const subSub = document.getElementById('deleteCategorySubSub');
      const subWrap = document.getElementById('deleteCategorySubWrap');
      const subSubWrap = document.getElementById('deleteCategorySubSubWrap');
      const hidden = document.getElementById('deleteCategoryPath');
      const hint = document.getElementById('deleteCategoryHint');
      const deleteForm = document.getElementById('deleteCategoryForm');
      if (!cat || !sub || !subSub || !hidden || !hint || !deleteForm) return;

      function refresh() {
        const catPath = selectedPath(['deleteCategoryCat']);
        const subItems = catPath.length ? childrenFor(catPath) : [];
        subWrap.style.display = subItems.length ? '' : 'none';
        if (!subItems.some((item) => item.id === sub.value)) setOptions(sub, subItems, 'Delete whole category');

        const subPath = selectedPath(['deleteCategoryCat', 'deleteCategorySub']);
        const subSubItems = subPath.length >= 2 ? childrenFor(subPath) : [];
        subSubWrap.style.display = subSubItems.length ? '' : 'none';
        if (!subSubItems.some((item) => item.id === subSub.value)) setOptions(subSub, subSubItems, 'Delete whole sub category');

        const path = selectedPath(['deleteCategoryCat', 'deleteCategorySub', 'deleteCategorySubSub']);
        hidden.value = path.join(':');
        hint.textContent = path.length
          ? 'This deletes "' + labelFor(path) + '" and everything inside it from the shop.'
          : 'Choose the category, sub category, or sub sub category to delete.';
      }

      setOptions(cat, STORE, 'Choose category');
      cat.addEventListener('change', () => {
        setOptions(sub, [], 'Delete whole category');
        setOptions(subSub, [], 'Delete whole sub category');
        refresh();
      });
      sub.addEventListener('change', () => {
        setOptions(subSub, [], 'Delete whole sub category');
        refresh();
      });
      subSub.addEventListener('change', refresh);
      deleteForm.addEventListener('submit', (event) => {
        const label = labelFor((hidden.value || '').split(':').filter(Boolean));
        if (!window.confirm('Delete "' + label + '" and all sub categories inside it?')) event.preventDefault();
      });
      refresh();
    }

    document.querySelectorAll('.tab-btn').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
        button.classList.add('active');
        document.getElementById('tab-' + button.dataset.tab).classList.add('active');
      });
    });

    setupProductCascade();
    setupCategoryParentCascade();
    setupCategoryEdit();
    setupCategoryDeleteCascade();

    // Upload progress overlay for large files
    (function () {
      var THRESHOLD = 10 * 1024 * 1024; // show progress for uploads > 10 MB
      var FIREBASE_ENABLED = ${firebaseStorage.storageEnabled()};
      function fmtBytes(b) {
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
      }
      function interceptForm(form) {
        form.addEventListener('submit', function (e) {
          var inputs = form.querySelectorAll('input[type=file]');
          var total = 0;
          for (var fi = 0; fi < inputs.length; fi++) {
            var fl = inputs[fi].files;
            for (var i = 0; i < fl.length; i++) total += fl[i].size;
          }
          if (total < THRESHOLD && !FIREBASE_ENABLED) return;
          e.preventDefault();
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
          overlay.innerHTML = '<div style="background:#fff;border-radius:18px;padding:2rem 2.5rem;width:90%;max-width:30rem;text-align:center">' +
            '<p style="margin:0 0 1rem;font-weight:800;font-size:1.05rem">Uploading\u2026</p>' +
            '<div style="background:#e5e7eb;border-radius:9999px;height:14px;overflow:hidden;margin:0 0 0.75rem">' +
            '<div id="_upbar" style="background:#111827;height:100%;width:0%;transition:width .2s"></div></div>' +
            '<p id="_uptxt" style="color:#667085;font-size:.88rem;margin:0">Preparing\u2026</p></div>';
          document.body.appendChild(overlay);

          if (FIREBASE_ENABLED) {
            // Direct browser-to-GCS upload using signed URLs
            var fileInput = document.getElementById('fileInput');
            var files = fileInput.files;
            var uploadedNames = [];
            var currentFile = 0;

            function uploadNextFile() {
              if (currentFile >= files.length) {
                // All files uploaded, submit form with object names
                document.getElementById('uploadedObjectNames').value = JSON.stringify(uploadedNames);
                var fd = new FormData(form);
                fd.delete('files'); // Remove file input
                var xhr = new XMLHttpRequest();
                xhr.open('POST', form.action);
                xhr.onload = function () {
                  document.body.removeChild(overlay);
                  if (xhr.status === 200) { document.open(); document.write(xhr.responseText); document.close(); }
                  else { alert('Upload failed (HTTP ' + xhr.status + '). Please try again.'); }
                };
                xhr.onerror = function () {
                  document.body.removeChild(overlay);
                  alert('Upload failed. Check your connection and try again.');
                };
                xhr.send(fd);
                return;
              }

              var file = files[currentFile];
              var objectName = 'uploads/pending/' + Date.now() + '-' + currentFile + '-' + file.name.replace(/[^\\w.\\- ()]/g, '_');
              
              document.getElementById('_uptxt').textContent = 'Requesting upload URL for ' + file.name + '...';

              fetch('/admin/catalog/upload-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ objectName: objectName, contentType: 'application/zip' })
              })
              .then(function(res) {
                return res.text().then(function(text) {
                  var data;
                  try { data = JSON.parse(text); } catch (_) { throw new Error(text || ('HTTP ' + res.status)); }
                  if (!res.ok) throw new Error(data.error || text || ('HTTP ' + res.status));
                  return data;
                });
              })
              .then(function(data) {
                if (!data.url) throw new Error('Failed to get upload URL');
                
                document.getElementById('_uptxt').textContent = 'Uploading ' + file.name + '...';
                
                var xhr = new XMLHttpRequest();
                xhr.open('PUT', data.url);
                xhr.upload.onprogress = function(ev) {
                  if (!ev.lengthComputable) return;
                  var filePct = Math.round(ev.loaded / ev.total * 100);
                  var totalPct = Math.round((currentFile + filePct / 100) / files.length * 100);
                  document.getElementById('_upbar').style.width = totalPct + '%';
                  document.getElementById('_uptxt').textContent = filePct + '%  \u2014  ' + fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total);
                };
                xhr.onload = function() {
                  if (xhr.status === 200) {
                    uploadedNames.push(objectName);
                    currentFile++;
                    uploadNextFile();
                  } else {
                    document.body.removeChild(overlay);
                    alert('Upload failed for ' + file.name + ' (HTTP ' + xhr.status + '). Please try again.');
                  }
                };
                xhr.onerror = function() {
                  document.body.removeChild(overlay);
                  alert('Upload failed for ' + file.name + '. Check your connection and try again.');
                };
                xhr.send(file);
              })
              .catch(function(err) {
                document.body.removeChild(overlay);
                alert('Error: ' + err.message);
              });
            }

            uploadNextFile();
          } else {
            // Regular upload via server
            var fd = new FormData(form);
            var xhr = new XMLHttpRequest();
            xhr.upload.onprogress = function (ev) {
              if (!ev.lengthComputable) return;
              var pct = Math.round(ev.loaded / ev.total * 100);
              document.getElementById('_upbar').style.width = pct + '%';
              document.getElementById('_uptxt').textContent = pct + '%  \u2014  ' + fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total);
            };
            xhr.onload = function () {
              document.body.removeChild(overlay);
              if (xhr.status === 200) { document.open(); document.write(xhr.responseText); document.close(); }
              else { alert('Upload failed (HTTP ' + xhr.status + '). Please try again.'); }
            };
            xhr.onerror = function () {
              document.body.removeChild(overlay);
              alert('Upload failed. Check your connection and try again.');
            };
            xhr.send(fd);
          }
        });
      }
      document.querySelectorAll('form').forEach(function (f) {
        if (f.querySelector('input[type=file]')) interceptForm(f);
      });
    }());
  </script>
</body>
</html>`;
}

async function parsePost(req) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  if (ct === 'multipart/form-data') {
    // When Firebase Storage is available, stream files directly to GCS (no temp disk, no file size cap).
    if (firebaseStorage.storageEnabled()) return readMultipartGCS(req);
    return readMultipart(req);
  }
  if (ct === 'application/x-www-form-urlencoded') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const fields = {};
    for (const [key, value] of params.entries()) fields[key] = value;
    return { fields, files: [] };
  }
  throw new Error('Unsupported form type');
}

function assertAdmin(session) {
  if (!session || session.role !== 'admin') throw new Error('Only admins can do that');
}

function canManageProduct(session, product) {
  if (!session || !product) return false;
  return session.role === 'admin' || product.sellerUsername === session.username;
}

async function handleAdminPost(req, session) {
  let parsed = { fields: {}, files: [] };
  try {
    parsed = req.parsedAdminPost || (await parsePost(req));
    const { fields, files } = parsed;

    if (fields.action === 'add_category') {
      const node = catalog.addCategory({
        parentPath: fields.parentPath,
        name: fields.name,
      });
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'add_category',
        detail: `Created category: ${node.name}`,
      });
      return pageHtml(session, {
        ok: `Created category: ${node.name}`,
        activeTab: session.role === 'admin' ? 'categories' : 'dashboard',
      });
    }

    if (fields.action === 'add_product') {
      // Handle direct GCS uploads (object names sent instead of files)
      if (fields.uploadedObjectNames) {
        try {
          const objectNames = JSON.parse(fields.uploadedObjectNames);
          files = objectNames.map((objectName, index) => ({
            fieldname: 'files',
            originalName: objectName.split('/').pop().replace(/^\d+-\d+-/, ''),
            objectName,
            tempPath: null,
            size: 0,
          }));
        } catch (e) {
          throw new Error('Invalid uploaded object names');
        }
      }
      
      if (!files.length) throw new Error('Upload at least one delivery document');
      const target = catalog.resolveStoreNode(fields.leaf);
      if (!target || !target.node) throw new Error('Choose a category for this file');
      if ((target.children || []).length) throw new Error('Choose the lowest category level before uploading the file');
      const purchaseType = ['single', 'limited'].includes(fields.purchaseType) ? fields.purchaseType : 'reusable';
      const product = catalog.addProduct({
        leaf: fields.leaf,
        name: fields.name,
        description: fields.description,
        price: fields.price,
        purchaseType,
        sellerUsername: session.username,
        createdByRole: session.role,
        createdAt: new Date().toISOString(),
      });
      const moved =
        purchaseType === 'limited'
          ? await moveInventoryFiles(product, files)
          : await moveDeliveryZipFile(product, files);
      catalog.updateProduct(product.id, moved.patch);
      catalog.updateStoreNode(fields.leaf, {
        description: fields.description,
        quantityAvailable: purchaseType === 'limited' ? moved.count : purchaseType === 'single' ? 1 : null,
      });
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'add_product',
        detail: `Uploaded ${purchaseType} ZIP file(s) for ${product.name}`,
      });
      const availability = purchaseType === 'limited' ? `${moved.count} available file(s)` : purchaseType;
      return pageHtml(session, { ok: `Created ${product.name} as ${availability}`, activeTab: 'recent' });
    }

    if (fields.action === 'update_category') {
      assertAdmin(session);
      const node = catalog.updateStoreNode(fields.path, {
        name: fields.name,
        description: fields.description,
      });
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'update_category',
        detail: `Updated category: ${node.name}`,
      });
      return pageHtml(session, { ok: `Updated category: ${node.name}`, activeTab: 'categories' });
    }

    if (fields.action === 'delete_category') {
      assertAdmin(session);
      const node = catalog.deleteStoreNode(fields.path);
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'delete_category',
        detail: `Deleted category: ${node.name}`,
      });
      return pageHtml(session, { ok: `Deleted category: ${node.name}`, activeTab: 'categories' });
    }

    if (fields.action === 'revoke_seller') {
      assertAdmin(session);
      auth.revokeSeller(fields.username, session.username);
      return pageHtml(session, { ok: `Revoked seller access: ${fields.username}`, activeTab: 'dashboard' });
    }

    if (fields.action === 'create_seller') {
      assertAdmin(session);
      const seller = auth.createSeller({
        username: fields.username,
        password: fields.password,
        actor: session.username,
      });
      return pageHtml(session, { ok: `Created seller account: ${seller.username}`, activeTab: 'dashboard' });
    }

    if (fields.action === 'upload_product_file') {
      const product = catalog.findProduct(fields.productId);
      if (!product) throw new Error('Product not found');
      if (!canManageProduct(session, product)) throw new Error('You can only update your own files');
      
      // Handle direct GCS uploads
      if (fields.uploadedObjectNames) {
        try {
          const objectNames = JSON.parse(fields.uploadedObjectNames);
          files = objectNames.map((objectName, index) => ({
            fieldname: 'files',
            originalName: objectName.split('/').pop().replace(/^\d+-\d+-/, ''),
            objectName,
            tempPath: null,
            size: 0,
          }));
        } catch (e) {
          throw new Error('Invalid uploaded object names');
        }
      }
      
      if (!files.length) throw new Error('Upload at least one delivery document');
      if (product.purchaseType === 'limited') {
        throw new Error('Use Add stock ZIPs for limited-stock products');
      }
      const moved = await moveDeliveryZipFile(product, files, { replace: true });
      catalog.updateProduct(product.id, moved.patch);
      for (const pathKey of productLocationPaths(product.id)) {
        catalog.updateStoreNode(pathKey, {
          quantityAvailable: product.purchaseType === 'limited' ? moved.count : product.purchaseType === 'single' ? 1 : null,
        });
      }
      return pageHtml(session, { ok: `Updated ${product.name}`, activeTab: 'recent' });
    }

    if (fields.action === 'add_inventory_files') {
      const product = catalog.findProduct(fields.productId);
      if (!product) throw new Error('Product not found');
      if (!canManageProduct(session, product)) throw new Error('You can only update your own files');
      if (product.purchaseType !== 'limited') throw new Error('Only limited-stock products can receive stock batches');
      
      // Handle direct GCS uploads
      if (fields.uploadedObjectNames) {
        try {
          const objectNames = JSON.parse(fields.uploadedObjectNames);
          files = objectNames.map((objectName, index) => ({
            fieldname: 'files',
            originalName: objectName.split('/').pop().replace(/^\d+-\d+-/, ''),
            objectName,
            tempPath: null,
            size: 0,
          }));
        } catch (e) {
          throw new Error('Invalid uploaded object names');
        }
      }
      
      if (!files.length) throw new Error('Upload at least one stock document');
      const moved = await moveInventoryFiles(product, files);
      catalog.updateProduct(product.id, moved.patch);
      for (const pathKey of productLocationPaths(product.id)) {
        catalog.updateStoreNode(pathKey, {
          quantityAvailable: moved.count,
        });
      }
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'add_inventory_files',
        detail: `Added ${files.length} stock ZIP(s) to ${product.name}`,
      });
      return pageHtml(session, {
        ok: `Added ${files.length} stock ZIP(s). ${moved.count} available for ${product.name}`,
        activeTab: 'recent',
      });
    }

    if (fields.action === 'delete_product') {
      const product = catalog.findProduct(fields.productId);
      if (!product) throw new Error('Product not found');
      if (!canManageProduct(session, product)) throw new Error('You can only delete your own files');
      catalog.deleteProduct(fields.productId);
      auth.recordActivity({
        actor: session.username,
        role: session.role,
        action: 'delete_product',
        detail: `Deleted product: ${product.name} (${product.id})`,
      });
      return pageHtml(session, { ok: `Deleted ${product.name}`, activeTab: 'recent' });
    }

    throw new Error('Unknown action');
  } catch (e) {
    cleanupFiles(parsed.files);
    return pageHtml(session, { err: e.message || String(e) });
  }
}

async function tryHandleCatalogAdmin(req, res) {
  const host = req.headers.host || 'localhost';
  let pathname;
  try {
    pathname = new URL(req.url || '/', `http://${host}`).pathname;
  } catch {
    return false;
  }

  const session = auth.readSession(req);

  if (pathname === LOGO_PATH && req.method === 'GET') {
    const logoFile = path.join(PROJECT_DIR, 'assets', 'Market.png');
    if (fs.existsSync(logoFile)) {
      const data = fs.readFileSync(logoFile);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } else {
      res.writeHead(404); res.end();
    }
    return true;
  }

  if (pathname === '/admin/catalog/upload-url' && req.method === 'POST') {
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    try {
      const body = await readBody(req, 10 * 1024);
      const { objectName, contentType } = JSON.parse(body);
      if (!objectName) throw new Error('objectName required');
      const url = await firebaseStorage.getSignedUploadUrl(objectName, contentType || 'application/zip');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url, objectName }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  if (pathname !== ADMIN_PATH) return false;

  if (!auth.configuredUsers().length) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<p>Catalog admin auth is off. Set <code>ADMIN_PASSWORD</code> or <code>ADMIN_CATALOG_TOKEN</code> in your environment and restart the bot.</p>'
    );
    return true;
  }

  if (req.method === 'GET') {
    if (!session) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginHtml({}));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(session, {}));
    return true;
  }

  if (req.method === 'POST') {
    const parsed = await parsePost(req);
    const action = parsed.fields.action;

    if (action === 'login') {
      const user = auth.findUser(parsed.fields.username, parsed.fields.password);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginHtml({ err: 'Invalid username or password' }));
        return true;
      }
      redirectToAdmin(res, { 'Set-Cookie': auth.authCookieHeader(auth.createSessionCookie(user)) });
      return true;
    }

    if (action === 'logout') {
      redirectToAdmin(res, { 'Set-Cookie': auth.clearAuthCookieHeader() });
      return true;
    }

    if (!session) {
      cleanupFiles(parsed.files);
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginHtml({ err: 'Please sign in again' }));
      return true;
    }

    req.parsedAdminPost = parsed;
    const html = await handleAdminPost(req, session);
    await firebaseRepo.waitForPendingWrites();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
  return true;
}

module.exports = { tryHandleCatalogAdmin, ADMIN_PATH, LOGO_PATH };
