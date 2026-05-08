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
      limits: {
        files: 20,
        fileSize: limitMb * 1024 * 1024,
        fields: 80,
      },
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
      const done = new Promise((resolveWrite, rejectWrite) => {
        out.on('close', () => {
          if (size > 0) {
            files.push({ fieldname, originalName, tempPath, mimeType: info.mimeType, size });
          } else {
            try {
              fs.unlinkSync(tempPath);
            } catch (_) {}
          }
          resolveWrite();
        });
        out.on('error', rejectWrite);
      });
      writes.push(done);
      file.on('data', (chunk) => {
        size += chunk.length;
      });
      file.pipe(out);
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      Promise.all(writes)
        .then(() => resolve({ fields, files, tmpDir }))
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

function moveUploadedFiles(product, files) {
  if (!files || files.length === 0) return {};
  const destDir = path.join(UPLOADS_DIR, product.id);
  ensureDir(destDir);

  const moved = [];
  for (const f of files) {
    const dest = path.join(destDir, f.originalName);
    fs.renameSync(f.tempPath, dest);
    moved.push(dest);
  }

  if (moved.length === 1) {
    return { filePath: relativeProjectPath(moved[0]), deliveryFolder: null, deliveryZipPath: null };
  }
  return { filePath: null, deliveryFolder: relativeProjectPath(destDir), deliveryZipPath: null };
}

function storeOptions(selected = '') {
  const leaves = catalog.listStoreLeaves();
  if (!leaves.length) return '<option value="">Create a section first</option>';
  return leaves
    .map((l) => `<option value="${esc(l.path)}" ${l.path === selected ? 'selected' : ''}>${esc(l.label)}</option>`)
    .join('\n');
}

function categoryOptions(selected = '') {
  const cats = catalog.getStore();
  if (!cats.length) return '<option value="">Create a category first</option>';
  return cats
    .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('\n');
}

function groupOptions(selected = '') {
  const rows = [];
  for (const c of catalog.getStore()) {
    for (const s of c.subs || []) {
      const value = `${c.id}:${s.id}`;
      rows.push(
        `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(c.name)} / ${esc(s.name)}</option>`
      );
    }
  }
  return rows.length ? rows.join('\n') : '<option value="">Create a subcategory first</option>';
}

