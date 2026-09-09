/* layout-test.js —— 牌桌固定槽位布局测试
 *
 * 牌桌是画布内居中的圆角长方形，九个座位槽位的坐标是一张常量表。
 * 「九席不重叠」不再由任何运行时计算保证，只由这张表 + 几个 CSS 尺寸保证 ——
 * 这个脚本就是守它们的网。改动 table.js 的 SLOTS / CANVAS_*，
 * 或 table.css 里 .felt / .seat / .card.small / --hole-peek 的尺寸，都必须重跑它。
 *
 * 余量很紧，别凭感觉调：最紧的是侧边上下两席（牌相向而出），其次是底边三席。
 *
 * 分三部分：
 *  A. 纯几何（不需要服务端）：从源码解析槽位表与 CSS 尺寸，验证
 *     ①九席两两不重叠 ②全部落在画布内 ③全部落在桌面直边区段、无一在圆角上
 *     ④同侧席位对齐 ⑤左右镜像 ⑥本人在底边正中
 *  B. CSS 规则：底牌尺寸不按「是不是我」分叉；已废除的机制没有残留
 *  C. 真实页面（需要服务端）：渲染出九个槽位（而非在座人数）、本人落在槽位 0、
 *     渲染的 left/top 与常量表一致、空位不含玩家信息
 *
 * jsdom 没有布局引擎，getBoundingClientRect 恒为 0，所以 C 部分只读 style/class，不量像素 ——
 * 尺寸相等这件事改由「同一条 CSS 规则」来证明，比量一个恒为 0 的矩形可靠。
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
function ok(c, m) { if (c) console.log('  ✓ ' + m); else { fails++; console.log('  ✗ ' + m); } }

/* ==================== 从源码解析常量 ==================== */
const JS = fs.readFileSync(path.join(ROOT, 'public/js/table.js'), 'utf8');
const CSS_TABLE = fs.readFileSync(path.join(ROOT, 'public/css/table.css'), 'utf8');
const CSS_APP = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');

function num(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('解析不到 ' + what + '，正则：' + re);
  return parseFloat(m[1]);
}
function block(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('解析不到 ' + what + ' 规则块');
  return m[1];
}

const CANVAS_W = num(JS, /const CANVAS_W = (\d+)/, 'CANVAS_W');
const CANVAS_H = num(JS, /const CANVAS_H = (\d+)/, 'CANVAS_H');

// 槽位表：从 table.js 的 SLOTS 里逐项抠出来，保证测的就是实际用的
const slotsSrc = JS.match(/const SLOTS = \[([\s\S]*?)\n  \];/);
if (!slotsSrc) throw new Error('解析不到 SLOTS 常量表');
const SLOTS = [];
slotsSrc[1].replace(/\{\s*x:\s*(\d+),\s*y:\s*(\d+)\s*\}/g, (_, x, y) => {
  SLOTS.push({ x: +x, y: +y });
  return '';
});
if (SLOTS.length !== 9) throw new Error('SLOTS 应有 9 项，实际 ' + SLOTS.length);

// 桌面几何：.felt 的位置、尺寸、圆角
const feltBlock = block(CSS_TABLE, /^\.felt \{([\s\S]*?)\}/m, '.felt');
const F = {
  left: num(feltBlock, /left:\s*(\d+)px/, '.felt left'),
  top: num(feltBlock, /top:\s*(\d+)px/, '.felt top'),
  w: num(feltBlock, /width:\s*(\d+)px/, '.felt width'),
  h: num(feltBlock, /height:\s*(\d+)px/, '.felt height'),
  r: num(feltBlock, /border-radius:\s*(\d+)px/, '.felt border-radius')
};
F.right = F.left + F.w;
F.bottom = F.top + F.h;
// 直边区段：圆角之外的那一段
F.hx0 = F.left + F.r; F.hx1 = F.right - F.r;      // 水平直边的 x 范围
F.vy0 = F.top + F.r;  F.vy1 = F.bottom - F.r;     // 竖直直边的 y 范围

