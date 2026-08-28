/* debug.js —— 观察一局联机牌桌的状态流转，用于排查卡死 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const PLAYERS = parseInt(process.argv[2] || '3', 10);
const SECONDS = parseInt(process.argv[3] || '40', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const h = {};
    const c = {
      tag, ws, name: null, lastState: null, roomId: null,
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      on(t, f) { (h[t] = h[t] || []).push(f); },
      wait(t) { return new Promise(res => (h[t] = h[t] || []).push(res)); }
    };
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'auth' && m.ok) c.name = m.user.name;
      if (m.type === 'state') c.lastState = m;
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'error') console.log('  ! [' + tag + '] ' + m.msg);
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async function () {
  const clients = [];
  for (let i = 0; i < PLAYERS; i++) clients.push(await makeClient('D' + (i + 1)));
  for (const c of clients) {
    c.send({ type: 'register', name: c.tag + '_' + Math.random().toString(36).slice(2, 6), password: 'test123456' });
    await c.wait('auth');
  }
  const host = clients[0];
  host.send({ type: 'createRoom', title: 'debug', sb: 5, bb: 10, buyIn: 1000 });
  await host.wait('joined');
  for (let i = 1; i < clients.length; i++) { clients[i].send({ type: 'joinRoom', roomId: host.roomId }); await clients[i].wait('joined'); }
  for (let i = 0; i < clients.length; i++) { clients[i].send({ type: 'sit', seat: i, amount: 1000 }); await sleep(150); }
  await sleep(400);

  clients.forEach(c => {
    let lastKey = '';
    c.on('state', m => {
      const act = m.table && m.table.you ? m.table.you.act : null;
      if (!act) return;
      const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
      if (key === lastKey) return;
      lastKey = key;
      const L = act.legal;
      const r = Math.random();
      if (L.toCall > 0 && r < 0.2) c.send({ type: 'action', action: { type: 'fold' } });
      else if (r > 0.92 && L.canRaise) c.send({ type: 'action', action: { type: 'raise', total: L.minTotal } });
      else c.send({ type: 'action', action: { type: 'call' } });
      console.log('  → ' + c.name + ' ' + (L.toCall > 0 ? 'call' : 'check'));
    });
  });

  host.send({ type: 'start' });
  const t0 = Date.now();
  let lastSig = '';
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(1000);
    const s = host.lastState;
    if (!s) continue;
    const t = s.table;
    const cur = t.currentIdx >= 0 ? (t.seats[t.currentIdx] || {}).name : '-';
    const sig = [s.room.status, s.room.handCount, t.phase, cur, t.pot].join('|');
    const sum = t.seats.reduce((a, x) => a + (x.chips || 0), 0) + (t.pot || 0);
    if (sig !== lastSig || sum !== PLAYERS * 1000) {
      lastSig = sig;
      console.log('[' + Math.round((Date.now() - t0) / 1000) + 's] ' + sig +
        ' 合计=' + sum + (sum === PLAYERS * 1000 ? '' : '  ⚠️漂移 ' + (sum - PLAYERS * 1000)) +
        '  ' + t.seats.filter(x => x.name).map(x => x.name.slice(0, 4) + ':' + x.chips).join(' '));
    }
  }
  const before = host.lastState.table.seats.reduce((a, x) => a + x.chips, 0) + host.lastState.table.pot;
  console.log('\n停止前合计 = ' + before);
  host.send({ type: 'stop' });
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (host.lastState.room.status !== 'playing') break;
  }
  await sleep(400);
  const after = host.lastState.table.seats.reduce((a, x) => a + x.chips, 0) + host.lastState.table.pot;
  console.log('停止后合计 = ' + after + (after === before ? '  ✓' : '  ✗ 差 ' + (after - before)));
  console.log('最后日志：');
  (host.lastState.logs || []).slice(-8).forEach(l => console.log('   ' + l.text));
  clients.forEach(c => c.ws.close());
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
