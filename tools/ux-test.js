/* ux-test.js —— 体验走查测试：把「新用户能不能顺利坐下、没钱了能不能领」
 * 这类只靠功能测试守不住的体验规则固化下来。
 *
 * 与 e2e/edge 的分工：那些测「规则对不对」（资产守恒、超时弃牌），
 * 这里测「用户看没看懂」：
 *   A. 空位必须常显「＋ 坐下」—— 曾经靠 hover 换文案，桌面端第一眼毫无可点迹象
 *   B. 牌桌页必须有领取入口，且余额充足时置灰、见底时可用（别让用户点了只收报错）
 *   C. 已入座后空位一律不可点（避免误触）
 *   D. 轮到我时页面无 JS 错误、提示文案含「轮到你了」
 *
 * 前置：服务端已启动、练习房 PRACTICE1 在跑（base URL 可用 BASE_URL 覆盖）。
 * 用法：node tools/ux-test.js
 */
const ROOT = __dirname + '/..';
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3100';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(c, m) { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } }

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const h = {};
    const c = {
      ws, token: null, name: null, lastState: null,
      send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      on(t, f) { (h[t] = h[t] || []).push(f); },
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
      if (m.type === 'state') c.lastState = m;
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

/** 打开牌桌页，返回带探测结果的 DOM 摘要 */
async function loadTable(token, ms = 4000) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
  const dom = await JSDOM.fromURL(BASE + '/table.html', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.localStorage.setItem('poker_token', token);
      // jsdom 没有 Web Audio：audio() 会拿不到 AudioContext 而返回 null，
      // 提示音路径必须优雅退化而不是抛错 —— 这正是 D 组要守的行为。
      delete win.AudioContext; delete win.webkitAudioContext;
    }
  });
  await sleep(ms);
  const doc = dom.window.document;
  const out = {
    claim: (() => {
      const b = doc.getElementById('btn-claim');
      return b ? { disabled: b.disabled, text: b.textContent } : null;
    })(),
    canSitSeats: [...doc.querySelectorAll('#seats .seat.empty.can-sit')].map(e =>
      e.querySelector('.empty-tag').textContent.trim()),
    otherEmpty: [...doc.querySelectorAll('#seats .seat.empty:not(.can-sit)')].length,
    mineSeated: !!doc.querySelector('#seats .seat.mine'),
    prompt: doc.getElementById('prompt').textContent,
    toast: doc.getElementById('toast').textContent,
    errs: errs.slice(0, 3)
  };
  dom.window.close();
  return out;
}

async function freshAccount(tag) {
  const c = await wsClient();
  c.send({ type: 'register', name: 'ux' + tag + Math.floor(Math.random() * 1e5), password: 'test123456' });
  await sleep(900);
  return c;
}

(async function () {
  console.log('[A] 新用户进练习房：空位常显「＋ 坐下」、领取置灰（余额 5000）');
  {
    const c = await freshAccount('a');
    c.send({ type: 'joinRoom', roomId: 'PRACTICE1' });
    await sleep(1200);
    const p = await loadTable(c.token);
    ok(p.canSitSeats.length >= 3, '存在可坐空位（' + p.canSitSeats.length + ' 个）');
    ok(p.canSitSeats.every(t => /坐下/.test(t)),
      '可坐空位都常显「＋ 坐下」文案（' + JSON.stringify(p.canSitSeats.slice(0, 2)) + '）');
    ok(p.claim && p.claim.disabled === true, '余额充足时领取按钮置灰');
    ok(p.errs.length === 0, '页面无 JS 错误' + (p.errs.length ? '：' + p.errs[0] : ''));
    c.ws.close();
  }

  console.log('\n[B] 余额见底（<1000）：领取按钮可用');
  {
    const c = await freshAccount('b');
    /* 练习房大盲 10，买入会被夹到上限 bb×200=2000 —— 一次坐下压不到 1000 以下，
       所以坐下 2000 再补给 2100，把账号压到 900。 */
    c.send({ type: 'joinRoom', roomId: 'PRACTICE1' });
    await sleep(1200);
    const st = c.lastState;
    const free = st.table.seats.find(s => !s.name);
    c.send({ type: 'sit', seat: free.i, amount: 2000 });
    await sleep(1500);
    c.send({ type: 'rebuy', amount: 2100 });
    await sleep(1200);
    const p = await loadTable(c.token, 3500);
    ok(p.claim && p.claim.disabled === false, '余额 900 时领取按钮可用');
    // 点它：服务端应受理并回提示
    c.send({ type: 'claim' });
    const notice = await c.wait('notice', 5000).catch(() => null);
    ok(!!notice && /已领取/.test(notice.msg), '点领取后收到「已领取」提示' + (notice ? '' : '（超时）'));
    c.send({ type: 'stand' });
    await sleep(800);
    c.ws.close();
  }

  console.log('\n[C] 已入座：空位一律不可点（防误触）');
  {
    const c = await freshAccount('c');
    c.send({ type: 'joinRoom', roomId: 'PRACTICE1' });
    await sleep(1200);
    const st = c.lastState;
    const free = st.table.seats.find(s => !s.name);
    c.send({ type: 'sit', seat: free.i, amount: 1000 });
    await sleep(2500);
    const p = await loadTable(c.token, 3000);
    ok(p.mineSeated, '已入座（座位卡标 mine）');
    ok(p.canSitSeats.length === 0, '入座后没有任何可点空位（实际 ' + p.canSitSeats.length + '）');
    c.send({ type: 'stand' });
    await sleep(800);
    c.ws.close();
  }

  console.log('\n[D] 轮到我：提示文案与无报错（jsdom 无 Web Audio，提示音应静默退化）');
  {
    const c = await freshAccount('d');
    c.send({ type: 'joinRoom', roomId: 'PRACTICE1' });
    await sleep(1200);
    const st = c.lastState;
    const free = st.table.seats.find(s => !s.name);
    c.send({ type: 'sit', seat: free.i, amount: 1000 });
    // 等轮到我（最多 ~90 秒：要等本手结束 + 下一手发牌）。jsdom 页面里不自动行动，
    // 轮到我即触发 playTurnCue —— 无 AudioContext 时必须安静跳过。
    const vc = new VirtualConsole();
    const errs = [];
    vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
    const dom = await JSDOM.fromURL(BASE + '/table.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.localStorage.setItem('poker_token', c.token);
        delete win.AudioContext; delete win.webkitAudioContext;
      }
    });
    let myTurn = null;
    for (let i = 0; i < 30 && !myTurn; i++) {
      await sleep(3000);
      myTurn = dom.window.document.getElementById('prompt').textContent.match(/轮到你了/) ? dom.window.document.getElementById('prompt').textContent : null;
    }
    ok(!!myTurn, '轮到我时提示含「轮到你了」（' + (myTurn || '未等到') + '）');
    ok(errs.length === 0, '提示音路径无 JS 错误（无 AudioContext 时静默退化）' + (errs.length ? '：' + errs[0] : ''));
    // 收尾：行动掉这一手并站起，把座位还给真人
    dom.window.eval('Net.send({type:"action",action:{type:"check"}})');
    await sleep(1500);
    c.send({ type: 'stand' });
    await sleep(800);
    dom.window.close();
    c.ws.close();
  }

  console.log(fails === 0 ? '\n体验走查测试全部通过 ✅' : '\n' + fails + ' 项失败 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e.message); process.exit(1); });
