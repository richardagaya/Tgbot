const fs = require('fs');
const os = require('os');
const path = require('path');
const Busboy = require('busboy');
const catalog = require('./catalog');

const ADMIN_PATH = '/admin/catalog';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function readMultipart(req, limitMb = 200) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const writes = [];
    const tmpDir = path.join(os.tmpdir(), `catalog-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    ensureDir(tmpDir);

    const busboy = Busboy({
      headers: req.headers,
      limits: { files: 100, fileSize: limitMb * 1024 * 1024, fields: 80 },
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
    .filter((fp) => fs.statSync(fp).isFile()).length;
}

function moveInventoryFiles(product, files, { replace = false } = {}) {
  if (!files || files.length === 0) return { patch: {}, count: 0 };
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

function categoryEditOptions() {
  const nodes = catalog.listStoreNodes();
  if (!nodes.length) return '<option value="">No categories yet</option>';
  return nodes.map((n) => `<option value="${esc(n.path)}">${esc(n.label)}</option>`).join('\n');
}

function productSortValue(product) {
  const m = /^p(\d+)$/i.exec(product.id || '');
  return m ? Number(m[1]) : 0;
}

function renderRecentProducts(limit = 10) {
  const products = [...catalog.getProducts()]
    .sort((a, b) => productSortValue(b) - productSortValue(a))
    .slice(0, limit);
  if (!products.length) return '<p class="muted">No files have been added yet.</p>';

  return `<table><thead><tr><th>File</th><th>Category</th><th>Price</th><th>Uploaded</th><th>Description</th></tr></thead><tbody>${products
    .map((p) => {
      const locations = productLocationPaths(p.id)
        .map((pathKey) => {
          const node = catalog.listStoreNodes().find((n) => n.path === pathKey);
          return node ? node.label : pathKey;
        })
        .join('<br>') || '<span class="muted">Not shown in shop</span>';
      return `<tr><td><code>${esc(p.id)}</code><br>${esc(p.name)}</td><td>${locations}</td><td>$${Number(
        p.price
      ).toFixed(2)}</td><td>${inventoryCount(p)} file(s)</td><td>${esc(p.description || '')}</td></tr>`;
    })
    .join('\n')}</tbody></table>`;
}

function renderTreeNodes(nodes, pathParts = []) {
  const productsById = new Map(catalog.getProducts().map((p) => [p.id, p]));
  return (nodes || [])
    .map((node) => {
      const pathKey = [...pathParts, node.id].join(':');
      const products = (node.productIds || [])
        .map((id) => productsById.get(id))
        .filter(Boolean)
        .map((p) => `<span class="pill">${esc(p.name)} - $${Number(p.price).toFixed(2)} - ${inventoryCount(p)} left</span>`)
        .join(' ');
      const desc = node.description ? `<div class="muted">${esc(node.description)}</div>` : '';
      const qty =
        node.quantityAvailable === undefined || node.quantityAvailable === null
          ? ''
          : `<span class="muted">stock: ${esc(node.quantityAvailable)}</span>`;
      const children = node.subs?.length ? `<ul>${renderTreeNodes(node.subs, [...pathParts, node.id])}</ul>` : '';
      return `<li><strong>${esc(node.name)}</strong> <code>${esc(pathKey)}</code> ${qty}${desc}${
        products || ''
      }${children}</li>`;
    })
    .join('\n');
}

function pageHtml(token, { ok, err, activeTab } = {}) {
  const banner = ok ? `<p class="ok">${esc(ok)}</p>` : err ? `<p class="err">${esc(err)}</p>` : '';
  const storeJson = jsonForScript(catalog.getStore());
  const tab = ['add-file', 'categories', 'recent'].includes(activeTab) ? activeTab : 'add-file';
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
    .muted { color: #667085; font-size: 0.9rem; }
    .hint { color: #667085; font-size: 0.82rem; margin-top: 0.35rem; }
    .ok { background: #ecfdf3; border: 1px solid #abefc6; padding: 0.85rem 1rem; border-radius: 12px; }
    .err { background: #fef3f2; border: 1px solid #fecdca; padding: 0.85rem 1rem; border-radius: 12px; }
    .warn { background: #fffaeb; border: 1px solid #fedf89; padding: 0.85rem 1rem; border-radius: 12px; }
    .pill { display: inline-block; margin: 0.3rem 0.25rem 0 0; padding: 0.18rem 0.5rem; border-radius: 999px; background: #eef2ff; color: #312e81; font-size: 0.82rem; }
  </style>
</head>
<body>
  <h1>Shop Admin</h1>
  <p class="muted">Add files, choose exactly where they appear in the shop, and manage categories from one simple page.</p>
  <p class="warn"><strong>Railway:</strong> add a persistent volume or uploads/catalog changes may disappear after redeploys.</p>
  ${banner}

  <div class="tabs">
    <button type="button" class="tab-btn ${tab === 'add-file' ? 'active' : ''}" data-tab="add-file">Add File</button>
    <button type="button" class="tab-btn ${tab === 'categories' ? 'active' : ''}" data-tab="categories">Categories</button>
    <button type="button" class="tab-btn ${tab === 'recent' ? 'active' : ''}" data-tab="recent">Recently Added</button>
  </div>

  <section class="card tab-panel ${tab === 'add-file' ? 'active' : ''}" id="tab-add-file">
    <h2>Add File</h2>
    <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
      <input type="hidden" name="token" value="${esc(token)}" />
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
      <label>Upload File</label>
      <input name="files" type="file" multiple required />
      <p class="hint">Quantity is automatic: each uploaded document becomes one available item.</p>
      <button type="submit">Upload File</button>
    </form>
  </section>

  <section class="tab-panel ${tab === 'categories' ? 'active' : ''}" id="tab-categories">
    <div class="two">
      <section class="card">
        <h2>Add Category</h2>
        <form method="post" action="${ADMIN_PATH}">
          <input type="hidden" name="token" value="${esc(token)}" />
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
          <label>Description</label>
          <textarea name="description" maxlength="1500" placeholder="What this category contains"></textarea>
          <button type="submit">Create Category</button>
        </form>
      </section>

      <section class="card">
        <h2>Modify Category</h2>
        <form method="post" action="${ADMIN_PATH}">
          <input type="hidden" name="token" value="${esc(token)}" />
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
    </div>

    <section class="card full" style="margin-top:1rem">
      <h2>Current Categories</h2>
      ${catalog.getStore().length ? `<ul>${renderTreeNodes(catalog.getStore())}</ul>` : '<p class="muted">No categories yet.</p>'}
    </section>
  </section>

  <section class="card tab-panel ${tab === 'recent' ? 'active' : ''}" id="tab-recent">
    <h2>Recently Added</h2>
    ${renderRecentProducts()}
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
        const node = nodeFor((select.value || '').split(':').filter(Boolean));
        name.value = node ? node.name || '' : '';
        description.value = node ? node.description || '' : '';
      }
      select.addEventListener('change', refresh);
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
  </script>
</body>
</html>`;
}

