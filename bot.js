require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const https = require('https');
const http = require('http');
const catalog = require('./catalog');
const { tryHandleCatalogAdmin, ADMIN_PATH } = require('./catalog-admin');

catalog.ensureCatalogFile();

if (!process.env.BOT_TOKEN || String(process.env.BOT_TOKEN).trim() === '') {
  console.error('FATAL: BOT_TOKEN is missing. Add it in Railway → Variables (same name: BOT_TOKEN).');
  process.exit(1);
}

// Railway / Render: PORT. Local admin UI: set ADMIN_HTTP_PORT if you have no PORT.
const HTTP_PORT = Number(process.env.PORT || process.env.ADMIN_HTTP_PORT || 0);
if (HTTP_PORT) {
  http
    .createServer((req, res) => {
      (async () => {
        try {
          if (await tryHandleCatalogAdmin(req, res)) return;
        } catch (e) {
          console.error('[http]', e.message);
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Server error');
          }
          return;
        }
        const u = req.url || '/';
        if (u === '/' || u === '/health' || u.startsWith('/?')) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('OK');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      })();
    })
    .listen(HTTP_PORT, () => {
      console.log(`HTTP listening on port ${HTTP_PORT} (health: /, catalog admin: ${ADMIN_PATH})`);
      if (process.env.ADMIN_CATALOG_TOKEN) {
        console.log(`[catalog] Open admin: http://127.0.0.1:${HTTP_PORT}${ADMIN_PATH}?token=YOUR_ADMIN_CATALOG_TOKEN`);
      }
    });
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

let last409HintAt = 0;
bot.on('polling_error', (err) => {
  const msg = String(err?.message || err);
  const code = err?.code;
  console.error('[polling_error]', code || '', msg);
  if (code === 'ETELEGRAM' && /409|Conflict|getUpdates/i.test(msg)) {
    const now = Date.now();
    if (now - last409HintAt > 25_000) {
      last409HintAt = now;
      console.error(
        '[telegram] 409: another process is polling this same BOT_TOKEN (e.g. Railway/Render + local). ' +
          'Stop the cloud deployment or use a second test bot from @BotFather for npm run dev.'
      );
    }
  }
});

bot.on('error', (err) => {
  console.error('[bot_error]', err.message);
});

// ─── Database ─────────────────────────────────────────────────────────────────
const DB_PATH = './db.json';

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, orders: [], pendingPayments: [] }));
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH));
  if (!db.pendingPayments) db.pendingPayments = [];
  if (!db.sectionStock) db.sectionStock = {};
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getUser(userId) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = {
      balance: 0,
      purchases: [],
      state: null,
      qtyLeafPath: null,
      pendingSectionPurchase: null,
    };
    saveDB(db);
  }
  if (db.users[userId].state === undefined) db.users[userId].state = null;
  if (!Array.isArray(db.users[userId].purchases)) db.users[userId].purchases = [];
  return db.users[userId];
}

function updateUser(userId, data) {
  const db = loadDB();
  db.users[userId] = { ...db.users[userId], ...data };
  saveDB(db);
}

/** Edit caption HTML on /start (shown under the banner image). */
const WELCOME_MESSAGE_TEMPLATE = `Welcome to the <b>STIX MARKET</b>!`;

const START_BANNER_PATH = path.join(__dirname, 'assets', 'Market.png');

// Products & shop layout live in catalog.json (see catalog.js). Admin UI: /admin/catalog

const MIN_DEPOSIT = 10; // USD — minimum deposit amount in the bot

// ─── NOWPayments API ──────────────────────────────────────────────────────────
// Production: https://api.nowpayments.io/v1 — Sandbox: https://api-sandbox.nowpayments.io/v1
// Create a sandbox account at https://account.sandbox.nowpayments.io and generate a sandbox API key.
function resolveNowPaymentsHost() {
  const explicit = process.env.NOWPAYMENTS_API_HOST;
  if (explicit && explicit.trim()) return explicit.trim();
  const sb = process.env.NOWPAYMENTS_SANDBOX;
  if (sb === '1' || sb === 'true' || sb === 'yes') return 'api-sandbox.nowpayments.io';
  return 'api.nowpayments.io';
}
const NOWPAYMENTS_API_HOST = resolveNowPaymentsHost();

/** Sandbox API simulates flows; real crypto is not required when `case` is set (see createNowPayment). */
function isNowPaymentsSandbox() {
  return NOWPAYMENTS_API_HOST.includes('sandbox');
}

const DEPOSIT_CURRENCIES = [
  { label: 'USDT (TRC20)', value: 'usdttrc20' },
  { label: 'USDT (ERC20)', value: 'usdterc20' },
  { label: 'BTC',          value: 'btc' },
  { label: 'ETH',          value: 'eth' },
  { label: 'LTC',          value: 'ltc' },
  { label: 'TRX',          value: 'trx' },
];

const FINAL_STATUSES = new Set(['finished', 'confirmed', 'failed', 'expired', 'refunded']);

function nowPaymentsRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: NOWPAYMENTS_API_HOST,
      path: `/v1${endpoint}`,
      method,
      headers: {
        'x-api-key': process.env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Payments returned invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function createNowPayment(userId, usdAmount, currency) {
  const body = {
    price_amount: usdAmount,
    price_currency: 'usd',
    pay_currency: currency,
    order_id: `${userId}_${Date.now()}`,
    order_description: `Balance deposit for user ${userId}`,
    is_fixed_rate: false,
    is_fee_paid_by_user: true,
  };
  // Sandbox only: simulates payment outcome without sending crypto (Postman: "case" on POST /payment).
  if (isNowPaymentsSandbox()) {
    const c = process.env.NOWPAYMENTS_SANDBOX_CASE;
    body.case = c && String(c).trim() ? String(c).trim() : 'success';
  }
  return nowPaymentsRequest('POST', '/payment', body);
}

async function assertDepositMeetsNowPaymentsMinimum(usdAmount, payCurrency) {
  const q = (k, v) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
  let minRaw;
  try {
    minRaw = await nowPaymentsRequest('GET', `/min-amount?${q('currency_from', payCurrency)}&${q('currency_to', 'usd')}`);
  } catch {
    return;
  }
  if (!minRaw || minRaw.status === false || minRaw.min_amount == null) return;

  let estRaw;
  try {
    estRaw = await nowPaymentsRequest(
      'GET',
      `/estimate?${q('amount', usdAmount)}&${q('currency_from', 'usd')}&${q('currency_to', payCurrency)}`
    );
  } catch {
    return;
  }
  if (!estRaw || estRaw.status === false) return;

  const minCrypto = Number(minRaw.min_amount);
  const estCrypto = Number(estRaw.estimated_amount);
  if (!Number.isFinite(minCrypto) || !Number.isFinite(estCrypto) || minCrypto <= 0 || estCrypto <= 0) return;

  if (estCrypto < minCrypto * 0.999) {
    const bump = Math.ceil((usdAmount * (minCrypto / estCrypto)) * 1.08 * 10) / 10;
    throw new Error(
      `This USD amount converts to too little ${payCurrency.toUpperCase()} for this network's minimum.\n\nTry at least ~$${bump}, or pick USDT (TRC20) for lower minimums.`
    );
  }
}

async function getNowPaymentStatus(paymentId) {
  return nowPaymentsRequest('GET', `/payment/${paymentId}`);
}

async function checkPendingPayments() {
  const db = loadDB();
  const active = db.pendingPayments.filter((p) => !FINAL_STATUSES.has(p.status));
  if (!active.length) return;

  let changed = false;

  for (const p of active) {
    try {
      const result = await getNowPaymentStatus(p.paymentId);
      const newStatus =
        result && typeof result === 'object'
          ? result.payment_status || (result.payment && result.payment.payment_status)
          : null;
      if (!newStatus || newStatus === p.status) continue;

      p.status = newStatus;
      changed = true;

      if (newStatus === 'finished' || newStatus === 'confirmed') {
        const user = db.users[p.userId] || { balance: 0, purchases: [], state: null };
        user.balance = parseFloat((user.balance + p.usdAmount).toFixed(2));
        db.users[p.userId] = user;

        bot.sendMessage(
          p.userId,
          `✅ *Payment Confirmed!*\n\n*+$${p.usdAmount.toFixed(2)} USD* has been credited to your balance.\nNew balance: *$${user.balance.toFixed(2)}*\n\nYou can now purchase files! 🎉`,
          { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
        );

        if (process.env.ADMIN_CHAT_ID) {
          bot.sendMessage(
            process.env.ADMIN_CHAT_ID,
            `✅ Auto-credited *$${p.usdAmount.toFixed(2)}* to user \`${p.userId}\` (payment \`${p.paymentId}\`)`,
            { parse_mode: 'Markdown' }
          );
        }
      } else if (newStatus === 'failed' || newStatus === 'expired') {
        bot.sendMessage(
          p.userId,
          `❌ *Payment ${newStatus}*\n\nYour deposit of *$${p.usdAmount.toFixed(2)}* was ${newStatus}. Please try depositing again.`,
          { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
        );
      }
    } catch (err) {
      console.error(`[poll] Error checking payment ${p.paymentId}:`, err.message);
    }
  }

  if (changed) {
    const done = db.pendingPayments.filter((p) => FINAL_STATUSES.has(p.status)).slice(-100);
    const still_active = db.pendingPayments.filter((p) => !FINAL_STATUSES.has(p.status));
    db.pendingPayments = [...still_active, ...done];
    saveDB(db);
  }
}

const PAYMENT_POLL_MS = isNowPaymentsSandbox() ? 15 * 1000 : 60 * 1000;
setInterval(checkPendingPayments, PAYMENT_POLL_MS);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBalance(amount) {
  return `$${amount.toFixed(2)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Stable key for a store leaf: catId:subId:leafId */
function sectionPathFromParts(parts) {
  return parts.filter(Boolean).join(':');
}

function getLeafFromPathKey(pathKey) {
  const parts = String(pathKey || '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const r = catalog.resolveStoreNode(parts);
  if (!r || r.kind !== 'node') return null;
  return { parts, r };
}

function productInventoryFiles(product) {
  const folder = resolveProductFsPath(product.inventoryFolder);
  if (!folder || !fs.existsSync(folder)) return null;
  const st = fs.statSync(folder);
  if (!st.isDirectory()) return null;
  return fs
    .readdirSync(folder)
    .filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.zip'))
    .map((name) => path.join(folder, name))
    .filter((fp) => fs.statSync(fp).isFile())
    .sort();
}

/** Current units available for this section (null = unlimited). Synced in db.sectionStock. */
function getSectionStock(pathKey) {
  const db = loadDB();
  if (!db.sectionStock) db.sectionStock = {};
  if (Object.prototype.hasOwnProperty.call(db.sectionStock, pathKey)) {
    const v = db.sectionStock[pathKey];
    return v === null ? null : v;
  }
  const hit = getLeafFromPathKey(pathKey);
  if (!hit) return 0;
  const productId = (hit.r.productIds || [])[0];
  const product = productId ? catalog.findProduct(productId) : null;
  const inventory = product ? productInventoryFiles(product) : null;
  if (inventory) return inventory.length;
  const qa = hit.r.node.quantityAvailable;
  if (qa === undefined || qa === null) {
    return null;
  }
  const n = Math.max(0, Math.floor(Number(qa)));
  db.sectionStock[pathKey] = n;
  saveDB(db);
  return n;
}

function setSectionStock(pathKey, value) {
  const db = loadDB();
  if (!db.sectionStock) db.sectionStock = {};
  db.sectionStock[pathKey] = value;
  saveDB(db);
}

/** Returns false if not enough stock (only when stock is capped). */
function decrementSectionStock(pathKey, qty) {
  const hit = getLeafFromPathKey(pathKey);
  const productId = hit ? (hit.r.productIds || [])[0] : null;
  const product = productId ? catalog.findProduct(productId) : null;
  const inventory = product ? productInventoryFiles(product) : null;
  if (inventory) return inventory.length >= qty;

  const cur = getSectionStock(pathKey);
  if (cur === null) return true;
  if (cur < qty) return false;
  setSectionStock(pathKey, cur - qty);
  return true;
}

/** Reply keyboard under the chat (same actions as the welcome inline buttons). */
const MENU = {
  SHOP: '🛒 Shop',
  BALANCE: '💰 Balance',
  DEPOSIT: '💳 Deposit',
  MY_ORDERS: '📋 My Orders',
  SUPPORT: '🆘 Support',
  HIDE: '✕ Hide keyboard',
};

function startWelcomeInlineKeyboard() {
  const supportBtn = process.env.SUPPORT_URL
    ? [{ text: '🆘 Support ↗', url: process.env.SUPPORT_URL }]
    : [{ text: '🆘 Support', callback_data: 'support' }];
  return {
    inline_keyboard: [
      [{ text: '🛒 Shop', callback_data: 'browse' }, { text: '💰 Balance', callback_data: 'account' }],
      [{ text: '💳 Deposit', callback_data: 'deposit' }, { text: '📋 My Orders', callback_data: 'my_purchases' }],
      supportBtn,
    ],
  };
}

function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: MENU.SHOP }, { text: MENU.BALANCE }],
      [{ text: MENU.DEPOSIT }, { text: MENU.MY_ORDERS }],
      [{ text: MENU.SUPPORT }],
      [{ text: MENU.HIDE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function sendWelcomeStart(chatId, userId) {
  getUser(userId);
  const caption = WELCOME_MESSAGE_TEMPLATE;
  const markup = startWelcomeInlineKeyboard();
  try {
    if (fs.existsSync(START_BANNER_PATH)) {
      await bot.sendPhoto(chatId, START_BANNER_PATH, {
        caption,
        parse_mode: 'HTML',
        reply_markup: markup,
      });
      return;
    }
    console.warn('[start] Banner not found at', START_BANNER_PATH, '— sending text only.');
  } catch (e) {
    console.error('[start] sendPhoto:', e.message);
  }
  await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: markup });
}

function sendMainMenu(chatId) {
  return bot.sendMessage(chatId, `🏠 <b>Main menu</b>\n\nPick an option below.`, {
    parse_mode: 'HTML',
    reply_markup: mainReplyKeyboard(),
  });
}

function sendLeafQtyIntro(chatId, parts, userId) {
  const pathKey = sectionPathFromParts(parts);
  const r = catalog.resolveStoreNode(parts);
  if (!r || r.kind !== 'node') {
    return bot.sendMessage(chatId, '⚠️ That option is not available.', {
      reply_markup: { inline_keyboard: [[{ text: '🛒 Shop', callback_data: 'browse' }]] },
    });
  }
  const node = r.node;
  const ids = r.productIds || [];

  if (ids.length === 0) {
    const desc = (node.description && String(node.description).trim()) || 'No description yet.';
    const stock = getSectionStock(pathKey);
    const stockLine =
      stock === null ? '📦 <b>Available:</b> in stock' : `📦 <b>Available:</b> ${stock}`;
    return bot.sendMessage(
      chatId,
      `📂 <b>${escapeHtml(node.name)}</b>\n\n${escapeHtml(desc)}\n\n${stockLine}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]],
        },
      }
    );
  }

  if (ids.length > 1) {
    const rows = [];
    const desc = (node.description && String(node.description).trim()) || '';
    const stock = getSectionStock(pathKey);
    const stockLine =
      stock === null ? '📦 <b>Available:</b> in stock' : `📦 <b>Available:</b> ${stock}`;
    let body = `📂 <b>${escapeHtml(node.name)}</b>`;
    if (desc) body += `\n\n${escapeHtml(desc)}`;
    body += `\n\n${stockLine}`;
    const list = ids.map((id) => catalog.findProduct(id)).filter(Boolean);
    for (const p of list) {
      rows.push([{ text: `${p.name} — ${formatBalance(p.price)}`, callback_data: `product_${p.id}` }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]);
    return bot.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }

  const product = catalog.findProduct(ids[0]);
  if (!product) {
    return bot.sendMessage(chatId, '⚠️ Product missing for this listing.', {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]] },
    });
  }

  const stock = getSectionStock(pathKey);
  const desc =
    (node.description && String(node.description).trim()) ||
    product.description ||
    'No description yet.';
  const stockLine =
    stock === null ? '📦 <b>Available:</b> in stock' : `📦 <b>Available:</b> ${stock}`;

  let body = `📂 <b>${escapeHtml(node.name)}</b>\n\n${escapeHtml(desc)}\n\n${stockLine}\n💵 <b>Price each:</b> ${formatBalance(
    product.price
  )}\n\n`;

  if (stock !== null && stock <= 0) {
    body += '❌ Sold out for now.';
    updateUser(userId, { state: null, qtyLeafPath: null });
    return bot.sendMessage(chatId, body, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]],
      },
    });
  }

  body +=
    '✏️ <b>How many do you want?</b>\nReply with a whole number' +
    (stock === null ? '.' : ` (1–${stock}).`);

  updateUser(userId, {
    state: 'awaiting_section_qty',
    qtyLeafPath: pathKey,
    pendingSectionPurchase: null,
  });

  return bot.sendMessage(chatId, body, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]],
    },
  });
}

