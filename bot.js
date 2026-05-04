require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const https = require('https');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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

// ─── Product Catalog ──────────────────────────────────────────────────────────
const PRODUCTS = [
  {
    id: 'p1',
    name: '📘 Airbnb Revenue Playbook',
    description: 'Step-by-step guide to maximize your short-term rental income.',
    price: 5.00,
    fileId: null,
    filePath: null,
  },
  {
    id: 'p2',
    name: '📊 Host Finance Spreadsheet',
    description: 'Complete P&L, expense tracker & tax-ready template.',
    price: 8.00,
    fileId: null,
    filePath: null,
  },
  {
    id: 'p3',
    name: '🚀 Listing Optimization Checklist',
    description: 'Boost your visibility and conversion rate on Airbnb.',
    price: 3.00,
    fileId: null,
    filePath: null,
  },
];

const MIN_DEPOSIT = 1.00;

// ─── NOWPayments API ──────────────────────────────────────────────────────────
const DEPOSIT_CURRENCIES = [
  { label: 'USDT (TRC20)', value: 'usdttrc20' },
  { label: 'USDT (ERC20)', value: 'usdterc20' },
  { label: 'BTC',          value: 'btc'        },
  { label: 'ETH',          value: 'eth'        },
  { label: 'LTC',          value: 'ltc'        },
  { label: 'TRX',          value: 'trx'        },
];

// Terminal statuses — no need to poll these again
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
          reject(new Error(`NOWPayments returned invalid JSON: ${data.slice(0, 200)}`));
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

async function getNowPaymentStatus(paymentId) {
  return nowPaymentsRequest('GET', `/payment/${paymentId}`);
}

// ─── Automatic Payment Polling (every 60 s) ───────────────────────────────────
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
        // Credit the user
        const user = db.users[p.userId] || { balance: 0, purchases: [], state: null };
        user.balance = parseFloat((user.balance + p.usdAmount).toFixed(2));
        db.users[p.userId] = user;

        bot.sendMessage(
          p.userId,
          `✅ *Payment Confirmed!*\n\n*+$${p.usdAmount.toFixed(2)} USD* has been credited to your balance.\nNew balance: *$${user.balance.toFixed(2)}*\n\nYou can now purchase files! 🎉`,
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );

        if (process.env.ADMIN_CHAT_ID) {
          bot.sendMessage(
            process.env.ADMIN_CHAT_ID,
            `✅ Auto-credited *$${p.usdAmount.toFixed(2)}* to user \`${p.userId}\` (NOWPayments ID: \`${p.paymentId}\`)`,
            { parse_mode: 'Markdown' }
          );
        }
      } else if (newStatus === 'failed' || newStatus === 'expired') {
        bot.sendMessage(
          p.userId,
          `❌ *Payment ${newStatus}*\n\nYour deposit of *$${p.usdAmount.toFixed(2)}* was ${newStatus}. Please try depositing again.`,
          { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
        );
      }
    } catch (err) {
      console.error(`[poll] Error checking payment ${p.paymentId}:`, err.message);
    }
  }

  if (changed) {
    // Keep all active + last 100 finalized for history
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

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🛒 Browse Files',    callback_data: 'browse'       }],
      [{ text: '💰 Deposit Crypto',  callback_data: 'deposit'      }],
      [{ text: '👤 My Account',      callback_data: 'account'      }],
      [{ text: '📦 My Purchases',    callback_data: 'my_purchases' }],
    ],
  };
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
  const name = msg.from.first_name || 'there';
  getUser(userId);
  bot.sendMessage(
    msg.chat.id,
    `👋 *Welcome, ${name}!*\n\nThis is the official file store. Browse our digital products, deposit crypto, and download instantly after purchase.\n\n*What would you like to do?*`,
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
});