// 座位卡与牌区
const seatBlock = block(CSS_TABLE, /^\.seat \{([\s\S]*?)\}/m, '.seat');
const cardBlock = block(CSS_TABLE, /^\.card\.small \{([\s\S]*?)\}/m, '.card.small');
const SEAT_W = num(seatBlock, /width:\s*(\d+)px/, '.seat width');
const SEAT_H = num(seatBlock, /height:\s*(\d+)px/, '.seat height');
// --hole-peek 是「牌压住卡片顶部的高度」，不是探出量。
// 牌高 CARD_H，其中 PEEK 与卡片重叠，所以真正超出卡片外侧的是 CARD_H - PEEK。
const PEEK = num(seatBlock, /--hole-peek:\s*(\d+)px/, '--hole-peek');
const CARD_W = num(cardBlock, /width:\s*(\d+)px/, '.card.small width');
const CARD_H = num(cardBlock, /height:\s*(\d+)px/, '.card.small height');
const HOLE_OUT = CARD_H - PEEK;   // 牌超出卡片外侧的高度
const BOX_H = SEAT_H + HOLE_OUT;  // 碰撞盒高 = 卡片 + 牌超出的部分

/** 槽位是否属于画布上半部（牌朝下、下注额与徽章翻面），与 table.js 的 seatPos().flip 同源 */
const isFlip = s => s.y < CANVAS_H / 2;

/** 碰撞盒：卡片 + 牌超出卡片的部分。牌朝桌心，所以上半部的盒子向下扩、下半部向上扩。 */
function boxOf(s) {
  return isFlip(s)
    ? { x: s.x - SEAT_W / 2, y: s.y - SEAT_H / 2, r: s.x + SEAT_W / 2, b: s.y + SEAT_H / 2 + HOLE_OUT }
    : { x: s.x - SEAT_W / 2, y: s.y - SEAT_H / 2 - HOLE_OUT, r: s.x + SEAT_W / 2, b: s.y + SEAT_H / 2 };
}
/** 槽位中心在 .seats（铺满整块画布）里的百分比坐标，与 table.js 的 seatPos() 同一套算法 */
function pctOf(s) {
  return { left: s.x / CANVAS_W * 100, top: s.y / CANVAS_H * 100 };
}

