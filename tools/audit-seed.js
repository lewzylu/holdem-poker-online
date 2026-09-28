/* audit-seed.js —— 为布局审计播种一个「进行中的牌桌」并保持连接存活
 *
 * 布局审计（visual-check.js / audit-layout.js）要求浏览器已登录进一个牌桌，
 * 这个脚本用 WebSocket 造出两人入座、已开局的房间，把本人（槽位0）的 token 写到
 * .audit-token，然后**挂住不退出** —— 两个 WS 连接必须一直开着，否则玩家一断线
 * 座位可能被服务端回收，审计打开时就不是「进行中的牌桌」了。
 *
 * 两个机器人会自动跟注/过牌，让牌局一直继续（复用 nav-test 的自动应答逻辑）。
 *
 * 用法：node tools/audit-seed.js   （前台会挂住；审计脚本跑完后 Ctrl-C 结束）
 *      审计脚本从 .audit-token 读 token 注入浏览器。
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/^http/, 'ws') + '/ws';
const TOKEN_FILE = path.join(__dirname, '..', '.audit-token');
const tag = 'A' + Math.random().toString(36).slice(2, 7);

function client() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(BASE);
    const h = {};
    const c = {
      ws, token: null, roomId: null, auto: true, lastKey: '',
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      wait(t, ms = 8000) {
        return new Promise((rs, rj) => {
          const tm = setTimeout(() => rj(new Error('wait ' + t + ' timeout')), ms);
          (h[t] = h[t] || []).push(m => { clearTimeout(tm); rs(m); });
        });
      }
    };
    ws.on('message', d => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.type === 'auth' && m.ok) c.token = m.token;
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'state') {
        const act = m.table && m.table.you ? m.table.you.act : null;
        if (act && c.auto) {
          const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
          if (key !== c.lastKey) {
            c.lastKey = key;
            c.send({ type: 'action', action: { type: act.legal.toCall > 0 ? 'call' : 'check' } });
          }
        }
      }
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => res(c));
    ws.on('error', rej);
  });
}

(async () => {
  const host = await client(), guest = await client();
  host.send({ type: 'register', name: tag + '_h', password: 'test123456' }); await host.wait('auth');
  guest.send({ type: 'register', name: tag + '_g', password: 'test123456' }); await guest.wait('auth');
  host.send({ type: 'createRoom', title: 'audit', sb: 5, bb: 10, buyIn: 1000 }); await host.wait('joined');
  guest.send({ type: 'joinRoom', roomId: host.roomId }); await guest.wait('joined');
  host.send({ type: 'sit', seat: 0, amount: 1000 });
  guest.send({ type: 'sit', seat: 1, amount: 1000 });
  await new Promise(r => setTimeout(r, 600));
  host.send({ type: 'start' });
  await new Promise(r => setTimeout(r, 1500));

  fs.writeFileSync(TOKEN_FILE, host.token);
  console.log('SEED_READY room=' + host.roomId + ' token=' + host.token.slice(0, 12) + '...');
  console.log('（连接保持存活；审计跑完后请结束本进程）');

  // 挂住不退出：两条 WS 连接必须一直开着
  process.stdin.resume();
})().catch(e => { console.error('SEED_ERR', e.message); process.exit(1); });