// ─── Message Handler (custom deposit amount input) ────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  const user = getUser(userId);
  if (!user.state || user.state !== 'awaiting_deposit_amount') return;

  const amount = parseFloat(msg.text.trim().replace(/[^0-9.]/g, ''));
  if (isNaN(amount) || amount < MIN_DEPOSIT) {
    return bot.sendMessage(
      msg.chat.id,
      `⚠️ Please enter a valid amount of at least $${MIN_DEPOSIT}.\n\nExample: \`10\` or \`25.50\``,
      { parse_mode: 'Markdown' }
    );
  }

  updateUser(userId, { state: `awaiting_currency:${amount}` });
  return bot.sendMessage(
    msg.chat.id,
    `💱 *Select Currency*\n\nDeposit amount: *$${amount.toFixed(2)} USD*\nChoose your preferred cryptocurrency:`,
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
    return bot.sendMessage(chatId, '🏠 *Main Menu*', {
      parse_mode: 'Markdown',
      reply_markup: mainMenuKeyboard(),
    });
  }

  // ── Browse Products ──
  if (data === 'browse') {
    const rows = PRODUCTS.map((p) => [
      { text: `${p.name} — ${formatBalance(p.price)}`, callback_data: `product_${p.id}` },
    ]);
    rows.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
    return bot.sendMessage(chatId, '📂 *Available Files*\n\nSelect a product to view details:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
  }

  // ── Product Detail ──
  if (data.startsWith('product_')) {
    const productId = data.replace('product_', '');
    const product = PRODUCTS.find((p) => p.id === productId);
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
    const product = PRODUCTS.find((p) => p.id === productId);
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
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return;
    const user = getUser(userId);
    if (!user.purchases.includes(productId)) {
      return bot.sendMessage(chatId, '❌ You do not own this file.');
    }
    return deliverFile(chatId, product);
  }

  // ── Deposit: Show amount selection ──
  if (data === 'deposit') {
    updateUser(userId, { state: null });
    return bot.sendMessage(
      chatId,
      `💰 *Deposit Funds*\n\nPayments are processed *automatically* via NOWPayments — your balance is credited as soon as the blockchain confirms.\n\nMinimum deposit: *$${MIN_DEPOSIT}*\n\nHow much would you like to deposit?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '$5',  callback_data: 'dep_amount_5'  }, { text: '$10', callback_data: 'dep_amount_10' }],
            [{ text: '$20', callback_data: 'dep_amount_20' }, { text: '$50', callback_data: 'dep_amount_50' }],
            [{ text: '✏️ Custom Amount', callback_data: 'dep_amount_custom' }],
            [{ text: '🔙 Back', callback_data: 'main_menu' }],
          ],
        },
      }
    );
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

  // ── Deposit: Currency selected → create NOWPayments payment ──
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

    updateUser(userId, { state: null });
    await bot.sendMessage(chatId, '⏳ Creating your payment address...');

    try {
      const payment = await createNowPayment(userId, usdAmount, currency);

      if (!payment.payment_id || !payment.pay_address) {
        throw new Error(payment.message || JSON.stringify(payment));
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
        `📤 *Payment Created!*\n\n` +
        `💵 You are depositing: *$${usdAmount.toFixed(2)} USD*\n` +
        `💱 Pay with: *${currencyLabel}*\n` +
        `🔢 Amount to send: *${payment.pay_amount} ${currency.toUpperCase()}*\n\n` +
        `📬 *Send to this address:*\n\`${payment.pay_address}\`\n\n` +
        `⏱ Payment expires in *60 minutes.*\n\n` +
        `✅ Your balance will be credited *automatically* once confirmed on the blockchain. No further action needed!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Main Menu',              callback_data: 'main_menu' }],
              [{ text: '💰 Create Another Deposit', callback_data: 'deposit'   }],
            ],
          },
        }
      );
    } catch (err) {
      console.error('[deposit] Error creating payment:', err.message);
      return bot.sendMessage(
        chatId,
        `❌ *Payment creation failed*\n\n\`${err.message}\`\n\nPlease check your NOWPayments API key or try again.`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
      );
    }
  }

  // ── Account ──
  if (data === 'account') {
    const user = getUser(userId);
    const db = loadDB();
    const activePays = db.pendingPayments.filter(
      (p) => p.userId === userId && !FINAL_STATUSES.has(p.status)
    );
    const pendingText = activePays.length
      ? `\n⏳ Pending deposits: *${activePays.length}*`
      : '';
    return bot.sendMessage(
      chatId,
      `👤 *Your Account*\n\n🆔 User ID: \`${userId}\`\n💰 Balance: *${formatBalance(user.balance)}*\n📦 Purchases: *${user.purchases.length} files*${pendingText}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Deposit',   callback_data: 'deposit'   }],
            [{ text: '🔙 Main Menu', callback_data: 'main_menu' }],
          ],
        },
      }
    );
  }

  // ── My Purchases ──
  if (data === 'my_purchases') {
    const user = getUser(userId);
    if (user.purchases.length === 0) {
      return bot.sendMessage(chatId, "📦 You haven't purchased anything yet.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛒 Browse Files', callback_data: 'browse'    }],
            [{ text: '🔙 Main Menu',    callback_data: 'main_menu' }],
          ],
        },
      });
    }
    const rows = user.purchases.map((pid) => {
      const p = PRODUCTS.find((x) => x.id === pid);
      return [{ text: `📥 ${p ? p.name : pid}`, callback_data: `download_${pid}` }];
    });
    rows.push([{ text: '🔙 Main Menu', callback_data: 'main_menu' }]);
    return bot.sendMessage(chatId, '📦 *Your Purchases*\n\nTap any file to download:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
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
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
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

// /payments — active NOWPayments deposits
bot.onText(/\/payments/, (msg) => {
  if (String(msg.from.id) !== process.env.ADMIN_CHAT_ID) return;
  const db = loadDB();
  const active = db.pendingPayments.filter((p) => !FINAL_STATUSES.has(p.status));
  if (!active.length) return bot.sendMessage(msg.chat.id, '✅ No active pending payments.');
  const text = active
    .map((p) => `• User \`${p.userId}\` — $${p.usdAmount} ${p.currency.toUpperCase()} — *${p.status}*\n  ID: \`${p.paymentId}\``)
    .join('\n\n');
  bot.sendMessage(msg.chat.id, `⏳ *Active Payments (${active.length}):*\n\n${text}`, { parse_mode: 'Markdown' });
});

console.log('🤖 Bot is running with NOWPayments integration...');