/* ==================== A. 纯几何 ==================== */
function geometry() {
  console.log('[常量] 画布 ' + CANVAS_W + '×' + CANVAS_H +
    '；桌面 ' + F.w + '×' + F.h + ' @ (' + F.left + ',' + F.top + ') 圆角 ' + F.r);
  console.log('        水平直边 x: ' + F.hx0 + '~' + F.hx1 + '   竖直直边 y: ' + F.vy0 + '~' + F.vy1);
  console.log('        座位卡 ' + SEAT_W + '×' + SEAT_H + '，牌 ' + CARD_W + '×' + CARD_H +
    '（压卡 ' + PEEK + '，超出 ' + HOLE_OUT + '）-> 碰撞盒 ' + SEAT_W + '×' + BOX_H);

  ok(F.r * 2 < F.h, '圆角小于桌高一半（' + F.r + ' < ' + (F.h / 2) + '），左右保留竖直直边');
  ok(F.hx1 > F.hx0 && F.vy1 > F.vy0, '桌面存在水平与竖直直边区段');

  // ③ 全部落在直边区段上
  let arc = 0;
  SLOTS.forEach((s, i) => {
    const onH = (s.y === F.top || s.y === F.bottom) && s.x >= F.hx0 && s.x <= F.hx1;
    const onV = (s.x === F.left || s.x === F.right) && s.y >= F.vy0 && s.y <= F.vy1;
    if (!onH && !onV) { arc++; console.log('    ✗ 槽位 ' + i + ' (' + s.x + ',' + s.y + ') 不在直边上'); }
  });
  ok(arc === 0, '九个槽位全部落在桌面直边上，无一骑在圆角弧段');

  // ① 两两不重叠 + 报告最紧余量
  const boxes = SLOTS.map(boxOf);
  let overlap = 0, margin = Infinity, tight = '';
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b) {
        overlap++; console.log('    ✗ 槽位 ' + i + ' 与 ' + j + ' 重叠');
      }
      const g = Math.max(Math.max(b.x - a.r, a.x - b.r), Math.max(b.y - a.b, a.y - b.b));
      if (g < margin) { margin = g; tight = i + '-' + j; }
    }
  }
  ok(overlap === 0, '九席两两不重叠（最紧一对 ' + tight + ' 余量 ' + margin.toFixed(0) + 'px）');
  ok(margin >= 10, '最紧余量不低于 10px 安全线（当前 ' + margin.toFixed(0) + 'px）');

  // ② 全部落在画布内
  const out = boxes.filter(b => b.x < 0 || b.y < 0 || b.r > CANVAS_W || b.b > CANVAS_H);
  ok(out.length === 0, '九席碰撞盒完整落在画布内' + (out.length ? '（越界 ' + out.length + ' 个）' : ''));

  // ④ 同侧席位对齐
  const bottomY = SLOTS.filter(s => s.y === F.bottom).map(s => s.y);
  const topY = SLOTS.filter(s => s.y === F.top).map(s => s.y);
  const leftX = SLOTS.filter(s => s.x === F.left).map(s => s.x);
  const rightX = SLOTS.filter(s => s.x === F.right).map(s => s.x);
  const same = a => a.length > 1 && a.every(v => v === a[0]);
  ok(bottomY.length === 3 && same(bottomY), '底边三席纵坐标相同（' + bottomY.length + ' 席）');
  ok(topY.length === 2 && same(topY), '顶边两席纵坐标相同（' + topY.length + ' 席）');
  ok(leftX.length === 2 && same(leftX), '左侧两席横坐标相同（' + leftX.length + ' 席）');
  ok(rightX.length === 2 && same(rightX), '右侧两席横坐标相同（' + rightX.length + ' 席）');

  // ⑤ 左右镜像：把所有槽位按 x 镜像后，集合应与原集合相同
  const key = s => s.x + ',' + s.y;
  const orig = new Set(SLOTS.map(key));
  const mirrored = SLOTS.map(s => ({ x: CANVAS_W - s.x, y: s.y }));
  ok(mirrored.every(s => orig.has(key(s))), '九席相对画布中线左右镜像');

  // ⑥ 本人（槽位 0）在底边正中
  const me = SLOTS[0];
  ok(me.x === CANVAS_W / 2, '槽位 0（本人）横向居中（x=' + me.x + '）');
  ok(me.y === F.bottom, '槽位 0（本人）在桌面底边（y=' + me.y + '）');

  // 顶边正中留空（给底池信息条）
  ok(!SLOTS.some(s => s.x === CANVAS_W / 2 && s.y === F.top), '顶边正中未放槽位（留给底池信息条）');
}

/* ==================== A2. 旁观视角的分散算法 ====================
 * 未入座时没有「本人」可作基准，若直接拿服务端座位号当槽位号，
 * 少数几人会全落在编号相邻的槽位上（恰好同处底边），看起来像挤在一侧。
 * table.js 改为 round(j * 9 / n) 把在座玩家沿九席等距摊开。
 * 这里独立复算一遍，验证它在 1~9 人下都无冲突、保序、不全堆一边。 */
