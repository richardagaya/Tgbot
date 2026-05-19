const fs = require('fs');
const os = require('os');
const path = require('path');
const Busboy = require('busboy');
const catalog = require('./catalog');
const auth = require('./admin-auth');
const { renderAdminDashboard } = require('./admin-dashboard');
const { renderSellerDashboard } = require('./seller-dashboard');

const ADMIN_PATH = '/admin/catalog';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 200);
const MAX_UPLOAD_FILE_MB = Number(process.env.MAX_UPLOAD_FILE_MB || 200);

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
  return path.relative(__dirname, absPath).split(path.sep).join('/');
}

function resolveProjectPath(relOrAbs) {
  if (!relOrAbs) return null;
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(__dirname, relOrAbs);
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

function cleanupFiles(files) {
  for (const f of files || []) {
    try {
      if (fs.existsSync(f.tempPath)) fs.unlinkSync(f.tempPath);
    } catch (_) {}
  }
}

function inventoryCount(product) {
  const folder = resolveProjectPath(product.inventoryFolder);
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return 0;
  return fs
    .readdirSync(folder)
    .filter((name) => !name.startsWith('.') && name !== '_sold')
    .map((name) => path.join(folder, name))
    .filter((fp) => fs.statSync(fp).isFile() && fp.toLowerCase().endsWith('.zip')).length;
}

function productDeliveryLabel(product) {
  if (product.deliveryZipPath) return 'Reusable ZIP';
  if (product.inventoryFolder) return `${inventoryCount(product)} stock file(s)`;
  return 'No file';
}

function moveDeliveryZipFile(product, files, { replace = false } = {}) {
  if (!files || files.length !== 1) throw new Error('Upload exactly one ZIP for reusable or single-sale files');
  const [file] = files;
  if (!String(file.originalName || '').toLowerCase().endsWith('.zip')) {
    throw new Error('Only .zip files can be uploaded');
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
      filePath: null,
      deliveryFolder: null,
      inventoryFolder: null,
    },
  };
}

function moveInventoryFiles(product, files, { replace = false } = {}) {
  if (!files || files.length === 0) return { patch: {}, count: 0 };
  for (const f of files) {
    if (!String(f.originalName || '').toLowerCase().endsWith('.zip')) {
      throw new Error('Only .zip files can be uploaded');
    }
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
      filePath: null,
      deliveryFolder: null,
      deliveryZipPath: null,
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

  return `<table><thead><tr><th>File</th><th>Category</th><th>Price</th><th>Type</th><th>Delivery</th><th>Description</th><th>Update delivery</th></tr></thead><tbody>${products
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
      return `<tr><td><code>${esc(p.id)}</code><br>${esc(p.name)}<br><span class="muted">seller: ${esc(
        p.sellerUsername || 'admin'
      )}</span></td><td>${locations}</td><td>$${Number(
        p.price
      ).toFixed(2)}</td><td>${esc(p.purchaseType || 'reusable')}</td><td>${esc(productDeliveryLabel(p))}</td><td>${esc(
        p.description || ''
      )}</td><td>${updateForm}</td></tr>`;
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
  <title>Shop Admin Login</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 28rem; margin: 5rem auto; padding: 0 1rem; background: #f6f7f9; color: #151515; }
    h1 { margin: 0 0 0.25rem; font-size: 1.8rem; }
    label { display: block; margin-top: 0.75rem; font-weight: 700; font-size: 0.88rem; }
    input { width: 100%; box-sizing: border-box; margin-top: 0.3rem; padding: 0.7rem; border: 1px solid #d1d5db; border-radius: 12px; font: inherit; background: white; }
    button { width: 100%; margin-top: 1rem; padding: 0.72rem 1.1rem; border: 0; border-radius: 999px; background: #111827; color: white; font: inherit; font-weight: 800; cursor: pointer; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 18px; padding: 1rem; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    .muted { color: #667085; font-size: 0.9rem; }
    .err { background: #fef3f2; border: 1px solid #fecdca; padding: 0.85rem 1rem; border-radius: 12px; }
  </style>
</head>
<body>
  <section class="card">
    <h1>Shop Admin Login</h1>
    <p class="muted">Sign in as an admin or seller.</p>
    ${banner}
    <form method="post" action="${ADMIN_PATH}">
      <input type="hidden" name="action" value="login" />
      <label>Username</label>
      <input name="username" required autocomplete="username" />
      <label>Password</label>
      <input name="password" type="password" required autocomplete="current-password" />
      <button type="submit">Sign In</button>
    </form>
  </section>
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
  <p class="warn"><strong>Railway:</strong> add a persistent volume or uploads/catalog changes may disappear after redeploys.</p>
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
    <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
      <input type="hidden" name="action" value="add_product" />
      <input type="hidden" name="leaf" id="productLeaf" />
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
      <input name="files" type="file" accept=".zip,application/zip" multiple required />
      <p class="hint">Reusable and single-sale products use one ZIP. Limited stock products use one ZIP per available item. For large stock, upload the first batch here, then add more from Recently Added.</p>
      <button type="submit">Upload File</button>
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
  </script>
</body>
</html>`;
}

async function parsePost(req) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  if (ct === 'multipart/form-data') return readMultipart(req);
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
          ? moveInventoryFiles(product, files)
          : moveDeliveryZipFile(product, files);
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
      if (!files.length) throw new Error('Upload at least one delivery document');
      if (product.purchaseType === 'limited') {
        throw new Error('Use Add stock ZIPs for limited-stock products');
      }
      const moved = moveDeliveryZipFile(product, files, { replace: true });
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
      if (!files.length) throw new Error('Upload at least one stock document');
      const moved = moveInventoryFiles(product, files);
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
  if (pathname !== ADMIN_PATH) return false;

  if (!auth.configuredUsers().length) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<p>Catalog admin auth is off. Set <code>ADMIN_PASSWORD</code> or <code>ADMIN_CATALOG_TOKEN</code> in your environment and restart the bot.</p>'
    );
    return true;
  }

  const session = auth.readSession(req);

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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
  return true;
}

module.exports = { tryHandleCatalogAdmin, ADMIN_PATH };
