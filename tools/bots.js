/* bots.js —— 起两个机器人开一局，方便用真实浏览器加入后截图验证布局
 * 用法：node tools/bots.js   （常驻，Ctrl+C 退出）
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsClient(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const h = {};
    const c = {
      tag, ws, token: null, name: null, roomId: null, lastState: null, lastKey: '',
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
      if (m.type === 'auth' && m.ok) { c.token = m.token; c.name = m.user.name; }
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'state') {
        c.lastState = m;
        const act = m.table && m.table.you ? m.table.you.act : null;
        if (act) {
          const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
          if (key !== c.lastKey) {
            c.lastKey = key;
            // 慢一点出牌，方便截图时能看到桌面状态
            setTimeout(() => c.send({
              type: 'action',
              action: { type: act.legal.toCall > 0 ? 'call' : 'check' }
            }), 700);
          }
        }
      }
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async function () {
  const COUNT = parseInt(process.argv[2] || '2', 10);   // node tools/bots.js 8 可起满桌陪练
  const POOL = ['阿强', '老王', '小李', '阿珍', '大熊', '静静', '阿飞', '阿May'];
  const names = POOL.slice(0, Math.max(0, COUNT - 1));  // 留一个位置给浏览器玩家
  const bots = [];
  for (const n of names) {
    const c = await wsClient(n);
    c.send({ type: 'register', name: n, password: 'test123456' });
    const r = await c.wait('auth').catch(() => null);
    if (!r || !r.ok) {
      c.send({ type: 'login', name: n, password: 'test123456' });
      await c.wait('auth');
    }
    bots.push(c);
    console.log('机器人就绪：' + c.name);
  }

  const [b1, b2] = bots;
  b1.send({ type: 'createRoom', title: '布局验证局', sb: 5, bb: 10, buyIn: 1000 });
  await b1.wait('joined');
  const roomId = b1.roomId;
  console.log('房间号 = ' + roomId);

  bots.forEach((b, i) => {
    if (i === 0) return;
    b.send({ type: 'joinRoom', roomId });
  });
  await sleep(800);
  bots.forEach((b, i) => b.send({ type: 'sit', seat: i, amount: 1000 }));
  await sleep(1000);
  b1.send({ type: 'start' });
  console.log('牌局已开始（' + bots.length + ' 个机器人），浏览器可用房间号 ' + roomId + ' 加入');

  // 每 5 秒看看是否有人加入，有就继续；保持进程存活
  setInterval(() => {
    const st = b1.lastState;
    if (st && st.room) {
      const seated = st.table.seats.filter(s => s.name).length;
      process.stdout.write('\r当前入座 ' + seated + ' 人，第 ' + st.room.handCount + ' 手   ');
    }
  }, 2000);
})();
