require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
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

bot.on('polling_error', (err) => {
  console.error('[polling_error]', err.code || '', err.message);
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
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getUser(userId) {
  const db = loadDB();
  if (!db.users[userId]) {
    db.users[userId] = { balance: 0, purchases: [], state: null };
    saveDB(db);
  }
  if (db.users[userId].state === undefined) db.users[userId].state = null;
  return db.users[userId];
}

function updateUser(userId, data) {
  const db = loadDB();
  db.users[userId] = { ...db.users[userId], ...data };
  saveDB(db);
}

/** Edit welcome HTML for /start. Use {{name}} for the user's first name (already escaped). */
const WELCOME_MESSAGE_TEMPLATE = `👋 <b>Welcome, {{name}}!</b>

Use the <b>keyboard below</b> — Browse, Deposit, Account, Purchases — or the <b>☰</b> menu for commands.

Add funds, pick a product from the shop, and download your files instantly.`;

// Products & shop layout live in catalog.json (see catalog.js). Admin UI: /admin/catalog

const MIN_DEPOSIT = 10; // USD — minimum deposit amount in the bot

// ─── NOWPayments API ──────────────────────────────────────────────────────────
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
      hostname: 'api.nowpayments.io',
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
  return nowPaymentsRequest('POST', '/payment', {
    price_amount: usdAmount,
    price_currency: 'usd',
    pay_currency: currency,
    order_id: `${userId}_${Date.now()}`,
    order_description: `Balance deposit for user ${userId}`,
    is_fixed_rate: false,
    is_fee_paid_by_user: true,
  });
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
      const newStatus = result.payment_status;
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

setInterval(checkPendingPayments, 60 * 1000);

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

/** Bottom reply keyboard (Telegram “menu” under the message box) */
const MENU = {
  BROWSE: '🛒 Browse',
  DEPOSIT: '💰 Deposit',
  ACCOUNT: '👤 Account',
  PURCHASES: '📦 Purchases',
  HIDE: '✕ Hide keyboard',
};

function mainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: MENU.BROWSE }, { text: MENU.DEPOSIT }],
      [{ text: MENU.ACCOUNT }, { text: MENU.PURCHASES }],
      [{ text: MENU.HIDE }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function sendMainMenu(chatId) {
  return bot.sendMessage(
    chatId,
    `🏠 <b>Main menu</b>\n\nEverything runs from the <b>keyboard under the chat</b> — tap a row below.`,
    { parse_mode: 'HTML', reply_markup: mainReplyKeyboard() }
  );
}

function sendBrowse(chatId) {
  return sendBrowseAt(chatId, []);
}

function sendBrowseAt(chatId, parts) {
  const r = catalog.resolveStore(parts);
  if (!r) {
    return bot.sendMessage(chatId, '⚠️ That section is not available. Open the shop again.', {
      reply_markup: { inline_keyboard: [[{ text: '🛒 Shop', callback_data: 'browse' }]] },
    });
  }

  const rows = [];
  let body = '📂 <b>Shop</b>';

  if (r.kind === 'root') {
    body += '\n\nChoose a <b>category</b>:';
    for (const c of catalog.getStore()) {
      rows.push([{ text: c.name, callback_data: catalog.encodeStorePath([c.id]) }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  } else if (r.kind === 'cat') {
    body += `\n\n${escapeHtml(r.cat.name)}\nPick a <b>subcategory</b>:`;
    for (const s of r.cat.subs || []) {
      rows.push([{ text: s.name, callback_data: catalog.encodeStorePath([parts[0], s.id]) }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: 'browse' }]);
  } else if (r.kind === 'sub') {
    body += `\n\n${escapeHtml(r.sub.name)}\nPick a <b>section</b>:`;
    for (const ss of r.sub.subs || []) {
      rows.push([{ text: ss.name, callback_data: catalog.encodeStorePath([parts[0], parts[1], ss.id]) }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: catalog.encodeStorePath([parts[0]]) }]);
  } else if (r.kind === 'leaf') {
    const list = r.subsub.productIds
      .map((id) => catalog.findProduct(id))
      .filter(Boolean);
    body += `\n\n${escapeHtml(r.subsub.name)}\nPick a <b>product</b>:`;
    for (const p of list) {
      rows.push([{ text: `${p.name} — ${formatBalance(p.price)}`, callback_data: `product_${p.id}` }]);
    }
    rows.push([{ text: '🔙 Back', callback_data: catalog.encodeStorePath(r.parentPath) }]);
  }

  return bot.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

function sendDepositIntro(chatId, userId) {
  updateUser(userId, { state: null });
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
          [{ text: '🛒 Browse', callback_data: 'browse' }],
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
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  const name = escapeHtml(msg.from.first_name || 'there');
  getUser(userId);
  const text = WELCOME_MESSAGE_TEMPLATE.replace(/\{\{name\}\}/g, name);
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', reply_markup: mainReplyKeyboard() });
});

// ─── Slash shortcuts (also listed in Telegram’s ☰ command menu) ───────────────
bot.onText(/^\/menu$/i, (msg) => {
  getUser(msg.from.id);
  sendMainMenu(msg.chat.id);
});
bot.onText(/^\/browse$/i, (msg) => {
  getUser(msg.from.id);
  sendBrowse(msg.chat.id);
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

  if (text === MENU.HIDE) {
    return bot.sendMessage(chatId, 'Keyboard hidden. Send /start or /menu to open it again.', {
      reply_markup: { remove_keyboard: true },
    });
  }

  if (text === MENU.BROWSE) {
    getUser(userId);
    return sendBrowse(chatId);
  }
  if (text === MENU.DEPOSIT) {
    getUser(userId);
    return sendDepositIntro(chatId, userId);
  }
  if (text === MENU.ACCOUNT) {
    getUser(userId);
    return sendAccount(chatId, userId);
  }
  if (text === MENU.PURCHASES) {
    getUser(userId);
    return sendMyPurchases(chatId, userId);
  }

  const user = getUser(userId);

  if (!user.state || user.state !== 'awaiting_deposit_amount') return;

  const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
  if (isNaN(amount) || amount < MIN_DEPOSIT) {
    return bot.sendMessage(
      chatId,
      `⚠️ Enter a valid amount (at least $${MIN_DEPOSIT}).\n\nExample: 10 or 25.50`,
      { reply_markup: mainReplyKeyboard() }
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

  // ── Main Menu ──
  if (data === 'main_menu') {
    return sendMainMenu(chatId);
  }

  // ── Browse shop (categories → sub → sub-sub → products) ──
  if (data === 'browse') {
    return sendBrowseAt(chatId, []);
  }
  if (data.startsWith('st:')) {
    return sendBrowseAt(chatId, catalog.decodeStorePath(data));
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
    db.orders.push({ userId, productId, price: product.price, date: new Date().toISOString() });
    saveDB(db);

    await bot.sendMessage(chatId, `🎉 *Purchase successful!*\n\n${product.name}\n\nDelivering your file now...`, { parse_mode: 'Markdown' });
    return deliverFile(chatId, product);
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
    return deliverFile(chatId, product);
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
    if (isNaN(usdAmount) || usdAmount < MIN_DEPOSIT) {
      updateUser(userId, { state: null });
      return bot.sendMessage(chatId, '⚠️ Invalid amount. Please start the deposit again.', {
        reply_markup: { inline_keyboard: [[{ text: '💰 Deposit', callback_data: 'deposit' }]] },
      });
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

      const currencyLabel = DEPOSIT_CURRENCIES.find((c) => c.value === currency)?.label || currency.toUpperCase();

      return bot.sendMessage(
        chatId,
        `📤 *Payment created*\n\n` +
          `💵 *$${usdAmount.toFixed(2)} USD*\n` +
          `💱 *${currencyLabel}*\n` +
          `🔢 Send: *${payment.pay_amount} ${currency.toUpperCase()}*\n\n` +
          `📬 *Address:*\n\`${payment.pay_address}\`\n\n` +
          `⏱ Expires in about *60 minutes*.\n\n` +
          `✅ Your balance updates *automatically* once the payment is confirmed.`,
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
async function deliverFile(chatId, product) {
  if (product.fileId) {
    return bot.sendDocument(chatId, product.fileId, {
      caption: `📥 *${product.name}*\n\nThank you for your purchase!`,
      parse_mode: 'Markdown',
    });
  }
  if (product.filePath && fs.existsSync(product.filePath)) {
    return bot.sendDocument(chatId, fs.createReadStream(product.filePath), {}, {
      filename: path.basename(product.filePath),
      contentType: 'application/octet-stream',
    });
  }
  return bot.sendMessage(
    chatId,
    `📥 *${product.name}*\n\n⚠️ File delivery is being set up by the admin. You will receive it shortly.\n\nYour purchase is recorded ✅`,
    { parse_mode: 'Markdown' }
  );
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
  })
  .catch((err) => {
    console.error('FATAL: could not delete webhook / start polling:', err.message);
    process.exit(1);
  });

bot
  .setMyCommands([
    { command: 'start', description: 'Welcome & open keyboard' },
    { command: 'menu', description: 'Main menu' },
    { command: 'browse', description: 'Browse products' },
    { command: 'deposit', description: 'Deposit crypto to your balance' },
    { command: 'account', description: 'Balance & user ID' },
    { command: 'purchases', description: 'Your files' },
  ])
  .then(() => console.log('✅ Bot command menu (/) registered'))
  .catch((err) => console.error('[setMyCommands]', err.message));

if (!process.env.NOWPAYMENTS_API_KEY) {
  console.warn('[deposit] NOWPAYMENTS_API_KEY missing — deposits disabled until set.');
}