function spread() {
  // 槽位归属哪条边，由常量表反推（不写死编号）
  const sideOf = s => {
    if (s.y === F.bottom) return '底';
    if (s.y === F.top) return '顶';
    return s.x === F.left ? '左' : '右';
  };
  let bad = 0;
  for (let n = 1; n <= 9; n++) {
    const slots = [];
    for (let j = 0; j < n; j++) slots.push(Math.round(j * SLOTS.length / n) % SLOTS.length);
    const dup = new Set(slots).size !== slots.length;
    const sorted = slots.every((v, i) => i === 0 || v > slots[i - 1]);
    const sides = new Set(slots.map(i => sideOf(SLOTS[i])));
    const heaped = n > 1 && sides.size === 1;
    if (dup || !sorted || heaped) bad++;
    const tag = (dup ? ' 冲突' : '') + (sorted ? '' : ' 乱序') + (heaped ? ' 全堆一边' : '');
    ok(!dup && sorted && !heaped, n + ' 人分散到 [' + slots.join(',') +
      ']（' + slots.map(i => sideOf(SLOTS[i])).join('') + '）' + tag);
  }
  // 满席时必须退化成一一对应
  const full = [];
  for (let j = 0; j < 9; j++) full.push(Math.round(j * SLOTS.length / 9) % SLOTS.length);
  ok(full.join(',') === '0,1,2,3,4,5,6,7,8', '满席时分散退化为一一对应');
  if (bad) console.log('    （分散算法有 ' + bad + ' 档人数异常）');
}