function handleSectionQtyMessage(chatId, userId, text, user) {
  const pathKey = user.qtyLeafPath;
  const qty = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
  const stock = getSectionStock(pathKey);
  const parts = pathKey.split(':').filter(Boolean);
  const r = catalog.resolveStoreNode(parts);
  if (!r || r.kind !== 'node') {
    updateUser(userId, { state: null, qtyLeafPath: null });
    return bot.sendMessage(chatId, '⚠️ Session expired. Open the shop again.');
  }
  const productId = (r.productIds || [])[0];
  const product = catalog.findProduct(productId);
  if (!product) {
    updateUser(userId, { state: null, qtyLeafPath: null });
    return bot.sendMessage(chatId, '⚠️ Product not found.');
  }
  if (!Number.isFinite(qty) || qty < 1) {
    return bot.sendMessage(chatId, '⚠️ Enter a whole number of at least 1.');
  }
  if (stock !== null && qty > stock) {
    return bot.sendMessage(chatId, `⚠️ Only ${stock} available. Try a smaller quantity.`);
  }

  const total = parseFloat((product.price * qty).toFixed(2));
  const u = getUser(userId);
  updateUser(userId, {
    state: 'awaiting_section_confirm',
    qtyLeafPath: null,
    pendingSectionPurchase: { pathKey, qty, productId },
  });

  const okBal = u.balance >= total;
  const balLine = okBal
    ? '✅ Your balance covers this order.'
    : `❌ You need ${formatBalance(total)} but have ${formatBalance(u.balance)}.`;

  return bot.sendMessage(
    chatId,
    `📋 <b>Confirm order</b>\n\n<b>${escapeHtml(product.name)}</b>\nQty: <b>${qty}</b>\nEach: ${formatBalance(
      product.price
    )}\n<b>Total: ${formatBalance(total)}</b>\n\n💰 Balance: ${formatBalance(u.balance)}\n${balLine}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm purchase', callback_data: 'section_confirm_buy' }],
          [{ text: '🔙 Change quantity', callback_data: 'section_confirm_editqty' }],
        ],
      },
    }
  );
}

function sendBrowse(chatId, userId) {
  return sendBrowseAt(chatId, [], userId);
}

/** Skip redundant menus when there is only one branch at a level. */
function expandAutoBrowseParts(parts) {
  let p = parts.filter(Boolean);
  for (let guard = 0; guard < 24; guard += 1) {
    const r = catalog.resolveStoreNode(p);
    if (!r || r.kind === 'root') break;
    const children = r.children || [];
    const hasProducts = (r.productIds || []).length > 0;
    if (!hasProducts && children.length === 1) {
      p = [...p, children[0].id];
      continue;
    }
    break;
  }
  return p;
}

/** Back from a leaf: skip tiers that had no real choice. */
function shopBackCallbackFromLeaf(parts) {
  const p = parts.filter(Boolean);
  if (p.length <= 1) return 'browse';
  return catalog.encodeStorePath(p.slice(0, -1));
}

function sendBrowseAt(chatId, parts, userId) {
  const normalized = parts.filter(Boolean);
  const expanded = expandAutoBrowseParts(normalized);
  if (expanded.join(':') !== normalized.join(':')) {
    return sendBrowseAt(chatId, expanded, userId);
  }
  parts = expanded;

  const r = catalog.resolveStoreNode(parts);
  if (!r) {
    return bot.sendMessage(chatId, '⚠️ That shop path is not available. Open the shop again.', {
      reply_markup: { inline_keyboard: [[{ text: '🛒 Shop', callback_data: 'browse' }]] },
    });
  }

  const rows = [];
  let body = '📂 <b>Shop</b>';

  if (r.kind === 'root') {
    for (const c of catalog.getStore()) {
      rows.push([{ text: c.name, callback_data: catalog.encodeStorePath([c.id]) }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  } else if (r.kind === 'node') {
    const children = r.children || [];
    const ids = r.productIds || [];
    if (children.length > 0) {
      body = `📂 <b>${escapeHtml(r.node.name)}</b>`;
      if (r.node.description) body += `\n\n${escapeHtml(r.node.description)}`;
      for (const child of children) {
        rows.push([{ text: child.name, callback_data: catalog.encodeStorePath([...parts, child.id]) }]);
      }
      rows.push([{ text: '🔙 Back', callback_data: parts.length <= 1 ? 'browse' : catalog.encodeStorePath(parts.slice(0, -1)) }]);
    } else if (userId != null && (ids.length === 0 || ids.length === 1)) {
      return sendLeafQtyIntro(chatId, parts, userId);
    } else if (ids.length === 0) {
      const stock = getSectionStock(sectionPathFromParts(parts));
      return bot.sendMessage(
        chatId,
        `📂 <b>${escapeHtml(r.node.name)}</b>\n\n${escapeHtml(
          (r.node.description && String(r.node.description).trim()) || 'No description yet.'
        )}\n\n${
          stock === null
            ? '📦 <b>Available:</b> in stock'
            : `📦 <b>Available:</b> ${stock}`
        }`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]],
          },
        }
      );
    } else {
      const list = ids.map((id) => catalog.findProduct(id)).filter(Boolean);
      body = `📂 <b>${escapeHtml(r.node.name)}</b>`;
      for (const p of list) {
        rows.push([{ text: `${p.name} — ${formatBalance(p.price)}`, callback_data: `product_${p.id}` }]);
      }
      rows.push([{ text: '🔙 Back', callback_data: shopBackCallbackFromLeaf(parts) }]);
    }
  }

  return bot.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

function sendDepositIntro(chatId, userId) {
  updateUser(userId, { state: null, qtyLeafPath: null, pendingSectionPurchase: null });
  return bot.sendMessage(
    chatId,
    `💰 <b>Deposit</b>\n\nTop up in crypto — your balance updates automatically once the network confirms.\n\nMinimum: <b>$${MIN_DEPOSIT}</b> USD\n\nHow much do you want to deposit?`,
    { parse_mode: 'HTML', reply_markup: depositAmountInlineKeyboard() }
  );
}

function depositAmountInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '$10', callback_data: 'dep_amount_10' }, { text: '$25', callback_data: 'dep_amount_25' }],
      [{ text: '$50', callback_data: 'dep_amount_50' }, { text: '$100', callback_data: 'dep_amount_100' }],
      [{ text: '✏️ Custom amount', callback_data: 'dep_amount_custom' }],
      [{ text: '🔙 Back', callback_data: 'main_menu' }],
    ],
  };
}

/** When deposit is under the minimum: offer support + return to deposit. */
function supportOrSmallDepositKeyboard() {
  const supportRow = process.env.SUPPORT_URL
    ? [{ text: '🆘 Contact support ↗', url: process.env.SUPPORT_URL }]
    : [{ text: '🆘 Contact support', callback_data: 'support' }];
  return {
    inline_keyboard: [supportRow, [{ text: `💰 Deposit at least $${MIN_DEPOSIT}`, callback_data: 'deposit' }]],
  };
}

function sendAccount(chatId, userId) {
  const user = getUser(userId);
  const db = loadDB();
  const activePays = db.pendingPayments.filter((p) => p.userId === userId && !FINAL_STATUSES.has(p.status));
  const pendingText = activePays.length ? `\n⏳ Pending deposits: <b>${activePays.length}</b>` : '';
  return bot.sendMessage(
    chatId,
    `👤 <b>Your account</b>\n\n🆔 ID: <code>${userId}</code>\n💰 Balance: <b>${formatBalance(user.balance)}</b>\n📦 Files owned: <b>${user.purchases.length}</b>${pendingText}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Deposit', callback_data: 'deposit' }],
          [{ text: '🔙 Main menu', callback_data: 'main_menu' }],
        ],
      },
    }
  );
}

