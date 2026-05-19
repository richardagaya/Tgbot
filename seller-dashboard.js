const fs = require('fs');
const catalog = require('./catalog');
const { runtimeFile } = require('./runtime-paths');
const firebaseRepo = require('./firebase-repo');

const DB_PATH = runtimeFile('db.json');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadDB() {
  try {
    const db = firebaseRepo.getDb();
    return { orders: Array.isArray(db.orders) ? db.orders : [] };
  } catch (_) {
    // Local scripts can still read db.json before Firebase init.
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { orders: Array.isArray(raw.orders) ? raw.orders : [] };
  } catch {
    return { orders: [] };
  }
}

function money(amount) {
  return `$${Number(amount || 0).toFixed(2)}`;
}

function sellerStats(username) {
  const products = catalog.getProducts().filter((p) => p.sellerUsername === username);
  const productIds = new Set(products.map((p) => p.id));
  const orders = loadDB().orders.filter((order) => order.sellerUsername === username || productIds.has(order.productId));
  const totalEarnings = orders.reduce((sum, order) => sum + Number(order.price || 0), 0);
  const unitsSold = orders.reduce((sum, order) => sum + Math.max(1, Number(order.qty || 1)), 0);
  return {
    products,
    orders,
    totalEarnings,
    unitsSold,
  };
}

function renderMetric(label, value) {
  return `<div class="metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;
}

function renderSellerDashboard(session, addCategoryCardHtml = '') {
  const stats = sellerStats(session.username);
  return `<section class="tab-panel active" id="tab-dashboard">
    <div class="card">
    <h2>Seller Dashboard</h2>
    <div class="metrics">
      ${renderMetric('All-time earnings', money(stats.totalEarnings))}
      ${renderMetric('Files sold', stats.unitsSold)}
      ${renderMetric('Files uploaded', stats.products.length)}
    </div>
    <p class="muted">Use this dashboard to upload ZIP files, create categories, and track your earnings.</p>
    </div>
    <div style="margin-top:1rem">${addCategoryCardHtml}</div>
  </section>`;
}

module.exports = { sellerStats, renderSellerDashboard };
