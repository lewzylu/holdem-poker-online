/* layout-test.js —— 牌桌布局测试：自己是否固定在左下角 + 极端屏幕比例下座位是否溢出桌面
 *
 * jsdom 没有布局引擎，getBoundingClientRect 恒为 0，所以在 beforeParse 里注入桩，
 * 模拟不同设备的牌桌尺寸，再读取座位的 left/top 百分比来验证。
 */
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(c, m) { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } }

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

/** 用给定视口尺寸加载牌桌页，返回所有座位的定位信息 */
async function loadTable(token, w, h, ms = 4000) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
  const dom = await JSDOM.fromURL(BASE + '/table.html', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.localStorage.setItem('poker_token', token);
      // 让牌桌的实测尺寸等于我们要模拟的设备尺寸
      win.HTMLElement.prototype.getBoundingClientRect = function () {
        const felt = this.classList && this.classList.contains('felt');
        const W = felt ? w : w, H = felt ? h : h;
        return { width: W, height: H, top: 0, left: 0, right: W, bottom: H, x: 0, y: 0 };
      };
      Object.defineProperty(win, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(win, 'innerHeight', { configurable: true, value: h });
    }
  });
  await sleep(ms);
  const seats = [...dom.window.document.querySelectorAll('#seats .seat')].map(s => ({
    left: parseFloat(s.style.left), top: parseFloat(s.style.top),
    mine: s.classList.contains('mine'),
    name: (s.querySelector('.nm') || {}).textContent,
    myCards: s.querySelectorAll('.card.my').length,
    smallCards: s.querySelectorAll('.card.small').length
  }));
  const err = errs.slice(0, 3);
  dom.window.close();
  return { seats, err };
}

(async function () {
  const tag = 'L' + Math.random().toString(36).slice(2, 6);
  console.log('[准备] 4 人开局');
  const cs = [];
  for (let i = 0; i < 4; i++) {
    const c = await wsClient();
    c.send({ type: 'register', name: tag + '_p' + i, password: 'test123456' });
    await c.wait('auth');
    cs.push(c);
  }
  const host = cs[0];
  host.send({ type: 'createRoom', title: 'layout', sb: 5, bb: 10, buyIn: 1000 });
  await host.wait('joined');
  for (let i = 1; i < 4; i++) { cs[i].send({ type: 'joinRoom', roomId: host.roomId }); await cs[i].wait('joined'); }
  cs.forEach((c, i) => c.send({ type: 'sit', seat: i, amount: 1000 }));
  await sleep(600);
  host.send({ type: 'start' });
  await sleep(2000);

  // cs[2] 是第 3 位入座的玩家，用它验证「自己」的位置
  const me = cs[2];

  for (const dev of [
    { name: '桌面 1440×780', w: 1100, h: 620 },
    { name: 'iPhone 14 横屏 844×390', w: 800, h: 340 },
    { name: '小安卓横屏 640×320', w: 600, h: 280 },
    { name: 'iPad 横屏 1180×820', w: 1000, h: 560 }
  ]) {
    console.log('[' + dev.name + ']');
    const r = await loadTable(me.token, dev.w, dev.h);
    const mine = r.seats.find(s => s.mine);
    ok(r.seats.length === 4, '渲染出 4 个座位（实际 ' + r.seats.length + '）');
    ok(!!mine, '存在「我的」座位');
    if (mine) {
      ok(mine.left < 50, '我的座位在左半边（left=' + mine.left.toFixed(1) + '%）');
      ok(mine.top > 50, '我的座位在下半边（top=' + mine.top.toFixed(1) + '%）');
      ok(mine.myCards === 2, '我的两张底牌用大号渲染（.card.my × ' + mine.myCards + '）');
    }
    const others = r.seats.filter(s => !s.mine);
    ok(others.every(s => s.smallCards === 2 || s.smallCards === 0), '其他玩家用小号牌');
    // 座位不能溢出牌桌（留 2% 余量）
    const out = r.seats.filter(s => s.left < 2 || s.left > 98 || s.top < 2 || s.top > 98);
    ok(out.length === 0, '没有座位溢出桌面' + (out.length ? '（越界 ' + out.length + ' 个）' : ''));
    // 座位之间不能重叠（椭圆上均匀分布）
    let minGap = 999;
    for (let i = 0; i < r.seats.length; i++) {
      for (let j = i + 1; j < r.seats.length; j++) {
        const a = r.seats[i], b = r.seats[j];
        minGap = Math.min(minGap, Math.hypot(a.left - b.left, a.top - b.top));
      }
    }
    ok(minGap > 25, '座位间距充足（最小间距 ' + minGap.toFixed(1) + '%）');
    if (r.err.length) console.log('    页面错误：' + r.err.join(' | '));
  }

  cs.forEach(c => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  console.log('\n' + (fails === 0 ? '布局测试全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
