/* 9 人满员局：9 个 ws 客户端入座开局 */
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:3000/ws';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const clients = [];
  for (let i = 0; i < 9; i++) {
    const name = 'gap' + Math.floor(Math.random() * 1e5) + '_' + i;
    const ws = new WebSocket(URL);
    const box = [];
    ws.on('message', d => box.push(JSON.parse(d)));
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'register', name, password: 'test123456' }));
    await new Promise(res => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (box.some(m => m.type === 'auth')) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); res(); }
      }, 50);
    });
    clients.push({ ws, name, box });
  }
  const [h, ...rest] = clients;
  h.ws.send(JSON.stringify({ type: 'createRoom', title: '贴角验证局', sb: 5, bb: 10, buyIn: 1000 }));
  const jj = await new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = h.box.find(m => m.type === 'joined');
      if (m) { clearInterval(iv); res(m); } else if (Date.now() - t0 > 4000) { clearInterval(iv); res(null); }
    }, 50);
  });
  console.log('roomId =', jj && jj.roomId);
  for (const c of rest) c.ws.send(JSON.stringify({ type: 'joinRoom', roomId: jj.roomId }));
  await sleep(600);
  clients.forEach((c, i) => c.ws.send(JSON.stringify({ type: 'sit', seat: i, amount: 1000 })));
  await sleep(800);
  h.ws.send(JSON.stringify({ type: 'start' }));
  await sleep(2000);
  const st = h.box.filter(m => m.type === 'state').pop();
  console.log('入座', st && st.table ? st.table.seats.filter(s => s.name).length : 0, '人');
  setTimeout(() => process.exit(0), 300000);
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
