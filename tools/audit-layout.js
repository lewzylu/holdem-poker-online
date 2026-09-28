/* audit-layout.js —— 布局审计：在一批真实机型视口下量牌桌利用率
 *
 * 只读不写，不改任何东西。目的是回答两个问题：
 *   1) 每个视口下画布卡在宽度还是高度？卡住的那一维有没有被浪费？
 *   2) 与「理论最优」差多少？—— 理论最优 = 顶栏与操作条各按其最小可用尺寸算出的 tscale
 *
 * 用法：node tools/audit-layout.js
 * 前置：服务端已启动、agent-browser 已登录进牌桌
 */
const { execSync } = require('child_process');

const CANVAS_W = 1200, CANVAS_H = 600;
const AB = process.env.AB_BIN || 'agent-browser';

function ab(args, quiet) {
  try {
    return execSync(AB + ' ' + args, { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (!quiet) console.log('  ! ' + args + ' 失败');
    return null;
  }
}
function probe(js) {
  const out = ab('eval "' + js.replace(/"/g, '\\"') + '"');
  if (!out) return null;
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l[0] !== '{' && l[0] !== '[' && l[0] !== '"') continue;
    try { const v = JSON.parse(l); return typeof v === 'string' ? JSON.parse(v) : v; }
    catch (e) { /* 再试上一行 */ }
  }
  return null;
}

const P = "JSON.stringify((function(){" +
  "var r=function(s){var e=document.querySelector(s);if(!e)return null;var b=e.getBoundingClientRect();" +
  "return{x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),r:+b.right.toFixed(1),bt:+b.bottom.toFixed(1)};};" +
  "var cv=document.querySelector('.table-canvas');" +
  "var ts=cv?(parseFloat(getComputedStyle(cv).getPropertyValue('--tscale'))||0):0;" +
  "var acts=[].map.call(document.querySelectorAll('button.act'),function(e){var b=e.getBoundingClientRect();" +
  "return{w:Math.round(b.width),h:Math.round(b.height)}});" +
  "var seat=r('.seat.mine')||r('#seats .seat');" +
  "var card=r('#seats .hole .card');" +
  "return{vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio," +
  "sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight," +
  "ts:ts,topbar:r('.topbar'),layout:r('.layout'),fit:r('.table-fit'),canvas:r('.table-canvas')," +
  "bar:r('.action-bar'),wrap:r('.table-wrap'),acts:acts,seat:seat,card:card," +
  "dir:getComputedStyle(document.querySelector('.table-main')).flexDirection," +
  "sideDisp:getComputedStyle(document.querySelector('.side')).display};})())";

// 真实机型 CSS 视口（横屏 / 竖屏成对）
const DEVICES = [
  { n: 'iPhone SE2/8',        w: 375,  h: 667 },
  { n: 'iPhone 12/13 mini',   w: 375,  h: 812 },
  { n: 'iPhone 14/15',        w: 390,  h: 844 },
  { n: 'iPhone 14/15 Pro Max',w: 430,  h: 932 },
  { n: '安卓中端 (Redmi)',     w: 393,  h: 873 },
  { n: '安卓大屏 (三星 S)',    w: 412,  h: 915 },
  { n: '小屏安卓',             w: 360,  h: 640 },
  { n: 'iPad mini',           w: 744,  h: 1133 },
  { n: 'iPad Pro 11',         w: 834,  h: 1194 }
];

const rows = [];

function measure(label, w, h) {
  ab('set viewport ' + w + ' ' + h);
  execSync('sleep 1');
  const g = probe(P);
  if (!g) { console.log('  ! ' + label + ' 读不到'); return null; }

  const portrait = h > w;
  // 卡在哪一维
  const byW = g.fit ? g.fit.w / CANVAS_W : 0;
  const byH = g.fit ? g.fit.h / CANVAS_H : 0;
  const limit = byW <= byH ? '宽' : '高';
  // 牌桌像素面积占视口的比例
  const area = g.canvas ? (g.canvas.w * g.canvas.h) / (g.vw * g.vh) : 0;
  // 顶栏 + 操作条 + 边距 吃掉的比例
  const chrome = 1 - area;
  const minAct = g.acts.length ? Math.min.apply(null, g.acts.map(a => Math.min(a.w, a.h))) : 0;

  rows.push({
    label, vp: w + '×' + h, portrait,
    ts: g.ts, limit, area,
    top: g.topbar ? Math.round(g.topbar.h) : 0,
    bar: g.bar ? Math.round(g.bar.w) + '×' + Math.round(g.bar.h) : '-',
    canvas: g.canvas ? Math.round(g.canvas.w) + '×' + Math.round(g.canvas.h) : '-',
    seatH: g.seat ? +(g.seat.h).toFixed(0) : 0,
    cardW: g.card ? +(g.card.w).toFixed(1) : 0,
    minAct,
    overflow: g.sw > g.vw + 2 ? 'X轴!' : (portrait ? '' : (g.sh > g.vh + 4 ? 'Y轴!' : '')),
    dir: g.dir
  });
  return g;
}

console.log('布局审计：真实机型视口下的牌桌利用率\n');

DEVICES.forEach(d => {
  measure(d.n + ' 竖', d.w, d.h);
  measure(d.n + ' 横', d.h, d.w);
});

// 复位
ab('set viewport 1440 900', true);

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(pad('机型/方向', 24) + pad('视口', 11) + pad('tscale', 8) +
  pad('卡在', 5) + pad('牌桌占屏', 9) + pad('画布', 11) +
  pad('顶栏', 6) + pad('操作条', 10) + pad('牌宽', 7) + pad('最小按钮', 9) + '溢出');
console.log('-'.repeat(112));
rows.forEach(r => {
  console.log(pad(r.label, 24) + pad(r.vp, 11) + pad(r.ts.toFixed(3), 8) +
    pad(r.limit, 5) + pad((r.area * 100).toFixed(1) + '%', 9) + pad(r.canvas, 11) +
    pad(r.top, 6) + pad(r.bar, 10) + pad(r.cardW, 7) + pad(r.minAct, 9) + r.overflow);
});

/* ---- 汇总 ---- */
console.log('\n【按方向汇总】');
['竖', '横'].forEach(o => {
  const g = rows.filter(r => r.label.endsWith(o));
  if (!g.length) return;
  const avgArea = g.reduce((s, r) => s + r.area, 0) / g.length;
  const minTs = Math.min.apply(null, g.map(r => r.ts));
  const maxTs = Math.max.apply(null, g.map(r => r.ts));
  const byW = g.filter(r => r.limit === '宽').length;
  console.log('  ' + o + '屏：牌桌平均占屏 ' + (avgArea * 100).toFixed(1) + '%，' +
    'tscale ' + minTs.toFixed(3) + '~' + maxTs.toFixed(3) + '，' +
    byW + '/' + g.length + ' 个卡在宽度');
  const smallCard = g.filter(r => r.cardW > 0 && r.cardW < 20);
  if (smallCard.length) {
    console.log('    ⚠ 牌面实显不足 20px 的：' +
      smallCard.map(r => r.label.replace(' ' + o, '') + '(' + r.cardW + ')').join('、'));
  }
  const smallBtn = g.filter(r => r.minAct > 0 && r.minAct < 32);
  if (smallBtn.length) {
    console.log('    ⚠ 按钮短边不足 32px 的：' +
      smallBtn.map(r => r.label.replace(' ' + o, '') + '(' + r.minAct + ')').join('、'));
  }
  const of = g.filter(r => r.overflow);
  if (of.length) console.log('    ⚠ 溢出：' + of.map(r => r.label + ' ' + r.overflow).join('、'));
});
