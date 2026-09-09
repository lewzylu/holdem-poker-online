/* fill-room.js —— 往已有房间里补机器人，把桌子坐满
 * 用法：node tools/fill-room.js <房间号> <目标人数>
 * 仅用于本地布局验证（visual-check 的满桌用例），不参与产品逻辑。
 */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://127.0.0.1:3000/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const h = {};
    const c = {
      ws, token: null, name: null, lastKey: '',
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      wait(t, ms = 8000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('等 ' + t + ' 超时')), ms);
          (h[t] = h[t] || []).push(m => { clearTimeout(timer); res(m); });
        });
      }
    };
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'auth' && m.ok) { c.token = m.token; c.name = m.user.name; }
      if (m.type === 'state') {
        const act = m.table && m.table.you ? m.table.you.act : null;
        if (act) {
          const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
          if (key !== c.lastKey) {
            c.lastKey = key;
            setTimeout(() => c.send({
              type: 'action', action: { type: act.legal.toCall > 0 ? 'call' : 'check' }
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
  const roomId = process.argv[2];
  const want = parseInt(process.argv[3] || '9', 10);
  if (!roomId) { console.error('用法：node tools/fill-room.js <房间号> [目标人数]'); process.exit(1); }

  const POOL = ['大熊', '静静', '阿飞', '阿May', '老张', '小陈', '阿宝', '丁丁'];
  for (let i = 0; i < want && i < POOL.length; i++) {
    const n = POOL[i];
    const c = await wsClient();
    c.send({ type: 'register', name: n, password: 'test123456' });
    const r = await c.wait('auth').catch(() => null);
    if (!r || !r.ok) { c.send({ type: 'login', name: n, password: 'test123456' }); await c.wait('auth'); }
    c.send({ type: 'joinRoom', roomId });
    await c.wait('joined').catch(() => null);
    await sleep(200);
    // 座位号从 4 起（0~3 已被占），逐个试
    c.send({ type: 'sit', seat: 4 + i, amount: 1000 });
    console.log('补位：' + n + ' → ' + (4 + i) + ' 号位');
    await sleep(300);
  }
  console.log('补位完成，进程保持存活以维持连接（Ctrl+C 退出）');
  setInterval(() => {}, 10000);
})();