function productOptions(selected = '') {
  const products = catalog.getProducts();
  if (!products.length) return '<option value="">Create a product first</option>';
  return products
    .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} (${esc(p.id)})</option>`)
    .join('\n');
}

function productDeliveryLabel(product) {
  if (product.deliveryFolder) return `Folder: ${product.deliveryFolder}`;
  if (product.deliveryZipPath) return `ZIP: ${product.deliveryZipPath}`;
  if (product.filePath) return `File: ${product.filePath}`;
  if (product.fileId) return 'Telegram file_id set';
  return 'No delivery file yet';
}

function renderStoreTree() {
  const productsById = new Map(catalog.getProducts().map((p) => [p.id, p]));
  const cats = catalog.getStore();
  if (!cats.length) return '<p class="muted">No categories yet.</p>';
  return cats
    .map((cat) => {
      const groups = (cat.subs || [])
        .map((sub) => {
          const sections = (sub.subs || [])
            .map((section) => {
              const productNames = (section.productIds || [])
                .map((id) => productsById.get(id))
                .filter(Boolean)
                .map((p) => `<span class="pill">${esc(p.name)} - $${Number(p.price).toFixed(2)}</span>`)
                .join(' ');
              const qty =
                section.quantityAvailable === undefined || section.quantityAvailable === null
                  ? 'Unlimited'
                  : String(section.quantityAvailable);
              return `<li><strong>${esc(section.name)}</strong> <span class="muted">stock: ${esc(qty)}</span><br />${
                section.description ? `<span class="muted">${esc(section.description)}</span><br />` : ''
              }${productNames || '<span class="muted">No product linked</span>'}</li>`;
            })
            .join('');
          return `<li><strong>${esc(sub.name)}</strong><ul>${sections || '<li class="muted">No sections yet</li>'}</ul></li>`;
        })
        .join('');
      return `<details open><summary>${esc(cat.name)} <code>${esc(cat.id)}</code></summary><ul>${
        groups || '<li class="muted">No subcategories yet</li>'
      }</ul></details>`;
    })
    .join('\n');
}

function renderProductRows() {
  const products = catalog.getProducts();
  if (!products.length) return '<tr><td colspan="5">No products yet.</td></tr>';
  return products
    .map(
      (p) => `<tr>
        <td><code>${esc(p.id)}</code></td>
        <td>${esc(p.name)}</td>
        <td>$${esc(Number(p.price).toFixed(2))}</td>
        <td>${esc(productDeliveryLabel(p))}</td>
        <td>${esc(p.description || '')}</td>
      </tr>`
    )
    .join('\n');
}

function pageHtml(formToken, { ok, err } = {}) {
  const banner = ok ? `<p class="ok">${esc(ok)}</p>` : err ? `<p class="err">${esc(err)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Catalog Admin</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 72rem; margin: 2rem auto; padding: 0 1rem 3rem; color: #151515; background: #f7f7f8; }
    h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.05rem; margin: 0 0 1rem; }
    label { display: block; margin-top: 0.8rem; font-weight: 700; font-size: 0.88rem; }
    input, textarea, select { width: 100%; box-sizing: border-box; margin-top: 0.3rem; padding: 0.65rem; font: inherit; border: 1px solid #ccc; border-radius: 10px; background: white; color: #151515; }
    textarea { min-height: 5rem; resize: vertical; }
    button { margin-top: 1rem; padding: 0.7rem 1rem; font: inherit; font-weight: 700; cursor: pointer; border: 0; border-radius: 999px; color: white; background: #111827; }
    code { font-size: 0.86em; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #ddd; padding: 0.6rem 0.4rem; }
    details { background: white; border: 1px solid #ddd; border-radius: 14px; padding: 0.8rem 1rem; margin-bottom: 0.8rem; }
    summary { cursor: pointer; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 1rem; align-items: start; }
    .card { background: white; border: 1px solid #ddd; border-radius: 18px; padding: 1rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
    .full { grid-column: 1 / -1; }
    .muted { color: #666; font-size: 0.9rem; }
    .hint { color: #666; font-size: 0.82rem; margin-top: 0.35rem; }
    .ok { background: #e8f5e9; border: 1px solid #a5d6a7; padding: 0.85rem 1rem; border-radius: 12px; }
    .err { background: #ffebee; border: 1px solid #ef9a9a; padding: 0.85rem 1rem; border-radius: 12px; }
    .warn { background: #fff8e1; border: 1px solid #ffe082; padding: 0.85rem 1rem; border-radius: 12px; }
    .pill { display: inline-block; margin: 0.25rem 0.25rem 0 0; padding: 0.2rem 0.55rem; border-radius: 999px; background: #eef2ff; color: #1e1b4b; font-size: 0.82rem; }
    @media (prefers-color-scheme: dark) {
      body { color: #eee; background: #111; }
      input, textarea, select, .card, details { color: #eee; background: #1b1b1b; border-color: #333; }
      th, td { border-color: #333; }
      .muted, .hint { color: #aaa; }
      .warn { color: #211900; }
    }
  </style>
</head>
<body>
  <h1>Catalog Admin</h1>
  <p class="muted">Manage shop categories, sections, products, and delivery uploads. Use this only for lawful digital files you own or are allowed to sell.</p>
  <p class="warn"><strong>Railway note:</strong> uploaded files and <code>catalog.json</code> changes live on the service filesystem. Add a persistent volume or move uploads/database to external storage before relying on this for production.</p>
  ${banner}

  <div class="grid">
    <section class="card">
      <h2>1. Create Category</h2>
      <form method="post" action="${ADMIN_PATH}">
        <input type="hidden" name="token" value="${esc(formToken)}" />
        <input type="hidden" name="action" value="add_category" />
        <label>Name</label>
        <input name="name" required maxlength="120" placeholder="e.g. Templates" />
        <button type="submit">Add Category</button>
      </form>
    </section>

    <section class="card">
      <h2>2. Create Subcategory</h2>
      <form method="post" action="${ADMIN_PATH}">
        <input type="hidden" name="token" value="${esc(formToken)}" />
        <input type="hidden" name="action" value="add_group" />
        <label>Parent Category</label>
        <select name="catId" required>${categoryOptions()}</select>
        <label>Name</label>
        <input name="name" required maxlength="120" placeholder="e.g. PDF packs" />
        <button type="submit">Add Subcategory</button>
      </form>
    </section>

    <section class="card">
      <h2>3. Create Section</h2>
      <form method="post" action="${ADMIN_PATH}">
        <input type="hidden" name="token" value="${esc(formToken)}" />
        <input type="hidden" name="action" value="add_section" />
        <label>Parent Subcategory</label>
        <select name="groupPath" required>${groupOptions()}</select>
        <label>Name</label>
        <input name="name" required maxlength="120" placeholder="e.g. Starter kit" />
        <label>Description</label>
        <textarea name="description" maxlength="1000" placeholder="Shown before quantity/purchase"></textarea>
        <label>Stock Quantity</label>
        <input name="quantityAvailable" type="number" min="0" step="1" placeholder="Leave empty for unlimited" />
        <button type="submit">Add Section</button>
      </form>
    </section>

    <section class="card">
      <h2>4. Create Product + Upload</h2>
      <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
        <input type="hidden" name="token" value="${esc(formToken)}" />
        <input type="hidden" name="action" value="add_product" />
        <label>Section</label>
        <select name="leaf" required>${storeOptions()}</select>
        <label>Product Name</label>
        <input name="name" required maxlength="200" placeholder="e.g. Guide PDF" />
        <label>Description</label>
        <textarea name="description" maxlength="2000" placeholder="Product details"></textarea>
        <label>Price (USD)</label>
        <input name="price" type="number" step="0.01" min="0" required placeholder="9.99" />
        <label>Delivery File(s)</label>
        <input name="files" type="file" multiple />
        <p class="hint">One file is delivered directly. Multiple files are stored in a folder and sent as a ZIP by the bot.</p>
        <button type="submit">Create Product</button>
      </form>
    </section>

    <section class="card">
      <h2>Replace Product Files</h2>
      <form method="post" action="${ADMIN_PATH}" enctype="multipart/form-data">
        <input type="hidden" name="token" value="${esc(formToken)}" />
        <input type="hidden" name="action" value="upload_product_file" />
        <label>Product</label>
        <select name="productId" required>${productOptions()}</select>
        <label>New Delivery File(s)</label>
        <input name="files" type="file" multiple required />
        <button type="submit">Upload / Replace</button>
      </form>
    </section>

    <section class="card full">
      <h2>Current Shop Tree</h2>
      ${renderStoreTree()}
    </section>

    <section class="card full">
      <h2>Products</h2>
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Price</th><th>Delivery</th><th>Description</th></tr></thead>
        <tbody>${renderProductRows()}</tbody>
      </table>
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

async function handleAdminPost(req, res, tokenEnv) {
  let parsed = { fields: {}, files: [] };
  try {
    parsed = await parsePost(req);
    const { fields, files } = parsed;
    assertToken(fields.token || '', tokenEnv);

    if (fields.action === 'add_category') {
      const c = catalog.addCategory({ name: fields.name });
      return pageHtml(tokenEnv, { ok: `Created category: ${c.name}` });
    }

    if (fields.action === 'add_group') {
      const g = catalog.addGroup({ catId: fields.catId, name: fields.name });
      return pageHtml(tokenEnv, { ok: `Created subcategory: ${g.name}` });
    }

    if (fields.action === 'add_section') {
      const [catId, subId] = String(fields.groupPath || '').split(':');
      const s = catalog.addSection({
        catId,
        subId,
        name: fields.name,
        description: fields.description,
        quantityAvailable: fields.quantityAvailable,
      });
      return pageHtml(tokenEnv, { ok: `Created section: ${s.name}` });
    }

    if (fields.action === 'add_product') {
      const product = catalog.addProduct({
        leaf: fields.leaf,
        name: fields.name,
        description: fields.description,
        price: fields.price,
      });
      const deliveryPatch = moveUploadedFiles(product, files);
      if (Object.keys(deliveryPatch).length) catalog.updateProduct(product.id, deliveryPatch);
      return pageHtml(tokenEnv, { ok: `Created product: ${product.name}` });
    }

    if (fields.action === 'upload_product_file') {
      const product = catalog.findProduct(fields.productId);
      if (!product) throw new Error('Product not found');
      if (!files.length) throw new Error('Choose at least one file to upload');
      const deliveryPatch = moveUploadedFiles(product, files);
      catalog.updateProduct(product.id, deliveryPatch);
      return pageHtml(tokenEnv, { ok: `Updated delivery files for ${product.name}` });
    }

    throw new Error('Unknown action');
  } catch (e) {
    cleanupFiles(parsed.files);
    return pageHtml(tokenEnv, { err: e.message || String(e) });
  }
}

/**
 * @returns {Promise<boolean>} true if this handler served the request
 */
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
    const qToken = u.searchParams.get('token') || '';
    if (qToken !== tokenEnv) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>Unauthorized. Open this URL with <code>?token=</code> matching your <code>ADMIN_CATALOG_TOKEN</code>.</p>');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(tokenEnv, {}));
    return true;
  }

  if (req.method === 'POST') {
    const html = await handleAdminPost(req, res, tokenEnv);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
  return true;
}

module.exports = { tryHandleCatalogAdmin, ADMIN_PATH };
