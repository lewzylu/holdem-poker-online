/* room-rules-test.js —— 房间规则三件套的回归
 * A. 建房可设行动超时（秒，0=不限）：state 下发一致
 * B. 连续超时 3 次被请离座位：本手结束后座位清空、筹码退回账号
 * C. 牌局中加入的座位，下一手强制上桌大盲（正好轮到大盲位的免交）
 * 用法：node tools/room-rules-test.js（服务端需已启动）
 */
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:3000/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } };

function client(name) {
  const ws = new WebSocket(URL);
  const box = [];
  const p = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', d => box.push(JSON.parse(d)));
  const wait = async (type, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = box.findIndex(m => m.type === type);
      if (i >= 0) return box.splice(i, 1)[0];
      await sleep(40);
    }
    return null;
  };
  const last = (type) => { const arr = box.filter(m => m.type === type); return arr[arr.length - 1] || null; };
  const send = m => ws.send(JSON.stringify(m));
  return { ws, box, p, wait, last, send, name };
}

async function reg(name) {
  const c = client(name);
  await c.p;
  c.send({ type: 'register', name, password: 'test123456' });
  const a = await c.wait('auth');
  if (!a || !a.ok) { c.send({ type: 'login', name, password: 'test123456' }); await c.wait('auth'); }
  return c;
}

