const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADMIN_PATH = '/admin/catalog';
const AUTH_COOKIE = 'catalog_admin_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const ADMIN_STATE_PATH = path.join(__dirname, 'admin-state.json');

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(ADMIN_STATE_PATH, 'utf8'));
    return {
      revokedSellers: Array.isArray(raw.revokedSellers) ? raw.revokedSellers : [],
      activity: Array.isArray(raw.activity) ? raw.activity : [],
      sellers: Array.isArray(raw.sellers) ? raw.sellers : [],
    };
  } catch {
    return { revokedSellers: [], activity: [], sellers: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(ADMIN_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sessionSecret() {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    process.env.ADMIN_CATALOG_TOKEN ||
    process.env.BOT_TOKEN ||
    'change-me-admin-session-secret'
  );
}

function configuredUsers({ includeRevoked = false } = {}) {
  const users = [];
  const state = readState();
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_CATALOG_TOKEN;
  if (adminPassword) users.push({ username: adminUsername, password: adminPassword, role: 'admin' });

  const sellerUsername = process.env.SELLER_USERNAME;
  const sellerPassword = process.env.SELLER_PASSWORD;
  if (sellerUsername && sellerPassword) users.push({ username: sellerUsername, password: sellerPassword, role: 'seller' });

  const sellerUsers = String(process.env.SELLER_USERS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of sellerUsers) {
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    users.push({
      username: item.slice(0, idx).trim(),
      password: item.slice(idx + 1).trim(),
      role: 'seller',
    });
  }

  for (const seller of state.sellers) {
    users.push({
      username: String(seller.username || '').trim(),
      passwordHash: seller.passwordHash,
      salt: seller.salt,
      role: 'seller',
      createdAt: seller.createdAt,
      createdBy: seller.createdBy,
    });
  }

  const revoked = new Set(state.revokedSellers);
  return users
    .filter((u) => u.username && (u.password || (u.passwordHash && u.salt)))
    .map((u) => ({ ...u, revoked: u.role === 'seller' && revoked.has(u.username) }))
    .filter((u) => includeRevoked || !u.revoked);
}

function listSellers() {
  return configuredUsers({ includeRevoked: true }).filter((u) => u.role === 'seller');
}

function findUser(username, password) {
  const cleanUsername = String(username || '');
  const cleanPassword = String(password || '');
  for (const user of configuredUsers()) {
    if (!timingSafeEqualString(user.username, cleanUsername)) continue;
    if (user.password && timingSafeEqualString(user.password, cleanPassword)) return user;
    if (user.passwordHash && user.salt && verifyPassword(cleanPassword, user.salt, user.passwordHash)) return user;
  }
  return null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, passwordHash: hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password || ''), salt, 64);
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signSession(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

function createSessionCookie(user) {
  const payload = Buffer.from(
    JSON.stringify({
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
    })
  ).toString('base64url');
  return `${payload}.${signSession(payload)}`;
}

function readSession(req) {
  const raw = parseCookies(req)[AUTH_COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [payload, sig] = raw.split('.', 2);
  if (!timingSafeEqualString(sig, signSession(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.username || !['admin', 'seller'].includes(session.role)) return null;
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    if (session.role === 'seller' && !configuredUsers().some((u) => u.username === session.username)) return null;
    return session;
  } catch {
    return null;
  }
}

function authCookieHeader(sessionValue) {
  return `${AUTH_COOKIE}=${encodeURIComponent(sessionValue)}; HttpOnly; SameSite=Lax; Path=${ADMIN_PATH}; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearAuthCookieHeader() {
  return `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=${ADMIN_PATH}; Max-Age=0`;
}

function revokeSeller(username, actor = 'admin') {
  const clean = String(username || '').trim();
  if (!clean) throw new Error('Choose a seller to revoke');
  const sellers = listSellers();
  if (!sellers.some((s) => s.username === clean)) throw new Error('Seller not found');
  const state = readState();
  if (!state.revokedSellers.includes(clean)) state.revokedSellers.push(clean);
  saveState(state);
  recordActivity({ actor, action: 'revoke_seller', detail: `Revoked seller access: ${clean}` });
}

function createSeller({ username, password, actor = 'admin' }) {
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '').trim();
  if (!cleanUsername) throw new Error('Seller username is required');
  if (cleanUsername.length < 3) throw new Error('Seller username must be at least 3 characters');
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUsername)) throw new Error('Seller username can only use letters, numbers, dots, dashes, and underscores');
  if (cleanPassword.length < 6) throw new Error('Seller password must be at least 6 characters');
  if (configuredUsers({ includeRevoked: true }).some((u) => u.username === cleanUsername)) {
    throw new Error('That username already exists');
  }

  const state = readState();
  const { salt, passwordHash } = hashPassword(cleanPassword);
  state.sellers.push({
    username: cleanUsername,
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
    createdBy: actor,
  });
  state.revokedSellers = state.revokedSellers.filter((name) => name !== cleanUsername);
  saveState(state);
  recordActivity({ actor, action: 'create_seller', detail: `Created seller account: ${cleanUsername}` });
  return { username: cleanUsername, role: 'seller' };
}

function recordActivity(entry) {
  const state = readState();
  state.activity.unshift({
    at: new Date().toISOString(),
    actor: entry.actor || 'system',
    role: entry.role || '',
    action: entry.action || 'update',
    detail: entry.detail || '',
  });
  state.activity = state.activity.slice(0, 200);
  saveState(state);
}

function getActivity(limit = 50) {
  return readState().activity.slice(0, limit);
}

module.exports = {
  ADMIN_PATH,
  configuredUsers,
  listSellers,
  findUser,
  createSessionCookie,
  readSession,
  authCookieHeader,
  clearAuthCookieHeader,
  createSeller,
  revokeSeller,
  recordActivity,
  getActivity,
};