function sendMyPurchases(chatId, userId) {
  const user = getUser(userId);
  if (user.purchases.length === 0) {
    return bot.sendMessage(chatId, "📦 You haven't bought anything yet.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Shop', callback_data: 'browse' }],
          [{ text: '🔙 Main menu', callback_data: 'main_menu' }],
        ],
      },
    });
  }
  const rows = user.purchases.map((pid) => {
    const p = catalog.findProduct(pid);
    return [{ text: `📥 ${p ? p.name : pid}`, callback_data: `download_${pid}` }];
  });
  rows.push([{ text: '🔙 Main menu', callback_data: 'main_menu' }]);
  return bot.sendMessage(chatId, '📦 <b>Your purchases</b>\n\nTap to download:', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
}

function currencyKeyboard() {
  const rows = [];
  for (let i = 0; i < DEPOSIT_CURRENCIES.length; i += 2) {
    const row = [{ text: DEPOSIT_CURRENCIES[i].label, callback_data: `dep_currency_${DEPOSIT_CURRENCIES[i].value}` }];
    if (DEPOSIT_CURRENCIES[i + 1]) {
      row.push({ text: DEPOSIT_CURRENCIES[i + 1].label, callback_data: `dep_currency_${DEPOSIT_CURRENCIES[i + 1].value}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🔙 Back', callback_data: 'deposit' }]);
  return { inline_keyboard: rows };
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  await sendWelcomeStart(msg.chat.id, msg.from.id);
});

// ─── Slash shortcuts (also listed in Telegram’s ☰ command menu) ───────────────
bot.onText(/^\/menu$/i, (msg) => {
  getUser(msg.from.id);
  sendMainMenu(msg.chat.id);
});
bot.onText(/^\/browse$/i, (msg) => {
  getUser(msg.from.id);
  sendBrowse(msg.chat.id, msg.from.id);
});
bot.onText(/^\/deposit$/i, (msg) => {
  getUser(msg.from.id);
  sendDepositIntro(msg.chat.id, msg.from.id);
});
bot.onText(/^\/account$/i, (msg) => {
  getUser(msg.from.id);
  sendAccount(msg.chat.id, msg.from.id);
});
bot.onText(/^\/(purchases|my_purchases)$/i, (msg) => {
  getUser(msg.from.id);
  sendMyPurchases(msg.chat.id, msg.from.id);
});

// ─── Message Handler (reply keyboard + custom deposit amount) ────────────────
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (text.startsWith('/')) return;

  if (text === MENU.SHOP) {
    getUser(userId);
    return sendBrowse(chatId, userId);
  }
  if (text === MENU.DEPOSIT) {
    getUser(userId);
    return sendDepositIntro(chatId, userId);
  }
  if (text === MENU.BALANCE) {
    getUser(userId);
    return sendAccount(chatId, userId);
  }
  if (text === MENU.MY_ORDERS) {
    getUser(userId);
    return sendMyPurchases(chatId, userId);
  }
  if (text === MENU.SUPPORT) {
    const url = process.env.SUPPORT_URL;
    if (url) return bot.sendMessage(chatId, `🆘 <b>Support</b>\n\n${escapeHtml(url)}`, { parse_mode: 'HTML' });
    return bot.sendMessage(
      chatId,
      '🆘 Contact the admin for support, or set SUPPORT_URL in the bot environment.',
      { parse_mode: 'HTML' }
    );
  }

  if (text === MENU.HIDE) {
    return bot.sendMessage(chatId, 'Keyboard hidden. Send /start or /menu to open it again.', {
      reply_markup: { remove_keyboard: true },
    });
  }

  const user = getUser(userId);

  if (user.state === 'awaiting_section_qty' && user.qtyLeafPath) {
    return handleSectionQtyMessage(chatId, userId, text, user);
  }
  if (user.state === 'awaiting_section_confirm') {
    return bot.sendMessage(chatId, 'Use ✅ Confirm or 🔙 Change quantity above.', {
      reply_markup: mainReplyKeyboard(),
    });
  }

  if (!user.state || user.state !== 'awaiting_deposit_amount') return;

  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return bot.sendMessage(
      chatId,
      `⚠️ Enter a valid amount (use a number greater than 0).\n\nMinimum in the bot is <b>$${MIN_DEPOSIT}</b> USD.`,
      { parse_mode: 'HTML', reply_markup: supportOrSmallDepositKeyboard() }
    );
  }
  if (amount < MIN_DEPOSIT) {
    return bot.sendMessage(
      chatId,
      `The minimum deposit here is <b>$${MIN_DEPOSIT}</b> USD.\n\nIf you need to pay <b>less</b> than that, contact support — they can help you complete your purchase another way.`,
      { parse_mode: 'HTML', reply_markup: supportOrSmallDepositKeyboard() }
    );
  }

  updateUser(userId, { state: `awaiting_currency:${amount}` });
  return bot.sendMessage(
    chatId,
    `💱 *Select currency*\n\nDeposit: *$${amount.toFixed(2)} USD*`,
    { parse_mode: 'Markdown', reply_markup: currencyKeyboard() }
  );
});

// ─── Callback Query Handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === 'support') {
    const url = process.env.SUPPORT_URL;
    if (url) return bot.sendMessage(chatId, `🆘 <b>Support</b>\n\n${escapeHtml(url)}`, { parse_mode: 'HTML' });
    return bot.sendMessage(
      chatId,
      '🆘 Contact the admin for support, or set SUPPORT_URL in the bot environment.',
      { parse_mode: 'HTML' }
    );
  }

  // ── Main Menu ──
  if (data === 'main_menu') {
    return sendMainMenu(chatId);
  }

  // ── Browse shop (categories → sub → sub-sub → products) ──
  if (data === 'browse') {
    return sendBrowseAt(chatId, [], userId);
  }
  if (data.startsWith('st:')) {
    return sendBrowseAt(chatId, catalog.decodeStorePath(data), userId);
  }

  if (data === 'section_confirm_editqty') {
    const u = getUser(userId);
    const p = u.pendingSectionPurchase;
    updateUser(userId, { state: null, pendingSectionPurchase: null, qtyLeafPath: null });
    if (!p || !p.pathKey) {
      return bot.sendMessage(chatId, '⚠️ Session expired.');
    }
    const parts = p.pathKey.split(':').filter(Boolean);
    return sendLeafQtyIntro(chatId, parts, userId);
  }

  if (data === 'section_confirm_buy') {
    const u = getUser(userId);
    const pend = u.pendingSectionPurchase;
    if (!pend || !pend.pathKey || !pend.productId || !pend.qty) {
      return bot.sendMessage(chatId, '⚠️ Nothing to confirm. Open the shop again.');
    }
    const product = catalog.findProduct(pend.productId);
    if (!product) return bot.sendMessage(chatId, '⚠️ Product missing.');
    const total = parseFloat((product.price * pend.qty).toFixed(2));
    if (u.balance < total) {
      return bot.sendMessage(chatId, `❌ You need ${formatBalance(total)}. Deposit first.`, {
        reply_markup: { inline_keyboard: [[{ text: '💰 Deposit', callback_data: 'deposit' }]] },
      });
    }
    if (!decrementSectionStock(pend.pathKey, pend.qty)) {
      return bot.sendMessage(chatId, '❌ Not enough stock. Try a lower quantity.', {
        reply_markup: { inline_keyboard: [[{ text: '🛒 Shop', callback_data: 'browse' }]] },
      });
    }
    const newBal = parseFloat((u.balance - total).toFixed(2));
    const purch = [...(u.purchases || [])];
    for (let i = 0; i < pend.qty; i += 1) purch.push(pend.productId);
    updateUser(userId, {
      balance: newBal,
      purchases: purch,
      state: null,
      qtyLeafPath: null,
      pendingSectionPurchase: null,
    });
    const db = loadDB();
    db.orders.push({
      userId,
      productId: pend.productId,
      productName: product.name,
      sellerUsername: product.sellerUsername || 'admin',
      price: total,
      qty: pend.qty,
      date: new Date().toISOString(),
    });
    saveDB(db);
    await bot.sendMessage(
      chatId,
      `🎉 *Purchase successful!*\n\n${product.name} × ${pend.qty}\nTotal: *${formatBalance(total)}*\n\nDelivering your file…`,
      { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
    );
    return await deliverPurchasedFiles(chatId, product, pend.qty);
  }

  // ── Product Detail ──
  if (data.startsWith('product_')) {
    const productId = data.replace('product_', '');
    const product = catalog.findProduct(productId);
    if (!product) return;

    const user = getUser(userId);
    const alreadyBought = user.purchases.includes(productId);
    const canAfford = user.balance >= product.price;

    let buttons = [];
    if (alreadyBought) {
      buttons = [[{ text: '📥 Download Again', callback_data: `download_${productId}` }]];
    } else if (canAfford) {
      buttons = [[{ text: `✅ Buy Now — ${formatBalance(product.price)}`, callback_data: `buy_${productId}` }]];
    } else {
      buttons = [[{ text: `💳 Deposit to Buy (need ${formatBalance(product.price)})`, callback_data: 'deposit' }]];
    }
    buttons.push([{ text: '🔙 Back to Store', callback_data: 'browse' }]);

    return bot.sendMessage(
      chatId,
      `*${product.name}*\n\n${product.description}\n\n💵 *Price:* ${formatBalance(product.price)}\n💰 *Your Balance:* ${formatBalance(user.balance)}${alreadyBought ? '\n\n✅ You already own this!' : ''}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  }

  // ── Buy Product ──
  if (data.startsWith('buy_')) {
    const productId = data.replace('buy_', '');
    const product = catalog.findProduct(productId);
    if (!product) return;

    const user = getUser(userId);

    if (user.purchases.includes(productId)) {
      return bot.sendMessage(chatId, '✅ You already own this file. Use "My Purchases" to download it.');
    }
    if (user.balance < product.price) {
      return bot.sendMessage(
        chatId,
        `❌ Insufficient balance.\n\nYou need ${formatBalance(product.price)} but have ${formatBalance(user.balance)}.\n\nPlease deposit first.`,
        { reply_markup: { inline_keyboard: [[{ text: '💰 Deposit Now', callback_data: 'deposit' }]] } }
      );
    }

    user.balance = parseFloat((user.balance - product.price).toFixed(2));
    user.purchases.push(productId);
    updateUser(userId, user);

    const db = loadDB();
    db.orders.push({
      userId,
      productId,
      productName: product.name,
      sellerUsername: product.sellerUsername || 'admin',
      price: product.price,
      qty: 1,
      date: new Date().toISOString(),
    });
    saveDB(db);

    await bot.sendMessage(chatId, `🎉 *Purchase successful!*\n\n${product.name}\n\nDelivering your file now...`, { parse_mode: 'Markdown' });
    return await deliverPurchasedFiles(chatId, product, 1);
  }

  // ── Download (re-deliver) ──
  if (data.startsWith('download_')) {
    const productId = data.replace('download_', '');
    const product = catalog.findProduct(productId);
    if (!product) return;
    const user = getUser(userId);
    if (!user.purchases.includes(productId)) {
      return bot.sendMessage(chatId, '❌ You do not own this file.');
    }
    return await deliverFile(chatId, product);
  }

  // ── Deposit: Show amount selection ──
  if (data === 'deposit') {
    return sendDepositIntro(chatId, userId);
  }

  // ── Deposit: Amount button tapped ──
  if (data.startsWith('dep_amount_')) {
    const amountStr = data.replace('dep_amount_', '');
    if (amountStr === 'custom') {
      updateUser(userId, { state: 'awaiting_deposit_amount' });
      return bot.sendMessage(
        chatId,
        `✏️ *Enter Deposit Amount*\n\nType the USD amount you want to deposit (minimum $${MIN_DEPOSIT}).\n\nExample: \`10\` or \`25.50\``,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'deposit' }]] },
        }
      );
    }
    const amount = parseFloat(amountStr);
    updateUser(userId, { state: `awaiting_currency:${amount}` });
    return bot.sendMessage(
      chatId,
      `💱 *Select Currency*\n\nDeposit amount: *$${amount.toFixed(2)} USD*\nChoose your preferred cryptocurrency:`,
      { parse_mode: 'Markdown', reply_markup: currencyKeyboard() }
    );
  }

  // ── Deposit: Currency → NOWPayments payment ─────────────────────────────────
  if (data.startsWith('dep_currency_')) {
    const currency = data.replace('dep_currency_', '');
    const user = getUser(userId);

    if (!user.state || !user.state.startsWith('awaiting_currency:')) {
      return bot.sendMessage(chatId, '⚠️ Session expired. Please start the deposit again.', {
        reply_markup: { inline_keyboard: [[{ text: '💰 Deposit', callback_data: 'deposit' }]] },
      });
    }

    const usdAmount = parseFloat(user.state.split(':')[1]);
    if (isNaN(usdAmount) || usdAmount <= 0) {
      updateUser(userId, { state: null });
      return bot.sendMessage(chatId, '⚠️ Invalid amount. Please start the deposit again.', {
        reply_markup: { inline_keyboard: [[{ text: '💰 Deposit', callback_data: 'deposit' }]] },
      });
    }
    if (usdAmount < MIN_DEPOSIT) {
      updateUser(userId, { state: null });
      return bot.sendMessage(
        chatId,
        `The minimum deposit here is <b>$${MIN_DEPOSIT}</b> USD.\n\nNeed to pay less? Contact support — they can help you finish your order.`,
        { parse_mode: 'HTML', reply_markup: supportOrSmallDepositKeyboard() }
      );
    }

    if (!process.env.NOWPAYMENTS_API_KEY) {
      return bot.sendMessage(
        chatId,
        'Deposits are temporarily unavailable. Please try again later or contact support.',
        { reply_markup: mainReplyKeyboard() }
      );
    }

    updateUser(userId, { state: null });
    await bot.sendMessage(chatId, '⏳ Creating your payment address...');

    try {
      await assertDepositMeetsNowPaymentsMinimum(usdAmount, currency);
      const payment = await createNowPayment(userId, usdAmount, currency);

      if (!payment.payment_id || !payment.pay_address) {
        const apiMsg = payment.message || JSON.stringify(payment);
        if (/too small|amountTo/i.test(String(apiMsg))) {
          throw new Error(
            'That amount is too small for this cryptocurrency.\n\nTry USDT (TRC20) or a higher USD amount (often $20+ for BTC/ETH).'
          );
        }
        throw new Error(apiMsg);
      }

      const db = loadDB();
      db.pendingPayments.push({
        paymentId:  payment.payment_id,
        userId,
        usdAmount,
        currency,
        payAddress: payment.pay_address,
        payAmount:  payment.pay_amount,
        status:     payment.payment_status || 'waiting',
        createdAt:  new Date().toISOString(),
      });
      saveDB(db);

      if (isNowPaymentsSandbox()) {
        setImmediate(() => {
          checkPendingPayments().catch((e) => console.error('[poll]', e.message));
        });
      }

      const currencyLabel = DEPOSIT_CURRENCIES.find((c) => c.value === currency)?.label || currency.toUpperCase();

      const sandboxNote = isNowPaymentsSandbox()
        ? `\n🧪 *Sandbox:* no real transfer needed — status simulates as *\`${process.env.NOWPAYMENTS_SANDBOX_CASE || 'success'}\`*; balance should update within ~${Math.ceil(PAYMENT_POLL_MS / 1000)}s.\n`
        : '';

      return bot.sendMessage(
        chatId,
        `📤 *Payment created*\n\n` +
          `💵 *$${usdAmount.toFixed(2)} USD*\n` +
          `💱 *${currencyLabel}*\n` +
          `🔢 Send: *${payment.pay_amount} ${currency.toUpperCase()}*\n\n` +
          `📬 *Address:*\n\`${payment.pay_address}\`\n\n` +
          `⏱ Expires in about *60 minutes*.\n\n` +
          `✅ Your balance updates *automatically* once the payment is confirmed.` +
          sandboxNote,
        { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
      );
    } catch (err) {
      console.error('[deposit] Error creating payment:', err.message);
      return bot.sendMessage(
        chatId,
        `❌ Payment could not be created\n\n${err.message}\n\nTry USDT (TRC20) or a higher USD amount.`,
        { reply_markup: mainReplyKeyboard() }
      );
    }
  }

  // ── Account ──
  if (data === 'account') {
    return sendAccount(chatId, userId);
  }

  // ── My Purchases ──
  if (data === 'my_purchases') {
    return sendMyPurchases(chatId, userId);
  }
});