function assertToken(token, expected) {
  if (token !== expected) throw new Error('Unauthorized');
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

async function handleAdminPost(req, tokenEnv) {
  let parsed = { fields: {}, files: [] };
  try {
    parsed = await parsePost(req);
    const { fields, files } = parsed;
    assertToken(fields.token || '', tokenEnv);

    if (fields.action === 'add_category') {
      const node = catalog.addCategory({
        parentPath: fields.parentPath,
        name: fields.name,
        description: fields.description,
      });
      return pageHtml(tokenEnv, { ok: `Created category: ${node.name}`, activeTab: 'categories' });
    }

    if (fields.action === 'add_product') {
      if (!files.length) throw new Error('Upload at least one delivery document');
      const target = catalog.resolveStoreNode(fields.leaf);
      if (!target || !target.node) throw new Error('Choose a category for this file');
      if ((target.children || []).length) throw new Error('Choose the lowest category level before uploading the file');
      const product = catalog.addProduct({
        leaf: fields.leaf,
        name: fields.name,
        description: fields.description,
        price: fields.price,
      });
      const moved = moveInventoryFiles(product, files);
      catalog.updateProduct(product.id, moved.patch);
      catalog.updateStoreNode(fields.leaf, { description: fields.description, quantityAvailable: moved.count });
      return pageHtml(tokenEnv, { ok: `Created ${product.name} with ${moved.count} available file(s)`, activeTab: 'recent' });
    }

    if (fields.action === 'update_category') {
      const node = catalog.updateStoreNode(fields.path, {
        name: fields.name,
        description: fields.description,
      });
      return pageHtml(tokenEnv, { ok: `Updated category: ${node.name}`, activeTab: 'categories' });
    }

    if (fields.action === 'upload_product_file') {
      const product = catalog.findProduct(fields.productId);
      if (!product) throw new Error('Product not found');
      if (!files.length) throw new Error('Upload at least one delivery document');
      const moved = moveInventoryFiles(product, files, { replace: true });
      catalog.updateProduct(product.id, moved.patch);
      for (const pathKey of productLocationPaths(product.id)) {
        catalog.updateStoreNode(pathKey, { quantityAvailable: moved.count });
      }
      return pageHtml(tokenEnv, { ok: `Updated ${product.name}: ${moved.count} available file(s)`, activeTab: 'recent' });
    }

    throw new Error('Unknown action');
  } catch (e) {
    cleanupFiles(parsed.files);
    return pageHtml(tokenEnv, { err: e.message || String(e) });
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

  const tokenEnv = process.env.ADMIN_CATALOG_TOKEN;
  if (!tokenEnv || String(tokenEnv).trim() === '') {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Catalog admin is off. Set <code>ADMIN_CATALOG_TOKEN</code> in your environment and restart the bot.</p>');
    return true;
  }

  if (req.method === 'GET') {
    const u = new URL(req.url || '/', `http://${host}`);
    if ((u.searchParams.get('token') || '') !== tokenEnv) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>Unauthorized. Open this URL with <code>?token=</code> matching your <code>ADMIN_CATALOG_TOKEN</code>.</p>');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(tokenEnv, {}));
    return true;
  }

  if (req.method === 'POST') {
    const html = await handleAdminPost(req, tokenEnv);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
  return true;
}

module.exports = { tryHandleCatalogAdmin, ADMIN_PATH };
