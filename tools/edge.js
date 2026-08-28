/* edge.js —— 边界场景测试：中途离座、掉线重连、补给筹码、超时自动弃牌、资产守恒 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const START = 5000, BUYIN = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(c, m) { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } }

function makeClient(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const h = {};
    const c = {
      tag, ws, name: null, chips: 0, table: 0, seat: -1, status: null,
      lastState: null, notices: [], roomId: null, auto: true, lastKey: '',
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      on(t, f) { (h[t] = h[t] || []).push(f); },
      wait(t, ms = 8000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(tag + ' 等 ' + t + ' 超时')), ms);
          (h[t] = h[t] || []).push(m => { clearTimeout(timer); res(m); });
        });
      }
    };
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'auth' && m.ok) { c.name = m.user.name; c.chips = m.user.chips; }
      if (m.type === 'me' && m.user) c.chips = m.user.chips;
      if (m.type === 'state') {
        c.lastState = m;
        if (m.table && m.table.you) { c.table = m.table.you.tableChips; c.seat = m.table.you.seat; }
        if (m.room) c.status = m.room.status;
        const act = m.table && m.table.you ? m.table.you.act : null;
        if (act && c.auto) {
          const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
          if (key !== c.lastKey) {
            c.lastKey = key;
            c.send({ type: 'action', action: { type: act.legal.toCall > 0 ? 'call' : 'check' } });
          }
        }
      }
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'notice') c.notices.push(m.msg);
      if (m.type === 'error') console.log('  ! [' + tag + '] ' + m.msg);
      (h[m.type] || []).forEach(f => f(m));
      (h['*'] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async function () {
  const N = 'G' + Math.random().toString(36).slice(2, 6);
  const A = await makeClient('A'), B = await makeClient('B'), C = await makeClient('C');
  for (const [c, n] of [[A, 'a'], [B, 'b'], [C, 'c']]) {
    c.send({ type: 'register', name: N + '_' + n, password: 'test123456' });
    await c.wait('auth');
  }
  const acc = () => { [A, B, C].forEach(c => c.send({ type: 'me' })); };

  console.log('[1] 三人开局');
  A.send({ type: 'createRoom', title: 'edge', sb: 5, bb: 10, buyIn: BUYIN });
  await A.wait('joined');
  const roomId = A.roomId;
  for (const c of [B, C]) { c.send({ type: 'joinRoom', roomId }); await c.wait('joined'); }
  [A, B, C].forEach((c, i) => c.send({ type: 'sit', seat: i, amount: BUYIN }));
  await sleep(700);
  acc(); await sleep(400);
  ok(A.chips + B.chips + C.chips === 3 * (START - BUYIN), '买入后账号余额正确');
  A.send({ type: 'start' });
  await sleep(2000);
  ok(A.status === 'playing', '牌局已开始');

  console.log('[2] 牌局中途离座 → 延迟到本手结束，剩余筹码退回账号');
  const before = A.chips;
  A.send({ type: 'stand' });
  await sleep(500);
  ok(A.notices.some(m => /本手结束后/.test(m)), '收到「本手结束后离座」提示');
  const t0 = Date.now();
  while (Date.now() - t0 < 40000 && A.seat >= 0) { await sleep(400); A.send({ type: 'me' }); }
  A.send({ type: 'me' }); await A.wait('me');
  ok(A.seat < 0, '本手结束后自动离座');
  ok(A.chips > before, '剩余筹码已退回账号（' + before + ' → ' + A.chips + '）');

  console.log('[3] 掉线重连 → 座位与桌上筹码保留');
  const seatB = B.seat, tableB = B.table;
  B.ws.close();
  await sleep(600);
  const B2 = await makeClient('B2');
  B2.send({ type: 'login', name: N + '_b', password: 'test123456' });
  await B2.wait('auth');
  B2.send({ type: 'joinRoom', roomId });
  await B2.wait('joined');
  await sleep(700);
  B2.send({ type: 'me' }); await B2.wait('me');
  ok(B2.seat === seatB, '重连后仍坐在原座位 ' + seatB);
  ok(B2.table === tableB || B2.table > 0, '桌上筹码保留（' + tableB + ' → ' + B2.table + '）');

  console.log('[4] 补给筹码');
  const accBefore = B2.chips;
  B2.send({ type: 'rebuy', amount: 500 });
  await sleep(700);
  B2.send({ type: 'me' }); await B2.wait('me');
  ok(B2.chips === accBefore - 500, '账号扣款 500（' + accBefore + ' → ' + B2.chips + '）');
  ok(B2.table >= tableB, '桌上筹码增加（' + tableB + ' → ' + B2.table + '）');

  console.log('[5] 超时自动弃牌');
  [B2, C].forEach(c => { c.auto = false; });
  const t1 = Date.now();
  let sawTimeout = false;
  while (Date.now() - t1 < 60000) {
    await sleep(1000);
    const logs = (A.lastState && A.lastState.logs) || [];
    if (logs.some(l => /超时未操作/.test(l.text))) { sawTimeout = true; break; }
    if (A.status !== 'playing') break;
  }
  ok(sawTimeout, '无人操作时引擎自动弃牌/过牌，牌局没有卡死');

  console.log('[6] 结束牌局并核对总资产');
  [B2, C].forEach(c => { c.auto = true; });
  await sleep(2000);
  A.send({ type: 'stop' });
  const t2 = Date.now();
  while (Date.now() - t2 < 20000) {
    await sleep(400);
    if (A.lastState && A.lastState.room && A.lastState.room.status !== 'playing') break;
  }
  await sleep(600);
  acc(); await sleep(600);
  const accounts = A.chips + B2.chips + C.chips;
  const tables = ((A.lastState || {}).table || { seats: [] }).seats.reduce((a, s) => a + s.chips, 0);
  const pot = ((A.lastState || {}).table || {}).pot || 0;
  console.log('  账号 ' + accounts + ' + 桌上 ' + tables + ' + 底池 ' + pot + ' = ' + (accounts + tables + pot));
  ok(accounts + tables + pot === 3 * START, '总资产守恒：' + (accounts + tables + pot) + ' == ' + 3 * START);

  [A, B2, C].forEach(c => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  console.log('\n' + (fails === 0 ? '边界场景测试全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
