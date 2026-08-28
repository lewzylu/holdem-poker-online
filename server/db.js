/* db.js —— 账号与资产存储（JSON 文件持久化，密码用 node:crypto scrypt 哈希，零外部依赖） */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BASE_FILE = process.env.POKER_DATA || path.join(DATA_DIR, 'users.json');
const START_CHIPS = 5000;          // 注册赠送
const MIN_BUYIN = 100;
const MAX_BUYIN = 5000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** 挑一个真正可写的数据文件：有时 users.json 会被别的进程锁住（Windows 上很常见），
 *  这时自动换到 -1/-2，避免整个服务因为写不了档而出现奇怪问题。 */
function pickFile() {
  const cands = [BASE_FILE, BASE_FILE.replace(/\.json$/, '-1.json'), BASE_FILE.replace(/\.json$/, '-2.json')];
  for (const f of cands) {
    try {
      // 试探写入：已有文件要能覆盖，新文件要能创建
      fs.writeFileSync(f, fs.existsSync(f) ? fs.readFileSync(f) : '{"users":{},"sessions":{}}');
      return f;
    } catch (e) { /* 换下一个 */ }
  }
  return BASE_FILE;
}
const FILE = pickFile();

let db = { users: {}, sessions: {} };
try {
  if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('[db] 读取失败，使用空库：', e.message);
}
db.users = db.users || {};
db.sessions = db.sessions || {};

/** 默认保留两个测试账号，启动自动播种（若已存在则跳过，不会覆盖既有密码/资产）。
 *  方便随时登录验证功能，无需重复注册。改密或删号不影响逻辑，下次启动若缺失会重新补上。 */
const SEED_ACCOUNTS = [
  { name: 'test1', pw: 'test123' },
  { name: 'test2', pw: 'test123' }
];
function seedDefaults() {
  for (const a of SEED_ACCOUNTS) {
    const k = key(a.name);
    if (db.users[k]) continue;
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[k] = {
      key: k, name: a.name, salt, hash: hashPassword(a.pw, salt),
      chips: START_CHIPS, createdAt: Date.now(),
      stats: { hands: 0, won: 0 }, seeded: true
    };
  }
  save();
}

let saveTimer = null, saveWarned = false;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      if (!saveWarned) {
        saveWarned = true;
        console.error('[db] 无法写入 ' + FILE + '（' + e.code + '）。数据仍在内存中可用，但重启后会丢失。');
      }
    }
  }, 200);
}

const key = name => String(name).trim().toLowerCase();

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verify(u, pw) {
  const h = hashPassword(pw, u.salt);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  if (!u) return null;
  return {
    name: u.name, chips: u.chips, createdAt: u.createdAt,
    stats: u.stats || { hands: 0, won: 0 }
  };
}

function register(name, pw) {
  name = String(name || '').trim();
  pw = String(pw || '');
  if (name.length < 2 || name.length > 12) return { error: '昵称需 2–12 个字符' };
  if (!/^[一-龥a-zA-Z0-9_\-]+$/.test(name)) return { error: '昵称只能含中英文、数字、下划线和连字符' };
  if (pw.length < 6) return { error: '密码至少 6 位' };
  if (db.users[key(name)]) return { error: '该昵称已被注册' };

  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    key: key(name), name, salt, hash: hashPassword(pw, salt),
    chips: START_CHIPS, createdAt: Date.now(),
    stats: { hands: 0, won: 0 }
  };
  db.users[u.key] = u;
  save();
  return { ok: true, user: publicUser(u), token: newSession(u) };
}

function login(name, pw) {
  const u = db.users[key(name)];
  if (!u) return { error: '账号不存在' };
  if (!verify(u, pw)) return { error: '密码错误' };
  return { ok: true, user: publicUser(u), token: newSession(u) };
}

function newSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { key: u.key, ts: Date.now() };
  save();
  return token;
}

function userByToken(token) {
  const s = db.sessions[token];
  if (!s) return null;
  return db.users[s.key] || null;
}

function logout(token) { delete db.sessions[token]; save(); }

/** 增减账号余额，余额不足返回 false */
function addChips(name, delta) {
  const u = db.users[key(name)];
  if (!u) return false;
  if (u.chips + delta < 0) return false;
  u.chips += delta;
  save();
  return true;
}

function recordHand(name, won) {
  const u = db.users[key(name)];
  if (!u) return;
  u.stats.hands++;
  if (won > 0) u.stats.won++;
  save();
}

function leaderboard(n = 20) {
  return Object.values(db.users)
    .map(publicUser)
    .sort((a, b) => b.chips - a.chips)
    .slice(0, n);
}

function getUser(name) { return db.users[key(name)] || null; }

// 启动时确保两个测试账号存在（缺则补，已有则不动）
seedDefaults();

module.exports = {
  START_CHIPS, MIN_BUYIN, MAX_BUYIN,
  register, login, logout, userByToken, publicUser, getUser,
  addChips, recordHand, leaderboard,
  _db: db, _save: save
};