// ─── File Delivery ────────────────────────────────────────────────────────────

/** Paths in catalog.json can be relative to this project folder or absolute. */
function resolveProductFsPath(relOrAbs) {
  if (!relOrAbs) return null;
  const s = String(relOrAbs).trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  return path.join(__dirname, s);
}

function safeZipFilename(name) {
  const base = String(name || 'download').replace(/[^\w\- ().]/g, '_').slice(0, 80);
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

function zipFolderToTempZip(absFolder, productId) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `tg-deliver-${productId}-${Date.now()}.zip`);
    const output = fs.createWriteStream(tmp);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const onErr = (e) => reject(e);
    output.on('error', onErr);
    output.on('close', () => resolve(tmp));
    archive.on('error', onErr);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') console.warn('[archiver]', err.message);
    });
    archive.pipe(output);
    archive.directory(absFolder, false);
    archive.finalize();
  });
}

function syncProductStock(productId, count) {
  for (const node of catalog.listStoreNodes()) {
    const hit = catalog.resolveStoreNode(node.path);
    if (hit?.node && (hit.node.productIds || []).includes(productId)) {
      catalog.updateStoreNode(node.path, { quantityAvailable: count });
    }
  }
}

async function deliverPurchasedFiles(chatId, product, qty = 1) {
  const inventory = productInventoryFiles(product);
  if (!inventory) return deliverFile(chatId, product);

  const count = Math.max(1, Math.floor(Number(qty) || 1));
  if (inventory.length < count) {
    return bot.sendMessage(
      chatId,
      `📥 *${product.name}*\n\n⚠️ Only ${inventory.length} delivery file(s) are available right now.`,
      { parse_mode: 'Markdown' }
    );
  }

  const selected = inventory.slice(0, count);

  for (let i = 0; i < selected.length; i += 1) {
    const fp = selected[i];
    await bot.sendDocument(chatId, fs.createReadStream(fp), {
      caption: `📥 *${product.name}*${selected.length > 1 ? `\n\nFile ${i + 1} of ${selected.length}` : ''}`,
      parse_mode: 'Markdown',
    }, {
      filename: path.basename(fp),
      contentType: 'application/zip',
    });
    fs.unlinkSync(fp);
  }

  syncProductStock(product.id, Math.max(0, inventory.length - selected.length));

  return null;
}

