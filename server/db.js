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

const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 登录状态有效期（README 承诺的 30 天）
const MAX_SESSIONS = 5000;                   // 会话上限，防止无限增长
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** 数据文件所在目录必须存在。POKER_DATA 指向一个还没创建的目录时，
 *  如果只是「写不进去就换下一个候选」，最后会静默退化成「全部只存内存」——
 *  看起来一切正常，重启后所有账号和资产全没了。这里先把目录建好。 */
function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { console.error('[db] 无法创建数据目录 ' + path.dirname(file) + '：' + e.message); }
}
ensureDir(BASE_FILE);

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

/** 测试账号默认不播种：公网部署留下 test1/test123 这种固定口令等于开后门。
 *  需要时显式开启：POKER_SEED=1（口令取 POKER_SEED_PW，未设则随机生成并打印一次）。 */
const SEED_ACCOUNTS = process.env.POKER_SEED === '1'
  ? [{ name: 'test1', pw: process.env.POKER_SEED_PW || '' },
     { name: 'test2', pw: process.env.POKER_SEED_PW || '' }]
  : [];

function seedDefaults() {
  for (const a of SEED_ACCOUNTS) {
    const k = key(a.name);
    if (db.users[k]) continue;
    const salt = crypto.randomBytes(16).toString('hex');
    const pw = a.pw || crypto.randomBytes(6).toString('hex');
    db.users[k] = {
      key: k, name: a.name, salt, hash: hashPassword(pw, salt),
      chips: START_CHIPS, createdAt: Date.now(),
      stats: { hands: 0, won: 0 }, seeded: true
    };
    console.log('[db] 已播种测试账号 ' + a.name + '，密码：' + pw + '（仅在本次播种时显示）');
  }
  if (SEED_ACCOUNTS.length) save();
}

let saveTimer = null, saveWarned = false;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = FILE + '.tmp';
    try {
      // 先写临时文件再 rename：直接覆盖 users.json 时若写到一半崩溃，
      // 整个账号库就损坏了（等于所有人资产归零）。rename 在同一分区内是原子的。
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      if (!saveWarned) {
        saveWarned = true;
        console.error('[db] 无法写入 ' + FILE + '（' + e.code + '）。数据仍在内存中可用，但重启后会丢失。');
      }
    }
  }, 200);
}

const key = name => String(name).trim().toLowerCase();

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }).toString('hex');
}

/** 异步版哈希：scrypt 很吃 CPU，同步版会把事件循环整个卡住（所有牌桌的行动计时跟着停），
 *  登录/注册走这条路径。参数与同步版一致，哈希值兼容。 */
function hashPasswordAsync(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (err, dk) => err ? reject(err) : resolve(dk.toString('hex')));
  });
}

function verify(u, pw) {
  const h = hashPassword(pw, u.salt);
  return safeEqual(h, u.hash);
}
async function verifyAsync(u, pw) {
  return safeEqual(await hashPasswordAsync(pw, u.salt), u.hash);
}
function safeEqual(hexA, hexB) {
  const a = Buffer.from(String(hexA), 'hex'), b = Buffer.from(String(hexB || ''), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  if (!u) return null;
  return {
    name: u.name, chips: u.chips, createdAt: u.createdAt,
    stats: u.stats || { hands: 0, won: 0 }
  };
}

function checkName(name) {
  if (name.length < 2 || name.length > 12) return '昵称需 2–12 个字符';
  if (!/^[一-龥a-zA-Z0-9_\-]+$/.test(name)) return '昵称只能含中英文、数字、下划线和连字符';
  return null;
}

/** 注册（异步：密码哈希走 scrypt 的异步接口，不阻塞事件循环） */
async function register(name, pw) {
  name = String(name || '').trim();
  pw = String(pw || '');
  const bad = checkName(name);
  if (bad) return { error: bad };
  if (pw.length < 6) return { error: '密码至少 6 位' };
  if (pw.length > 256) return { error: '密码过长' };
  if (db.users[key(name)]) return { error: '该昵称已被注册' };

  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    key: key(name), name, salt, hash: await hashPasswordAsync(pw, salt),
    chips: START_CHIPS, createdAt: Date.now(),
    stats: { hands: 0, won: 0 }
  };
  db.users[u.key] = u;
  save();
  return { ok: true, user: publicUser(u), token: newSession(u) };
}

/** 登录（异步；失败原因统一，避免被用来枚举昵称） */
async function login(name, pw) {
  const u = db.users[key(String(name || '').trim())];
  if (!u) {
    // 账号不存在时也跑一次哈希，耗时与真实校验接近，避免用响应时间判断昵称是否存在
    await hashPasswordAsync(String(pw || ''), DUMMY_SALT);
    return { error: '昵称或密码错误' };
  }
  if (!(await verifyAsync(u, pw))) return { error: '昵称或密码错误' };
  return { ok: true, user: publicUser(u), token: newSession(u) };
}
const DUMMY_SALT = '00000000000000000000000000000000';

function newSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { key: u.key, ts: Date.now() };
  pruneSessions();
  save();
  return token;
}

/** 清理过期会话；会话数超过上限时淘汰最旧的。防止 sessions 只增不减。 */
function pruneSessions() {
  const now = Date.now();
  const keys = Object.keys(db.sessions);
  for (const t of keys) {
    const s = db.sessions[t];
    if (!s || now - (s.ts || 0) > SESSION_TTL) delete db.sessions[t];
  }
  const left = Object.keys(db.sessions);
  if (left.length > MAX_SESSIONS) {
    left.sort((a, b) => (db.sessions[a].ts || 0) - (db.sessions[b].ts || 0));
    left.slice(0, left.length - MAX_SESSIONS).forEach(t => delete db.sessions[t]);
  }
}

function userByToken(token) {
  const s = db.sessions[token];
  if (!s) return null;
  if (Date.now() - (s.ts || 0) > SESSION_TTL) {
    delete db.sessions[token];
    save();
    return null;
  }
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

// 启动时先清一遍历史遗留的过期会话，再按需播种测试账号
pruneSessions();
seedDefaults();

module.exports = {
  START_CHIPS, MIN_BUYIN, MAX_BUYIN, SESSION_TTL,
  register, login, logout, userByToken, publicUser, getUser,
  addChips, recordHand, leaderboard,
  _db: db, _save: save
};
