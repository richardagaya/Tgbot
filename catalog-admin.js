const catalog = require('./catalog');

const ADMIN_PATH = '/admin/catalog';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBody(req, limit = 65536) {
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

function pageHtml(formToken, { ok, err } = {}) {
  const leaves = catalog.listStoreLeaves();
  const products = catalog.getProducts();
  const options =
    leaves.length > 0
      ? leaves.map((l) => `<option value="${esc(l.path)}">${esc(l.label)}</option>`).join('\n')
      : '<option value="">(Add a store tree in catalog.json first)</option>';
  const rows = products
    .map(
      (p) =>
        `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.name)}</td><td>$${esc(
          Number(p.price).toFixed(2)
        )}</td></tr>`
    )
    .join('\n');

  const banner = ok
    ? `<p class="ok">${esc(ok)}</p>`
    : err
      ? `<p class="err">${esc(err)}</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Catalog — add product</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.25rem; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; font-size: 0.875rem; }
    input, textarea, select { width: 100%; box-sizing: border-box; margin-top: 0.25rem; padding: 0.5rem; font-size: 1rem; }
    textarea { min-height: 5rem; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
    .ok { background: #e8f5e9; padding: 0.75rem; border-radius: 6px; }
    .err { background: #ffebee; padding: 0.75rem; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; font-size: 0.875rem; }
    th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 0.4rem 0.25rem; }
    code { font-size: 0.85em; }
    .hint { font-size: 0.8rem; color: #555; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>Add product</h1>
  <p>New products are saved to <code>catalog.json</code> and appear in the bot after save.</p>
  ${banner}
  <form method="post" action="${ADMIN_PATH}">
    <input type="hidden" name="token" value="${esc(formToken)}" />
    <label for="name">Name</label>
    <input id="name" name="name" required maxlength="200" placeholder="e.g. Host toolkit PDF" />
    <label for="description">Description</label>
    <textarea id="description" name="description" maxlength="2000" placeholder="Short description for the product page"></textarea>
    <label for="price">Price (USD)</label>
    <input id="price" name="price" type="number" step="0.01" min="0" required placeholder="9.99" />
    <label for="leaf">Section in shop</label>
    <select id="leaf" name="leaf" ${leaves.length ? 'required' : ''}>${options}</select>
    <p class="hint">To change categories or move items, edit <code>catalog.json</code> (structure: category → subcategory → section → product ids).</p>
    <button type="submit">Add product</button>
  </form>
  <h2 style="margin-top:2rem;font-size:1rem;">Current products (${products.length})</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Price</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">No products yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;
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
    res.end(
      '<p>Catalog admin is off. Set <code>ADMIN_CATALOG_TOKEN</code> in your environment and restart the bot.</p>'
    );
    return true;
  }

  if (req.method === 'GET') {
    const u = new URL(req.url || '/', `http://${host}`);
    const qToken = u.searchParams.get('token') || '';
    if (qToken !== tokenEnv) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<p>Unauthorized. Open this URL with <code>?token=</code> matching your <code>ADMIN_CATALOG_TOKEN</code>.</p>'
      );
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(tokenEnv, {}));
    return true;
  }

  if (req.method === 'POST') {
    let params = new URLSearchParams();
    try {
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      if (ct !== 'application/x-www-form-urlencoded') {
        res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Use application/x-www-form-urlencoded');
        return true;
      }
      const raw = await readBody(req);
      params = new URLSearchParams(raw);
      const token = params.get('token') || '';
      if (token !== tokenEnv) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return true;
      }
      const name = params.get('name');
      const description = params.get('description') || '';
      const price = params.get('price');
      const leaf = params.get('leaf');
      const product = catalog.addProduct({ name, description, price, leaf });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml(token, { ok: `Saved ${product.id} — ${product.name}` }));
      return true;
    } catch (e) {
      const msg = e.message || String(e);
      const token = params.get('token') || '';
      if (token === tokenEnv) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHtml(token, { err: msg }));
        return true;
      }
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(msg);
      return true;
    }
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
  return true;
}

module.exports = { tryHandleCatalogAdmin, ADMIN_PATH };
