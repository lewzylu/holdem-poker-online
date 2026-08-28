/* nav-test.js —— 页面跳转回归测试
 *
 * 背景：曾出现 index.html ↔ lobby.html 无限循环跳转，根因是 lobby 在 WebSocket 握手完成前
 *       同步判断 Net.isAuthed（必然为 false）就跳走；以及 table ↔ lobby 的对称问题。
 *
 * 做法：用 jsdom 加载真实页面，拦截 location.href 赋值（记录而不真的导航），
 *       这样能统计「页面想跳去哪、跳了几次」。
 *
 * 用法：先启动服务端，再 node tools/nav-test.js
 */
const path = require('path');
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(c, m) { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } }

/* ---------- 简易 ws 客户端 ---------- */
function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const h = {};
    const c = {
      ws, token: null, name: null, lastState: null, auto: true, lastKey: '',
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
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'state') {
        c.lastState = m;
        const act = m.table && m.table.you ? m.table.you.act : null;
        if (act && c.auto) {
          const key = act.deadline + ':' + m.table.handCount + ':' + m.table.phase;
          if (key !== c.lastKey) { c.lastKey = key; c.send({ type: 'action', action: { type: act.legal.toCall > 0 ? 'call' : 'check' } }); }
        }
      }
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

/* ---------- 加载页面并拦截跳转 ---------- */
async function loadPage(page, token, ms = 5000, setup) {
  const nav = [], errs = [];
  let navErrors = 0;    // 拦截失效时会走到 jsdom 的 navigation 报错
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const msg = e.message || String(e);
    if (/navigation/i.test(msg)) navErrors++;
    else errs.push(msg);
  });
  const dom = await JSDOM.fromURL(BASE + '/' + page, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (token) window.localStorage.setItem('poker_token', token);
      if (setup) { try { setup(window); } catch (e) { errs.push('setup 失败: ' + e.message); } }
      // 拦住 location.href 的赋值：只记录，不真的导航，这样能看出页面想跳几次、跳去哪。
      // 注意：jsdom 的 href 访问器在 location「实例」上（不在 prototype），且 window.location 不可重定义。
      try {
        const desc = Object.getOwnPropertyDescriptor(window.location, 'href');
        if (desc && desc.set) {
          Object.defineProperty(window.location, 'href', {
            configurable: true,
            get() { return desc.get.call(window.location); },   // 调原始 getter，避免递归
            set(v) { nav.push(String(v).replace(BASE + '/', '')); }
          });
        } else {
          errs.push('location.href 上没有 setter，无法拦截');
        }
      } catch (e) { errs.push('无法拦截 location.href: ' + e.message); }
    }
  });
  await sleep(ms);
  const doc = dom.window.document;
  const name = (doc.querySelector('#me-name') || doc.querySelector('#me-name2') || {}).textContent;
  const conn = dom.window.Net ? dom.window.Net.conn : null;
  dom.window.close();
  return { nav, errs, name, conn, navErrors };
}

(async function () {
  const tag = 'N' + Math.random().toString(36).slice(2, 7);

  console.log('[准备] 注册两个账号，一个单独、一个在牌局中');
  const solo = await wsClient();
  solo.send({ type: 'register', name: tag + '_solo', password: 'test123456' });
  await solo.wait('auth');

  const host = await wsClient(), guest = await wsClient();
  for (const [c, n] of [[host, 'h'], [guest, 'g']]) {
    c.send({ type: 'register', name: tag + '_' + n, password: 'test123456' });
    await c.wait('auth');
  }
  host.send({ type: 'createRoom', title: 'nav', sb: 5, bb: 10, buyIn: 1000 });
  await host.wait('joined');
  guest.send({ type: 'joinRoom', roomId: host.roomId });
  await guest.wait('joined');
  host.send({ type: 'sit', seat: 0, amount: 1000 });
  guest.send({ type: 'sit', seat: 1, amount: 1000 });
  await sleep(600);
  host.send({ type: 'start' });
  await sleep(1500);
  ok(!!(host.lastState && host.lastState.room.status === 'playing'), '测试房间牌局进行中');

  // 跳转次数：拦截生效时用记录的目标数，否则退回 jsdom 的 navigation 报错次数
  const jumps = r => r.navErrors || r.nav.length;
  const live = (r, label) => {
    ok(r.conn === 'online', label + '：WebSocket 已连上服务端（否则断言无意义）');
    console.log('    （跳转拦截' + (r.navErrors === 0 ? '生效，能拿到目标' : '未生效，仅统计次数') +
      '；nav=' + (r.nav.join(' → ') || '无') + '；navErrors=' + r.navErrors + '）');
  };

  console.log('[1] 已登录 + 不在房间 → lobby.html 不应跳回登录页');
  let r = await loadPage('lobby.html', solo.token, 5000);
  live(r, 'lobby');
  ok(jumps(r) === 0, 'lobby 未发生任何跳转');
  ok(r.name && r.name !== '—', 'lobby 正确显示了用户名：' + r.name);

  console.log('[2] 已登录 + 在牌局中 → table.html 不应跳回大厅/登录页');
  r = await loadPage('table.html', guest.token, 5000);
  live(r, 'table');
  ok(jumps(r) === 0, '牌桌未发生任何跳转');
  ok(r.name && r.name !== '—', '牌桌正确显示了用户名：' + r.name);

  console.log('[3] 牌局中主动退回大厅 → 不应被反复拽回牌桌');
  r = await loadPage('lobby.html', guest.token, 5000,
    w => w.sessionStorage.setItem('poker_no_auto', host.roomId));
  live(r, 'lobby');
  ok(jumps(r) === 0, '主动退回大厅后不会再被自动拉回牌桌');

  console.log('[4] 牌局中打开大厅（无标记）→ 自动进桌，但绝不回登录页');
  r = await loadPage('lobby.html', guest.token, 5000);
  live(r, 'lobby');
  // jsdom 不会真的导航，所以这里会反复触发「进桌」跳转，真实浏览器只跳一次；
  // 我们只关心：跳转目标里绝不能出现 index.html（那才是死循环的特征）
  ok(r.nav.filter(x => /index\.html/.test(x)).length === 0, '跳转目标里没有 index.html');

  console.log('[5] 未登录（无 token）→ 应跳一次到登录页');
  r = await loadPage('lobby.html', null, 5000);
  live(r, 'lobby');
  ok(jumps(r) >= 1, 'lobby 正确跳向登录页');

  console.log('[6] 已登录打开 index.html → 应自动进大厅一次');
  r = await loadPage('index.html', solo.token, 5000);
  live(r, 'index');
  ok(jumps(r) >= 1, 'index 自动跳向大厅');
  ok(jumps(r) <= 2, '没有出现反复横跳（跳转次数 ' + jumps(r) + '）');

  console.log('[7] 失效 token → 停在登录页，不循环');
  r = await loadPage('index.html', 'invalid_token_xxx', 5000);
  live(r, 'index');
  ok(jumps(r) === 0, '失效凭证不会跳进大厅，也不会循环');

  [solo, host, guest].forEach(c => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  console.log('\n' + (fails === 0 ? '跳转回归测试全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
