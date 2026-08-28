/* server.js —— 德州扑克联机服务端
 *
 * HTTP：静态页面（登录 / 大厅 / 牌桌）
 * WS  ：认证、房间、牌局全部走一条长连接
 *
 * 启动：node server/server.js   默认端口 3000，可用 PORT 环境变量覆盖
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const db = require('./db.js');
const { Room } = require('./room.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', '..', 'poker');   // 复用单机版的 cards.js / engine.js / style.css

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const ROUTES = { '/': 'index.html', '/lobby': 'lobby.html', '/table': 'table.html', '/game': 'table.html' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok ' + rooms.size + ' rooms / ' + sockets.size + ' online');
  }
  let file;
  if (ROUTES[url]) file = path.join(PUBLIC_DIR, ROUTES[url]);
  else if (url.startsWith('/shared/')) file = path.join(SHARED_DIR, url.slice('/shared/'.length));
  else file = path.join(PUBLIC_DIR, url.replace(/^\/+/, ''));

  file = path.normalize(file);
  if (!file.startsWith(PUBLIC_DIR) && !file.startsWith(SHARED_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- 在线状态 ---------------- */
const sockets = new Map();          // name -> Set<ws>
const rooms = new Map();            // roomId -> Room
const wsMeta = new Map();           // ws -> { name, roomId, alive }

function online(name) {
  const s = sockets.get(name);
  return !!s && s.size > 0;
}
function send(name, msg) {
  const s = sockets.get(name);
  if (!s) return;
  const data = JSON.stringify(msg);
  for (const ws of s) { try { ws.send(data); } catch (e) { /* ignore */ } }
}
function sendWs(ws, msg) {
  try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
}
function newRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混淆的 I/O/0/1
  let id;
  do {
    id = Array.from(crypto.randomBytes(6)).map(b => chars[b % chars.length]).join('');
  } while (rooms.has(id));
  return id;
}

const ctx = {
  online,
  send,
  getUser: name => db.getUser(name)
};

/* ---------------- 消息处理 ---------------- */
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  wsMeta.set(ws, { name: null, roomId: null, alive: true });
  ws.on('pong', () => { const m = wsMeta.get(ws); if (m) m.alive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg || {}); }
    catch (e) { console.error('[msg]', msg && msg.type, e); sendWs(ws, { type: 'error', msg: '服务端出错：' + e.message }); }
  });

  ws.on('close', () => onClose(ws));
  ws.on('error', () => { try { ws.close(); } catch (e) { /* ignore */ } });
});

function requireAuth(ws) {
  const m = wsMeta.get(ws);
  if (!m || !m.name) { sendWs(ws, { type: 'error', msg: '请先登录' }); return null; }
  return m;
}

