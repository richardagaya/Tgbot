# 🤖 Telegram File Store Bot

A Telegram bot where users can deposit crypto and buy digital files instantly.

---

## Features
- 🛒 Product catalog with descriptions & prices
- 💰 Crypto deposit flow (USDT, BTC, ETH, etc.)
- ✅ Auto-delivery of files after purchase
- 👤 Per-user balance & purchase history
- 🔐 Admin commands to credit balances & view orders

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
- `BOT_TOKEN` — get from [@BotFather](https://t.me/BotFather)
- `ADMIN_CHAT_ID` — get your ID from [@userinfobot](https://t.me/userinfobot)

### 3. Add your products
Edit the `PRODUCTS` array in `bot.js`:
```js
{
  id: 'p1',
  name: '📘 My eBook',
  description: 'A great ebook.',
  price: 5.00,
  fileId: null,      // paste Telegram file_id here (see below)
  filePath: null,    // or local path e.g. './files/ebook.pdf'
}
```

### 4. Add your crypto wallet addresses
Edit `CRYPTO_ADDRESSES` in `bot.js`:
```js
const CRYPTO_ADDRESSES = {
  USDT_TRC20: 'TYourAddressHere',
  BTC: 'bc1YourAddressHere',
};
```

### 5. Run the bot
```bash
npm start
```

---

## How to get a Telegram file_id

1. Start your bot and send the file to it manually (as a document)
2. The bot will log the incoming message — copy the `file_id` from the document object
3. Paste it into the `fileId` field of the matching product

OR: Upload the file to a private Telegram channel, forward it to your bot, and capture the file_id.

---

## Admin Commands

Run these by messaging your bot directly (only works for your ADMIN_CHAT_ID):

| Command | Description |
|---|---|
| `/credit 123456789 10.00` | Add $10 to user's balance |
| `/balance 123456789` | Check user's balance |
| `/orders` | Show last 10 orders |

---

## Deposit Flow

1. User taps **Deposit Crypto**
2. Selects coin → sees your wallet address
3. Sends crypto from their wallet
4. Taps **"I've Sent Payment"** → you get notified
5. You verify the transaction on the blockchain
6. Run `/credit <userId> <amount>` to credit their balance
7. User can now buy files instantly

---

## Deployment (Free Options)

### Railway
```bash
# Push to GitHub, connect repo to Railway
# Set BOT_TOKEN and ADMIN_CHAT_ID as environment variables
```

### Render
- Create a new Web Service → connect GitHub repo
- Set start command: `node bot.js`
- Add environment variables in dashboard

### Local (testing)
```bash
npm run dev   # uses nodemon for auto-reload
```

---

## File Structure
```
telegram-file-bot/
├── bot.js          # Main bot logic
├── db.json         # Auto-created user/order database
├── .env            # Your secrets (never commit this)
├── .env.example    # Template
└── package.json
```
# Tgbot