/* ==================== B. CSS 规则 ==================== */
function cssRules() {
  // 检测只针对**生效的规则**，先剥掉注释：
  // 注释里提到已废除的机制（说明为什么废除）是有价值的，不该被当成残留。
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const T = strip(CSS_TABLE), A = strip(CSS_APP);
  const all = T + '\n' + A;
  // 任何按「是不是我」区分牌面尺寸的规则都会让底牌大小不一致，直接禁掉。
  // 只禁尺寸：`.seat.folded:not(.mine) .card.back { filter: … }` 这类纯视觉规则是允许的。
  const forbidden = [
    [/\.card\.my\b/, '.card.my（本人专用牌尺寸）'],
    [/[^{}]*(?:\.mine|:not\(\.mine\))[^{}]*\.card[^{}]*\{[^}]*(?:\bwidth|\bheight)\s*:/,
      '按 .mine / :not(.mine) 区分牌面尺寸的规则'],
    [/--seat-w/, '--seat-w（已退休的自适应变量）'],
    [/crowded/, 'crowded 选择器（已废除的按人数分级降级）'],
    [/dot-pop/, 'dot-pop 动画（反馈退化为圆点的残留）']
  ];
  forbidden.forEach(([re, name]) => ok(!re.test(all), 'CSS 里不存在 ' + name));

  ok(!/^\.felt \{[^}]*border-radius:\s*50%/m.test(T), '.felt 不再是椭圆（border-radius 非 50%）');
  const inMedia = /@media[^{]*\{[^@]*?\.card\.small[^}]*(?:width|height)\s*:/.test(all);
  ok(!inMedia, '.card.small 的尺寸没有被任何 @media 断点改写');
  const hits = all.match(/\.card\.small\s*\{[^}]*(?:width|height)\s*:/g) || [];
  ok(hits.length === 1, '.card.small 的尺寸只有一处定义（实际 ' + hits.length + ' 处）');
  // 牌与反馈必须分处卡片两侧，且随 .flip 一起翻转
  ok(/^\.act-flash \{[^}]*top:\s*calc\(100%/m.test(T),
    '动作反馈定位在座位卡下方（top: calc(100% …)）');
  ok(/^\.seat\.flip \.act-flash \{[^}]*bottom:\s*calc\(100%/m.test(T),
    '上半部槽位的反馈翻到卡片上方（牌朝下，两者不能同侧）');
  ok(/^\.seat\.flip \.last, \.seat\.flip \.thinking \{[^}]*bottom:\s*calc\(100%/m.test(T),
    '上半部槽位的状态文字也翻到卡片上方');
  ok(/^\.hole \{[^}]*bottom:\s*calc\(100%/m.test(T),
    '底牌定位在座位卡外侧（bottom: calc(100% …)）');
  // JS 侧不该再有椭圆几何、也不该再切 crowded 类
  const JSC = strip(JS);
  ok(!/ELLIPSE_RX|ELLIPSE_RY|MY_ANGLE|FELT_BORDER/.test(JSC),
    'table.js 里不存在椭圆几何与边框耦合常量');
  ok(!/crowded/.test(JSC), 'table.js 里不再切换 crowded 类');
}

/* ==================== 真实页面 ==================== */
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

/** 加载牌桌页，返回九个槽位的定位与内容。视口尺寸不影响任何几何，所以只开一种。 */
async function loadTable(token, ms = 4000) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
  const dom = await JSDOM.fromURL(BASE + '/table.html', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) { win.localStorage.setItem('poker_token', token); }
  });
  await sleep(ms);
  const doc = dom.window.document;
  const seats = [...doc.querySelectorAll('#seats .seat')].map(s => ({
    left: parseFloat(s.style.left), top: parseFloat(s.style.top),
    slot: parseInt(s.dataset.slot, 10),
    seatIdx: s.dataset.seat === undefined ? null : parseInt(s.dataset.seat, 10),
    empty: s.classList.contains('empty'),
    mine: s.classList.contains('mine'),
    flip: s.classList.contains('flip'),
    name: (s.querySelector('.nm') || {}).textContent || '',
    hasChips: !!s.querySelector('.chips'),
    hasHole: !!s.querySelector('.hole'),
    hasBet: !!s.querySelector('.bet'),
    hasFlash: !!s.querySelector('.act-flash'),
    cardCls: [...s.querySelectorAll('.hole .card')]
      .map(c => [...c.classList].filter(x => x !== 'red' && x !== 'black').sort().join(' '))
  }));
  const out = {
    seats,
    hasFit: !!doc.querySelector('.table-fit'),
    hasCanvas: !!doc.querySelector('.table-canvas'),
    feltInCanvas: !!doc.querySelector('.table-canvas .felt'),
    seatsInCanvas: !!doc.querySelector('.table-canvas #seats'),
    barOutside: !doc.querySelector('.table-canvas #action-bar') && !!doc.querySelector('#action-bar'),
    err: errs.slice(0, 3)
  };
  dom.window.close();
  return out;
}

(async function () {
  console.log('[A] 固定槽位几何（纯常量，不依赖服务端）');
  geometry();

  console.log('\n[A2] 旁观视角的分散算法');
  spread();

  console.log('\n[B] CSS 规则');
  cssRules();

  console.log('\n[C] 真实页面：4 人在座（九席应全部渲染）');
  const tag = 'L' + Math.random().toString(36).slice(2, 6);
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
  const r = await loadTable(cs[2].token);

  // 骨架
  ok(r.hasFit && r.hasCanvas, '存在 .table-fit 与 .table-canvas');
  ok(r.feltInCanvas && r.seatsInCanvas, '.felt 与 #seats 都在画布内');
  ok(r.barOutside, '操作条在画布之外（不随 --tscale 缩放）');

  // ⑦ 渲染九个槽位，而不是在座人数
  ok(r.seats.length === 9, '渲染出 9 个槽位（实际 ' + r.seats.length + '，在座仅 4 人）');
  const occupied = r.seats.filter(s => !s.empty);
  const empties = r.seats.filter(s => s.empty);
  ok(occupied.length === 4, '其中 4 个是在座玩家（实际 ' + occupied.length + '）');
  ok(empties.length === 5, '其中 5 个是空位占位（实际 ' + empties.length + '）');

  // 槽位编号齐全且不重复
  const slots = r.seats.map(s => s.slot).sort((a, b) => a - b);
  ok(slots.join(',') === '0,1,2,3,4,5,6,7,8', '槽位编号 0~8 齐全无重复（' + slots.join(',') + '）');

  // 渲染坐标必须等于常量表算出的值
  let bad = 0, worstDiff = 0;
  r.seats.forEach(s => {
    const e = pctOf(SLOTS[s.slot]);
    const d = Math.max(Math.abs(s.left - e.left), Math.abs(s.top - e.top));
    worstDiff = Math.max(worstDiff, d);
    if (d > 0.01) bad++;
  });
  ok(bad === 0, '九席渲染坐标与常量表一致（最大偏差 ' + worstDiff.toFixed(4) + '%）');

  // flip 类必须与「是否上半部」一致
  const flipBad = r.seats.filter(s => s.flip !== isFlip(SLOTS[s.slot]));
  ok(flipBad.length === 0, 'flip 类与槽位所在半部一致（异常 ' + flipBad.length + ' 个）');

  // 本人落在槽位 0（底边正中）
  const mine = r.seats.find(s => s.mine);
  ok(!!mine, '存在「我的」座位');
  if (mine) {
    ok(mine.slot === 0, '本人位于槽位 0（实际 ' + mine.slot + '）');
    ok(Math.abs(mine.left - 50) < 0.01, '本人横向居中（left=' + mine.left + '%）');
    ok(mine.top > 50, '本人在下半部（top=' + mine.top.toFixed(1) + '%）');
  }

  // 旁观视角：未入座时在座玩家必须分散，不能全堆在同一条桌边。
  // 另起一个客户端加入房间但不坐下，用它的 token 打开牌桌。
  const spec = await wsClient();
  spec.send({ type: 'register', name: tag + '_spec', password: 'test123456' });
  await spec.wait('auth');
  spec.send({ type: 'joinRoom', roomId: host.roomId });
  await spec.wait('joined').catch(() => null);
  await sleep(500);
  const spectator = await loadTable(spec.token);
  if (spectator) {
    const sSeats = spectator.seats;
    ok(sSeats.length === 9, '旁观视角也渲染 9 个槽位（实际 ' + sSeats.length + '）');
    ok(!sSeats.some(s => s.mine), '旁观视角没有槽位被标记为本人');
    const sideOf = s => {
      const slot = SLOTS[s.slot];
      if (slot.y === F.bottom) return '底';
      if (slot.y === F.top) return '顶';
      return slot.x === F.left ? '左' : '右';
    };
    const occ = sSeats.filter(s => !s.empty);
    if (occ.length > 1) {
      const sides = new Set(occ.map(sideOf));
      ok(sides.size > 1, '旁观视角下 ' + occ.length + ' 位在座玩家不堆在同一条桌边（占 ' +
        [...sides].join('') + ' 边，槽位 ' + occ.map(s => s.slot).sort((a, b) => a - b).join(',') + '）');
    } else {
      console.log('    · 旁观时在座人数不足 2，跳过分散断言');
    }
  }
  try { spec.ws.close(); } catch (e) { /* ignore */ }

  // ⑧ 空位不含任何玩家信息，也不带 data-seat
  const dirty = empties.filter(s => s.name || s.hasChips || s.hasHole || s.hasBet || s.hasFlash);
  ok(dirty.length === 0, '空位不含昵称/筹码/底牌/下注额/反馈（异常 ' + dirty.length + ' 个）');
  ok(empties.every(s => s.seatIdx === null), '空位不携带 data-seat（不指向任何服务端座位）');

  // 底牌尺寸一致
  const withCards = occupied.filter(s => s.cardCls.length);
  const clsSet = [...new Set(withCards.map(s => s.cardCls.map(c => c.replace(/\bback\b/, '').trim()).join('|')))];
  ok(withCards.length === 0 || clsSet.length === 1,
    '所有在座槽位的底牌用同一个尺寸 class（' + JSON.stringify(clsSet) + '）');
  ok(withCards.every(s => s.cardCls.every(c => /\bsmall\b/.test(c))), '底牌都是 .card.small');

  if (r.err.length) console.log('    页面错误：' + r.err.join(' | '));

  cs.forEach(c => { try { c.ws.close(); } catch (e) { /* ignore */ } });
  console.log('\n' + (fails === 0 ? '布局测试全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