async function main() {
  const T = 'A' + Math.floor(Math.random() * 1e5);
  console.log('[A] 建房设置行动超时');
  const host = await reg(T + '_host');
  host.send({ type: 'createRoom', title: '规则验证', sb: 5, bb: 10, buyIn: 1000, actTimeout: 1 });
  await host.wait('joined');
  let st = await host.wait('state');
  ok(st.room.actTimeout === 1, '超时 1 秒写进房间信息（actTimeout=' + st.room.actTimeout + '）');
  ok(st.table.actTimeout === 1000, '桌面状态按毫秒下发（actTimeout=' + st.table.actTimeout + '）');

  console.log('[B] 连续超时三次被请离座位');
  const b = await reg(T + '_b');
  b.send({ type: 'joinRoom', roomId: st.room.id });
  await b.wait('state');
  host.send({ type: 'sit', seat: 0, amount: 1000 });
  b.send({ type: 'sit', seat: 1, amount: 1000 });
  await sleep(500);
  host.send({ type: 'start' });
  // 超时 1 秒一手：b 连续三手不动。host 是房主但也是玩家，得替他把牌打完
  // —— 房主这侧每轮主动 check/fold，让 b 的三次超时分布到三手。
  let kicked = false, handsSeen = 0, lastHand = 0, streakSeen = 0;
  for (let t = 0; t < 90 && !kicked; t++) {
    await sleep(1000);
    st = b.last('state') || st;
    if (st.room && st.table && st.table.handCount > lastHand) {
      lastHand = st.table.handCount;
      handsSeen = st.table.handCount;
    }
    if (st.table && st.table.you && st.table.you.timeoutStreak >= 1) streakSeen = st.table.you.timeoutStreak;
    if (st.table && st.table.you && st.table.you.seat < 0) kicked = true;
    // host 侧主动出牌（防止 host 也超时把节奏搅乱——超时 1s 下几乎必然超时，
    // 但 host 超时只算弃牌，无碍；这里只要 b 被踢就行）
    const hs = host.last('state');
    if (hs && hs.table && hs.table.you && hs.table.you.act) {
      host.send({ type: 'action', action: { type: hs.table.you.act.legal.toCall > 0 ? 'fold' : 'check' } });
    }
  }
  ok(kicked, '连续三次超时后被请离座位（you.seat=-1，经历 ' + handsSeen + ' 手）');
  ok(streakSeen >= 1, '超时计数对本人可见（timeoutStreak 实测 ' + streakSeen + '）');
  const after = b.last('state');
  ok(after && after.table && after.table.you && after.table.you.seat < 0, '请离后座位清空（you.seat=' + (after && after.table.you ? after.table.you.seat : '?') + '）');
  // 退回的是「桌上剩余筹码」：期间被吃掉的盲注/下注不退，所以是 >0 而不是精确 1000
  ok(after && after.table && after.table.you && after.table.you.account > 0,
    '桌上筹码退回账号（account=' + (after && after.table.you ? after.table.you.account : '?') + '）');
  host.ws.close(); b.ws.close();

  console.log('[C] 牌局中加入的座位下一手强制上桌大盲');
  const c1 = await reg(T + '_c1');
  const c2 = await reg(T + '_c2');
  c1.send({ type: 'createRoom', title: '上桌大盲', sb: 5, bb: 10, buyIn: 1000, actTimeout: 15 });
  await c1.wait('joined');
  st = await c1.wait('state');
  c2.send({ type: 'joinRoom', roomId: st.room.id });
  await c2.wait('state');
  c1.send({ type: 'sit', seat: 0, amount: 1000 });
  c2.send({ type: 'sit', seat: 1, amount: 1000 });
  await sleep(400);
  c1.send({ type: 'start' });
  await sleep(1500);
  // 开局后再进来一个人（mid-game 加入 → 下一手 mustPostBB）
  const c3 = await reg(T + '_c3');
  c3.send({ type: 'joinRoom', roomId: st.room.id });
  await c3.wait('state');
  c3.send({ type: 'sit', seat: 2, amount: 1000 });
  await sleep(600);
  st = c3.last('state');
  ok(st.table.you.mustPostBB === true, '牌局中加入 → 标记 mustPostBB');
  // 等 c3 被发到的第一手（引擎每手给所有人发牌，c3 下一手就上场）
  let posted = false, postedLabel = '';
  for (let t = 0; t < 60 && !posted; t++) {
    await sleep(1000);
    st = c3.last('state') || st;
    const me = st.table && st.table.seats ? st.table.seats[2] : null;
    const hs = c1.last('state');
    if (hs && hs.table && hs.table.you && hs.table.you.act) {
      c1.send({ type: 'action', action: { type: hs.table.you.act.legal.toCall > 0 ? 'fold' : 'check' } });
    }
    const h2 = c2.last('state');
    if (h2 && h2.table && h2.table.you && h2.table.you.act) {
      c2.send({ type: 'action', action: { type: h2.table.you.act.legal.toCall > 0 ? 'fold' : 'check' } });
    }
    if (me && /上桌大盲/.test(me.lastAction || '')) { posted = true; postedLabel = me.lastAction; }
  }
  ok(posted, '第一手牌下发时强制交上桌大盲（' + postedLabel + '）');
  // room 侧标记在手结束时才与引擎同步（onHandEnd），再等一手收尾
  let cleared = false;
  for (let t = 0; t < 30 && !cleared; t++) {
    await sleep(1000);
    st = c3.last('state') || st;
    if (st.table && st.table.you && st.table.you.mustPostBB === false) cleared = true;
    const hs = c1.last('state');
    if (hs && hs.table && hs.table.you && hs.table.you.act) {
      c1.send({ type: 'action', action: { type: hs.table.you.act.legal.toCall > 0 ? 'fold' : 'check' } });
    }
    const h2 = c2.last('state');
    if (h2 && h2.table && h2.table.you && h2.table.you.act) {
      c2.send({ type: 'action', action: { type: h2.table.you.act.legal.toCall > 0 ? 'fold' : 'check' } });
    }
  }
  ok(cleared, '交过之后标记清除（mustPostBB=false）');

  console.log('[D] 边池结算分池展示');
  // 三人不同额 allin → 主池 + 边池两层，横幅按池分行
  const d1 = await reg(T + '_d1');
  const d2 = await reg(T + '_d2');
  const d3 = await reg(T + '_d3');
  d1.send({ type: 'createRoom', title: '边池验证', sb: 5, bb: 10, buyIn: 1000, actTimeout: 10 });
  await d1.wait('joined');
  st = await d1.wait('state');
  d2.send({ type: 'joinRoom', roomId: st.room.id });
  await d2.wait('state');
  d3.send({ type: 'joinRoom', roomId: st.room.id });
  await d3.wait('state');
  d1.send({ type: 'sit', seat: 0, amount: 200 });
  d2.send({ type: 'sit', seat: 1, amount: 600 });
  d3.send({ type: 'sit', seat: 2, amount: 600 });
  await sleep(500);
  d1.send({ type: 'start' });
  await sleep(1200);
  // 各自 allin（轮到谁谁 allin，最多等 3 轮）
  for (let r = 0; r < 6; r++) {
    for (const c of [d1, d2, d3]) {
      const s = c.last('state');
      if (s && s.table && s.table.you && s.table.you.act) {
        c.send({ type: 'action', action: { type: 'allin' } });
      }
    }
    st = d1.last('state') || st;
    if (st.result) break;
    await sleep(1200);
  }
  let res = null;
  for (let t = 0; t < 15 && !res; t++) {
    await sleep(1000);
    st = d1.last('state') || st;
    if (st.result && st.result.pots && st.result.pots.length >= 2) res = st.result;
  }
  ok(!!res, '不同额全下产生边池（pots=' + (res ? res.pots.length : 0) + ' 层）');
  if (res) {
    ok(res.pots[0].winners.length >= 1 && res.pots[1].winners.length >= 1, '主池/边池各有赢家');
    ok(res.pots.reduce((n, p) => n + p.amount, 0) === 1400, '两池总额 = 全部投入 1,400');
  }
  d1.ws.close(); d2.ws.close(); d3.ws.close();

  console.log(fails ? '\n' + fails + ' 项失败 ❌' : '\n房间规则测试全部通过 ✅');
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