async function deliverFile(chatId, product) {
  const captionZip = `📥 *${product.name}*\n\nThank you for your purchase — your files are in the ZIP below.`;
  let tempZip = null;
  try {
    const deliveryZip = resolveProductFsPath(product.deliveryZipPath);
    if (deliveryZip && fs.existsSync(deliveryZip)) {
      const st = fs.statSync(deliveryZip);
      if (st.isFile()) {
        return bot.sendDocument(chatId, fs.createReadStream(deliveryZip), {
          caption: captionZip,
          parse_mode: 'Markdown',
        }, {
          filename: safeZipFilename(path.basename(deliveryZip)),
          contentType: 'application/zip',
        });
      }
    }

    const folder = resolveProductFsPath(product.deliveryFolder);
    if (folder && fs.existsSync(folder)) {
      const st = fs.statSync(folder);
      if (st.isDirectory()) {
        const names = fs.readdirSync(folder);
        if (!names.length) {
          return bot.sendMessage(
            chatId,
            `📥 *${product.name}*\n\n⚠️ The delivery folder is empty. Add files to:\n\`${folder}\``,
            { parse_mode: 'Markdown' }
          );
        }
        tempZip = await zipFolderToTempZip(folder, product.id);
        return bot.sendDocument(chatId, fs.createReadStream(tempZip), {
          caption: captionZip,
          parse_mode: 'Markdown',
        }, {
          filename: safeZipFilename(product.name),
          contentType: 'application/zip',
        });
      }
    }

    const fp = resolveProductFsPath(product.filePath);
    if (fp && fs.existsSync(fp)) {
      const isZip = fp.toLowerCase().endsWith('.zip');
      if (!isZip) {
        return bot.sendMessage(
          chatId,
          `📥 *${product.name}*\n\n⚠️ This product is not a ZIP yet. Ask the admin or seller to upload a ZIP file.`,
          { parse_mode: 'Markdown' }
        );
      }
      return bot.sendDocument(chatId, fs.createReadStream(fp), {
        caption: captionZip,
        parse_mode: 'Markdown',
      }, {
        filename: path.basename(fp),
        contentType: 'application/zip',
      });
    }

    return bot.sendMessage(
      chatId,
      `📥 *${product.name}*\n\n⚠️ Nothing to send yet. Upload a ready-made .zip file for this listing.\n\nYour purchase is still recorded ✅`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('[deliverFile]', e.message);
    return bot.sendMessage(
      chatId,
      `📥 *${product.name}*\n\n⚠️ Could not prepare the download: ${e.message}`,
      { parse_mode: 'Markdown' }
    );
  } finally {
    if (tempZip && fs.existsSync(tempZip)) {
      try {
        fs.unlinkSync(tempZip);
      } catch (_) {}
    }
  }
}

// ─── Admin Commands ───────────────────────────────────────────────────────────

// /credit <userId> <amount>
bot.onText(/\/credit (\d+) ([\d.]+)/, (msg, match) => {
  if (String(msg.from.id) !== process.env.ADMIN_CHAT_ID) return;
  const targetId = match[1];
  const amount = parseFloat(match[2]);
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Invalid amount.');
  const user = getUser(targetId);
  user.balance = parseFloat((user.balance + amount).toFixed(2));
  updateUser(targetId, user);
  bot.sendMessage(msg.chat.id, `✅ Credited $${amount.toFixed(2)} to user ${targetId}. New balance: $${user.balance.toFixed(2)}`);
  bot.sendMessage(
    targetId,
    `💰 *Your balance has been topped up!*\n\nAmount added: *$${amount.toFixed(2)}*\nNew balance: *$${user.balance.toFixed(2)}*\n\n🎉`,
    { parse_mode: 'Markdown', reply_markup: mainReplyKeyboard() }
  );
});

// /balance <userId>
bot.onText(/\/balance (\d+)/, (msg, match) => {
  if (String(msg.from.id) !== process.env.ADMIN_CHAT_ID) return;
  const user = getUser(match[1]);
  bot.sendMessage(msg.chat.id, `User ${match[1]} balance: $${user.balance.toFixed(2)}`);
});

// /orders — last 10 orders
bot.onText(/\/orders/, (msg) => {
  if (String(msg.from.id) !== process.env.ADMIN_CHAT_ID) return;
  const db = loadDB();
  const recent = db.orders.slice(-10).reverse();
  if (!recent.length) return bot.sendMessage(msg.chat.id, 'No orders yet.');
  const text = recent.map((o) => `• User ${o.userId} → ${o.productId} — $${o.price} @ ${o.date}`).join('\n');
  bot.sendMessage(msg.chat.id, `📦 *Recent Orders:*\n\n${text}`, { parse_mode: 'Markdown' });
});

// /payments — active crypto deposits (admin)
bot.onText(/\/payments/, (msg) => {
  if (String(msg.from.id) !== process.env.ADMIN_CHAT_ID) return;
  const db = loadDB();
  const active = db.pendingPayments.filter((p) => !FINAL_STATUSES.has(p.status));
  if (!active.length) return bot.sendMessage(msg.chat.id, '✅ No active pending deposits.');
  const text = active
    .map((p) => `• User \`${p.userId}\` — $${p.usdAmount} ${p.currency.toUpperCase()} — *${p.status}*\n  ID: \`${p.paymentId}\``)
    .join('\n\n');
  bot.sendMessage(msg.chat.id, `⏳ *Active payments (${active.length}):*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot
  .deleteWebHook()
  .then(() => {
    bot.startPolling();
    console.log('🤖 Telegram polling started.');
    setTimeout(() => {
      checkPendingPayments().catch((e) => console.error('[poll startup]', e.message));
    }, 2000);
  })
  .catch((err) => {
    console.error('FATAL: could not delete webhook / start polling:', err.message);
    process.exit(1);
  });

bot
  .setMyCommands([
    { command: 'start', description: 'Welcome with menu' },
    { command: 'menu', description: 'Main menu' },
    { command: 'browse', description: 'Open shop' },
    { command: 'deposit', description: 'Deposit crypto to your balance' },
    { command: 'account', description: 'Balance & user ID' },
    { command: 'purchases', description: 'Your files / orders' },
  ])
  .then(() => console.log('✅ Bot command menu (/) registered'))
  .catch((err) => console.error('[setMyCommands]', err.message));

if (!process.env.NOWPAYMENTS_API_KEY) {
  console.warn('[deposit] NOWPAYMENTS_API_KEY missing — deposits disabled until set.');
} else {
  console.log(`[deposit] NOWPayments → https://${NOWPAYMENTS_API_HOST}/v1`);
}
