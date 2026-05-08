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

function categoryOptions({ includeRoot = false } = {}) {
  const nodes = catalog.listStoreNodes();
  const root = includeRoot ? '<option value="">Top level category</option>' : '';
  const opts = nodes
    .map((n) => `<option value="${esc(n.path)}">${esc(n.label)}</option>`)
    .join('\n');
  return root + (opts || (includeRoot ? '' : '<option value="">Create a category first</option>'));
}

function productOptions() {
  const products = catalog.getProducts();
  if (!products.length) return '<option value="">No products yet</option>';
  return products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('\n');
}

function productLocationPaths(productId) {
  const paths = [];
  for (const node of catalog.listStoreNodes()) {
    const hit = catalog.resolveStoreNode(node.path);
    if (hit?.node && (hit.node.productIds || []).includes(productId)) paths.push(node.path);
  }
  return paths;
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

function renderProducts() {
  const products = catalog.getProducts();
  if (!products.length) return '<p class="muted">No products yet.</p>';
  return `<table><thead><tr><th>Product</th><th>Price</th><th>Available Files</th><th>Description</th></tr></thead><tbody>${products
    .map(
      (p) =>
        `<tr><td><code>${esc(p.id)}</code><br>${esc(p.name)}</td><td>$${Number(p.price).toFixed(2)}</td><td>${inventoryCount(
          p
        )}</td><td>${esc(p.description || '')}</td></tr>`
    )
    .join('\n')}</tbody></table>`;
}

function pageHtml(token, { ok, err } = {}) {
  const banner = ok ? `<p class="ok">${esc(ok)}</p>` : err ? `<p class="err">${esc(err)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shop Admin</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem 3rem; background: #f6f7f9; color: #151515; }
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
  <p class="muted">Create nested categories, add products, and upload delivery files. Only use this for lawful digital goods you are allowed to sell.</p>
  <p class="warn"><strong>Railway:</strong> add a persistent volume or uploads/catalog changes may disappear after redeploys.</p>
  ${banner}

  <div class="grid">
    <section class="card">
      <h2>Add Category</h2>
      <form method="post" action="${ADMIN_PATH}">
        <input type="hidden" name="token" value="${esc(token)}" />
        <input type="hidden" name="action" value="add_category" />
        <label>Inside</label>
        <select name="parentPath">${categoryOptions({ includeRoot: true })}</select>
        <label>Category Name</label>
        <input name="name" required maxlength="120" placeholder="Example: Old fullz" />
        <label>Description</label>
        <textarea name="description" maxlength="1500" placeholder="What this category contains"></textarea>
        <button type="submit">Create Category</button>
      </form>
    </section>

    <section class="card">
      <h2>Add Product + Files</h2>
      <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
        <input type="hidden" name="token" value="${esc(token)}" />
        <input type="hidden" name="action" value="add_product" />
        <label>Show Product Under</label>
        <select name="leaf" required>${categoryOptions()}</select>
        <label>Product Name</label>
        <input name="name" required maxlength="200" placeholder="Example: January pack" />
        <label>Description</label>
        <textarea name="description" maxlength="2000" placeholder="Shown before purchase"></textarea>
        <label>Price Per File (USD)</label>
        <input name="price" type="number" min="0" step="0.01" required placeholder="9.99" />
        <label>Upload Delivery Documents</label>
        <input name="files" type="file" multiple required />
        <p class="hint">Quantity is automatic: 1 uploaded document = 1 available item. If a user buys 3, the bot sends 3 files.</p>
        <button type="submit">Create Product</button>
      </form>
    </section>

    <section class="card">
      <h2>Replace Product Files</h2>
      <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
        <input type="hidden" name="token" value="${esc(token)}" />
        <input type="hidden" name="action" value="upload_product_file" />
        <label>Product</label>
        <select name="productId" required>${productOptions()}</select>
        <label>New Delivery Documents</label>
        <input name="files" type="file" multiple required />
        <p class="hint">This replaces available inventory files. Sold files stay archived separately.</p>
        <button type="submit">Replace Files</button>
      </form>
    </section>

    <section class="card full">
      <h2>Shop Tree</h2>
      ${catalog.getStore().length ? `<ul>${renderTreeNodes(catalog.getStore())}</ul>` : '<p class="muted">No categories yet.</p>'}
    </section>

    <section class="card full">
      <h2>Products</h2>
      ${renderProducts()}
    </section>
  </div>
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
      return pageHtml(tokenEnv, { ok: `Created category: ${node.name}` });
    }

    if (fields.action === 'add_product') {
      if (!files.length) throw new Error('Upload at least one delivery document');
      const product = catalog.addProduct({
        leaf: fields.leaf,
        name: fields.name,
        description: fields.description,
        price: fields.price,
      });
      const moved = moveInventoryFiles(product, files);
      catalog.updateProduct(product.id, moved.patch);
      catalog.updateStoreNode(fields.leaf, { quantityAvailable: moved.count });
      return pageHtml(tokenEnv, { ok: `Created ${product.name} with ${moved.count} available file(s)` });
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
      return pageHtml(tokenEnv, { ok: `Updated ${product.name}: ${moved.count} available file(s)` });
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
