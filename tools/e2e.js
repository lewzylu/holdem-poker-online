/* e2e.js —— 联机端到端测试：起 N 个机器人客户端，注册 → 开房 → 坐下 → 自动打牌
 * 校验：全程无服务端错误、牌局能推进、账号资产 + 桌上筹码 + 底池 总额守恒
 *
 * 用法：先启动服务端，再 node tools/e2e.js [玩家数] [目标手数]
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const PLAYERS = parseInt(process.argv[2] || '4', 10);
const TARGET_HANDS = parseInt(process.argv[3] || '20', 10);
const BUYIN = 1000;
const START_CHIPS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(cond, msg) { if (cond) console.log('  ✓ ' + msg); else { fails++; console.log('  ✗ ' + msg); } }

function makeClient(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const h = {};
    const c = {
      tag, ws, name: null, chips: 0, lastState: null, error: null, roomId: null,
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      on(t, f) { (h[t] = h[t] || []).push(f); },
      wait(t, timeout = 8000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(tag + ' 等待 ' + t + ' 超时')), timeout);
          (h[t] = h[t] || []).push(m => { clearTimeout(timer); res(m); });
        });
      }
    };
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'auth' && m.ok) { c.name = m.user.name; c.chips = m.user.chips; }
      if (m.type === 'me' && m.user) { c.chips = m.user.chips; }
      if (m.type === 'state') c.lastState = m;
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'error') { c.error = m.msg; console.log('  ! [' + tag + '] 服务端报错：' + m.msg); }
      (h[m.type] || []).forEach(f => f(m));
      (h['*'] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async function () {
  console.log('[1] 连接服务端 ' + URL);
  const clients = [];
  for (let i = 0; i < PLAYERS; i++) clients.push(await makeClient('P' + (i + 1)));
  ok(clients.length === PLAYERS, PLAYERS + ' 个客户端已连接');

  console.log('[2] 注册账号');
  for (const c of clients) {
    const name = c.tag + '_' + Math.random().toString(36).slice(2, 6);
    c.send({ type: 'register', name, password: 'test123456' });
    await c.wait('auth');
  }
  ok(clients.every(c => c.name), '全部注册成功：' + clients.map(c => c.name).join('、'));
  ok(clients.every(c => c.chips === START_CHIPS), '注册赠送筹码均为 ' + START_CHIPS);

  console.log('[3] 开房与入座');
  const host = clients[0];
  host.send({ type: 'createRoom', title: 'E2E 测试局', sb: 5, bb: 10, buyIn: BUYIN });
  await host.wait('joined');
  const roomId = host.roomId;
  ok(!!roomId, '房间已创建：' + roomId);

  for (let i = 1; i < clients.length; i++) {
    clients[i].send({ type: 'joinRoom', roomId });
    await clients[i].wait('joined');
  }
  for (let i = 0; i < clients.length; i++) {
    clients[i].send({ type: 'sit', seat: i, amount: BUYIN });
    await sleep(200);
  }
  // 等服务端广播同步（轮询而不是固定 sleep，避免偶发的时序误判）
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const n = (host.lastState.table.seats || []).filter(s => s.name).length;
    if (n >= clients.length) break;
  }
  const seated = host.lastState.table.seats.filter(s => s.name).length;
  ok(seated === PLAYERS, PLAYERS + ' 人全部入座（实际 ' + seated + '）');
  const tableTotal = host.lastState.table.seats.reduce((a, s) => a + s.chips, 0);
  ok(tableTotal === PLAYERS * BUYIN, '桌上筹码合计 ' + tableTotal);

  console.log('[4] 开局并自动打 ' + TARGET_HANDS + ' 手');
  // 自动行动
  let acted = 0;
  clients.forEach((c, idx) => {
    let lastKey = '';
    c.on('state', m => {
      const act = m.table && m.table.you ? m.table.you.act : null;
      if (!act) return;
      const key = act.deadline + ':' + m.table.handCount;
      if (key === lastKey) return;
      lastKey = key;
      acted++;
      const L = act.legal;
      const r = Math.random();
      if (L.toCall > 0 && r < 0.22) c.send({ type: 'action', action: { type: 'fold' } });
      else if (r > 0.9 && L.canRaise) c.send({ type: 'action', action: { type: 'raise', total: L.minTotal } });
      else c.send({ type: 'action', action: { type: 'call' } });
    });
  });

  host.send({ type: 'start' });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(500);
    const hc = host.lastState && host.lastState.room ? host.lastState.room.handCount : 0;
    if (hc >= TARGET_HANDS) break;
    if (host.lastState && host.lastState.room.status !== 'playing') break;
  }
  const handCount = host.lastState.room.handCount;
  ok(handCount >= TARGET_HANDS, '完成 ' + handCount + ' 手（目标 ' + TARGET_HANDS + '）');
  ok(acted > handCount, '共产生 ' + acted + ' 次玩家操作');

  console.log('[5] 结束牌局并核对资产');
  host.send({ type: 'stop' });
  // 等房间真正回到 waiting（结算展示 6.5s + 引擎收尾）
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    await sleep(300);
    if (host.lastState && host.lastState.room && host.lastState.room.status !== 'playing') break;
  }
  await sleep(500);
  for (const c of clients) { c.send({ type: 'me' }); await c.wait('me'); }
  const accountTotal = clients.reduce((a, c) => a + c.chips, 0);
  const tableLeft = (host.lastState.table.seats || []).reduce((a, s) => a + s.chips, 0);
  const potLeft = host.lastState.table.pot || 0;
  const total = accountTotal + tableLeft + potLeft;
  console.log('  账号余额合计 = ' + accountTotal + '，桌上剩余 = ' + tableLeft + '，底池 = ' + potLeft);
  ok(total === PLAYERS * START_CHIPS, '资产守恒：' + total + ' == ' + PLAYERS * START_CHIPS);
  ok(clients.every(c => !c.error), '全程无服务端错误');

  console.log('[6] 退出并核对落库');
  for (const c of clients) { c.send({ type: 'stand' }); }
  await sleep(1500);
  for (const c of clients) { c.send({ type: 'me' }); await c.wait('me'); }
  const after = clients.reduce((a, c) => a + c.chips, 0);
  ok(after === PLAYERS * START_CHIPS, '全部站起后资产守恒：' + after);

  clients.forEach(c => c.ws.close());
  console.log('\n' + (fails === 0 ? '端到端测试全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