function handle(ws, msg) {
  const m = wsMeta.get(ws);
  switch (msg.type) {
    /* ---- 账号 ---- */
    case 'register':
    case 'login': {
      const r = msg.type === 'register' ? db.register(msg.name, msg.password) : db.login(msg.name, msg.password);
      if (r.error) return sendWs(ws, { type: 'auth', ok: false, error: r.error });
      m.name = r.user.name;
      addSocket(r.user.name, ws);
      return sendWs(ws, { type: 'auth', ok: true, token: r.token, user: r.user });
    }
    case 'resume': {
      const u = db.userByToken(msg.token);
      if (!u) return sendWs(ws, { type: 'auth', ok: false, error: '登录已失效' });
      m.name = u.name;
      addSocket(u.name, ws);
      return sendWs(ws, { type: 'auth', ok: true, token: msg.token, user: db.publicUser(u) });
    }
    case 'logout': {
      if (m.name) removeSocket(m.name, ws);
      if (msg.token) db.logout(msg.token);
      m.name = null;
      return sendWs(ws, { type: 'auth', ok: false });
    }
    case 'me': {
      if (!m.name) return sendWs(ws, { type: 'me', user: null });
      // 反查用户实际所在的房间：刷新页面 / 新标签页时这条连接的 roomId 是空的，
      // 但用户仍在房间的成员列表里。不反查会让前端误判「不在房间」而反复跳转。
      if (!m.roomId) {
        for (const [id, r] of rooms) {
          if (r.members.has(m.name)) { m.roomId = id; break; }
        }
      }
      const room = m.roomId ? rooms.get(m.roomId) : null;
      if (!room) m.roomId = null;
      sendWs(ws, { type: 'me', user: db.publicUser(db.getUser(m.name)), room: m.roomId || null });
      // 补发一次房间状态，刷新页面后能立刻看到牌桌
      if (room) room.broadcast();
      return;
    }

    /* ---- 房间 ---- */
    case 'listRooms': {
      if (!requireAuth(ws)) return;
      return sendWs(ws, {
        type: 'rooms',
        rooms: [...rooms.values()].map(r => r.brief()),
        board: db.leaderboard(10)
      });
    }
    case 'createRoom': {
      const a = requireAuth(ws); if (!a) return;
      const id = newRoomId();
      const room = new Room(id, {
        host: a.name,
        title: String(msg.title || (a.name + '的牌局')).slice(0, 20),
        sb: clampInt(msg.sb, 1, 500, 5),
        bb: clampInt(msg.bb, 2, 1000, 10),
        buyIn: clampInt(msg.buyIn, db.MIN_BUYIN, db.MAX_BUYIN, 1000)
      }, ctx);
      if (room.bb < room.sb * 2) room.bb = room.sb * 2;
      rooms.set(id, room);
      room.join(a.name);
      a.roomId = id;
      return sendWs(ws, { type: 'joined', roomId: id });
    }
    case 'joinRoom': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(String(msg.roomId || '').toUpperCase());
      if (!room) return sendWs(ws, { type: 'error', msg: '房间不存在' });
      if (a.roomId && a.roomId !== room.id) leaveRoom(a.name, a);
      room.join(a.name);
      a.roomId = room.id;
      return sendWs(ws, { type: 'joined', roomId: room.id });
    }
    case 'leaveRoom': {
      const a = requireAuth(ws); if (!a) return;
      leaveRoom(a.name, a);
      return sendWs(ws, { type: 'left' });
    }
    case 'sit': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return sendWs(ws, { type: 'error', msg: '不在房间内' });
      const r = room.sit(a.name, parseInt(msg.seat, 10), msg.amount);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      return;
    }
    case 'stand': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      const r = room.stand(a.name);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      else if (r.deferred) sendWs(ws, { type: 'notice', msg: '正在牌局中，已为你弃牌，本手结束后自动离座' });
      return;
    }
    case 'rebuy': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      const r = room.rebuy(a.name, msg.amount);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      return;
    }
    case 'start': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      const r = room.start(a.name);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      return;
    }
    case 'stop': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      const r = room.stop(a.name);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      return;
    }
    case 'action': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      const r = room.submitAction(a.name, msg.action);
      if (r.error) sendWs(ws, { type: 'error', msg: r.error });
      return;
    }
    case 'chat': {
      const a = requireAuth(ws); if (!a) return;
      const room = rooms.get(a.roomId); if (!room) return;
      room.say(a.name, msg.text);
      room.broadcast();
      return;
    }
    case 'ping': return sendWs(ws, { type: 'pong' });
    default: return;
  }
}

function clampInt(v, min, max, dft) {
  v = parseInt(v, 10);
  if (isNaN(v)) return dft;
  return Math.max(min, Math.min(max, v));
}

function addSocket(name, ws) {
  if (!sockets.has(name)) sockets.set(name, new Set());
  sockets.get(name).add(ws);
}
function removeSocket(name, ws) {
  const s = sockets.get(name);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) {
    sockets.delete(name);
    // 通知所在房间：这个人已离线
    for (const room of rooms.values()) {
      if (room.members.has(name)) { room.onDisconnect(name); room.broadcast(); }
    }
  }
}
function leaveRoom(name, m) {
  const room = rooms.get(m.roomId);
  m.roomId = null;
  if (!room) return;
  room.leave(name);
  if (room.members.size === 0) {
    room.refundAll();
    rooms.delete(room.id);
  }
}

function onClose(ws) {
  const m = wsMeta.get(ws);
  wsMeta.delete(ws);
  if (!m) return;
  if (m.name) removeSocket(m.name, ws);
  // 所有连接都断了才算离开房间
  if (m.name && m.roomId && !online(m.name)) {
    const room = rooms.get(m.roomId);
    if (room) {
      room.pushLog(m.name + ' 掉线', 'system');
      room.broadcast();
      setTimeout(() => {
        if (!online(m.name)) {
          const r = rooms.get(m.roomId);
          if (r && r.members.has(m.name)) leaveRoom(m.name, { roomId: m.roomId });
        }
      }, 60000);   // 掉线保留座位 60 秒
    }
  }
}

/* 心跳：清理死连接 */
setInterval(() => {
  for (const ws of wss.clients) {
    const m = wsMeta.get(ws);
    if (m && m.alive === false) { try { ws.terminate(); } catch (e) { /* ignore */ } continue; }
    if (m) m.alive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000).unref();

server.listen(PORT, HOST, () => {
  const nets = [];
  const os = require('os');
  Object.values(os.networkInterfaces()).forEach(list => {
    (list || []).forEach(n => { if (n.family === 'IPv4' && !n.internal) nets.push(n.address); });
  });
  console.log('==============================================');
  console.log(' 德州扑克联机服务已启动');
  console.log(' 本机访问：  http://localhost:' + PORT);
  nets.forEach(ip => console.log(' 同网访问：  http://' + ip + ':' + PORT));
  console.log('==============================================');
});

module.exports = { server, rooms, sockets };
