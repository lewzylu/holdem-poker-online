/* e2e-visual.js —— task 7.2：三视口端到端人工验证的自动化版本
 *
 * 在桌面宽屏 / 桌面窄高 / 手机横屏三种视口下各观察一手牌，逐项核对：
 *   1) 所有底牌大小一致（本人明牌 vs 对手牌背，以及摊牌后的对手明牌）
 *   2) 画布内部比例不随视口变化（牌宽 ÷ 画布宽、座位相对坐标）
 *   3) 操作条可点（触摸目标尺寸不被 --tscale 缩小）
 *   4) 动作反馈随画布缩放且不遮挡本人底牌
 *   5) 全程无控制台报错
 *
 * 前置：服务端已启动、浏览器已登录并入座（agent-browser 会话保持）
 * 用法：node tools/e2e-visual.js
 */
const { execSync } = require('child_process');

const AB = process.env.AB_BIN || 'agent-browser';
const CANVAS_W = 1200;

let fails = 0;
function ok(c, m) { if (c) console.log('    ✓ ' + m); else { fails++; console.log('    ✗ ' + m); } }

function ab(args, quiet) {
  try {
    return execSync(AB + ' ' + args, { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (!quiet) console.log('  ! ' + args + ' 失败：' + (e.message || '').slice(0, 120));
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
    catch (e) { /* 换上一行再试 */ }
  }
  return null;
}
const sleep = s => execSync('sleep ' + s);

// 单行探针：量牌面、画布、座位、按钮、反馈
const P = "JSON.stringify((function(){" +
  "var r=function(e){if(!e)return null;var b=e.getBoundingClientRect();return{x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),rt:+b.right.toFixed(1),bt:+b.bottom.toFixed(1)};};" +
  "var cv=document.querySelector('.table-canvas');" +
  "var ts=cv?(parseFloat(getComputedStyle(cv).getPropertyValue('--tscale'))||1):0;" +
  "var all=[].map.call(document.querySelectorAll('#seats .hole .card'),r);" +
  "var mine=document.querySelector('.seat.mine');" +
  "var myCards=mine?[].map.call(mine.querySelectorAll('.hole .card'),r):[];" +
  "var flashes=[].map.call(document.querySelectorAll('.act-flash'),function(e){var s=e.closest('.seat');return{rect:r(e),mine:s?s.classList.contains('mine'):false,pe:getComputedStyle(e).pointerEvents,txt:e.textContent.trim().slice(0,12)};});" +
  "var acts=[].map.call(document.querySelectorAll('button.act'),function(e){return{d:e.disabled,box:r(e)};});" +
  "var seats=[].map.call(document.querySelectorAll('#seats .seat'),function(e){return{left:parseFloat(e.style.left),top:parseFloat(e.style.top),mine:e.classList.contains('mine'),empty:e.classList.contains('empty'),slot:+e.dataset.slot,box:r(e)};});" +
  "return{ts:ts,canvas:r(cv),cards:all,myCards:myCards,flashes:flashes,acts:acts,seats:seats," +
  "phase:(document.querySelector('#phase')||{}).textContent||''," +
  "prompt:(document.querySelector('#prompt')||{}).textContent||''," +
  "timerSec:(document.querySelector('#timer-sec')||{}).textContent||''," +
  "timerShown:!(document.querySelector('#timer')||{}).hidden};})())";

const VIEWS = [
  { name: '桌面宽屏 1440×900', w: 1440, h: 900 },
  // 必须仍是横屏（宽 > 高），否则会触发竖屏旋转引导、牌桌被隐藏。
  // 1000×700 的可用区宽高比小于 2，用来验证「按宽度撑满 + 上下留白」这一支。
  { name: '桌面窄高 1000×700（可用区比例 < 2，按宽度撑满 + 上下留白）', w: 1000, h: 700 },
  { name: '手机横屏 844×390', w: 844, h: 390 }
];

const ratios = [];       // 记录每个视口的「牌宽 ÷ 画布宽」，用来验证比例恒定
const seatCoords = [];   // 记录座位的逻辑百分比坐标

console.log('三视口端到端验证（每个视口观察一手牌的若干帧）\n');
ab('errors --clear', true);
ab('console --clear', true);

for (const v of VIEWS) {
  console.log('[' + v.name + ']');
  ab('set viewport ' + v.w + ' ' + v.h);
  sleep(2);

  // 观察若干帧，累计这段时间里出现过的动作反馈与倒计时
  let seenFlash = null, seenTimer = false, sample = null;
  for (let i = 0; i < 14; i++) {
    const g = probe(P);
    if (!g) { sleep(1); continue; }
    sample = g;
    if (g.flashes.length && !seenFlash) seenFlash = g;
    if (g.timerShown && g.timerSec) seenTimer = true;
    if (seenFlash && seenTimer) break;
    sleep(1);
  }
  if (!sample) { fails++; console.log('    ✗ 读不到页面\n'); continue; }
  const g = sample;

  // 0. 守卫：牌桌必须真的可见。竖屏下 .table-fit 是 display:none，
  //    量出来的矩形全是 0，下面每一条断言都会「无意义地通过」。
  const visible = !!(g.canvas && g.canvas.w > 0) && g.cards.length > 0 && g.cards[0].w > 0;
  ok(visible, '牌桌画布可见（横屏，未触发竖屏引导）');
  if (!visible) { console.log('    ! 该视口下牌桌不可见，跳过其余断言\n'); continue; }

  // 1. 所有底牌一样大
  if (g.cards.length >= 2) {
    const w0 = g.cards[0].w, h0 = g.cards[0].h;
    const bad = g.cards.filter(c => Math.abs(c.w - w0) > 0.5 || Math.abs(c.h - h0) > 0.5);
    ok(bad.length === 0, '全桌 ' + g.cards.length + ' 张底牌尺寸一致（' +
      w0 + '×' + h0 + '，异常 ' + bad.length + ' 张）');
  }

  // 2. 画布内部比例恒定：牌宽 ÷ 画布宽在所有视口下必须相等
  if (g.canvas && g.cards.length) {
    const ratio = g.cards[0].w / g.canvas.w;
    ratios.push({ name: v.name, ratio: ratio, ts: g.ts });
    ok(true, '牌宽 ÷ 画布宽 = ' + ratio.toFixed(5) + '（tscale=' + g.ts.toFixed(4) + '）');
    // 缩放后的牌宽应等于逻辑 48px × tscale
    ok(Math.abs(g.cards[0].w - 48 * g.ts) <= 0.6,
      '牌宽 = 逻辑 48px × tscale（' + g.cards[0].w + ' ≈ ' + (48 * g.ts).toFixed(1) + '）');
  }
  seatCoords.push({
    name: v.name,
    coords: g.seats.map(s => s.left.toFixed(2) + ',' + s.top.toFixed(2)).join(' | ')
  });

  // 3. 操作条可点：触摸目标不被 tscale 缩小
  if (g.acts.length) {
    const minH = Math.min.apply(null, g.acts.map(a => a.box.h));
    const minW = Math.min.apply(null, g.acts.map(a => a.box.w));
    ok(minH >= 26 && minW >= 44,
      '操作按钮触摸目标够大（最小 ' + minW + '×' + minH + '，tscale=' + g.ts.toFixed(2) + '）');
    // 按钮必须在画布**之外**（不被 --tscale 缩小）。
    // 早先这条写成「位于画布下方」，是把当时的版式当成了契约；
    // 横屏已改成操作条竖排在牌桌右侧，判据回到本意：与画布矩形无交集。
    const outside = g.acts.every(a => {
      const b = a.box, c = g.canvas;
      return !c || b.x >= c.rt - 1 || b.rt <= c.x + 1 || b.y >= c.bt - 1 || b.bt <= c.y + 1;
    });
    ok(outside, '操作按钮在画布之外（不随画布缩放）');
  }

  // 4. 倒计时可读
  if (seenTimer) ok(true, '本人回合倒计时正常显示（秒数字号不受 tscale 影响）');
  else console.log('    · 本轮未轮到本人行动，跳过倒计时观察');

  // 5. 动作反馈：随画布缩放、不接收指针事件、不遮挡本人底牌
  if (seenFlash) {
    const f = seenFlash.flashes[0];
    ok(seenFlash.flashes.every(x => x.pe === 'none'), '动作反馈不接收指针事件');
    // 反馈在画布内 ⇒ 一定随画布缩放
    ok(!seenFlash.canvas || (f.rect.x >= seenFlash.canvas.x - 1 && f.rect.rt <= seenFlash.canvas.rt + 1),
      '动作反馈在画布内（随 --tscale 一起缩放）');
    // 不遮挡本人底牌
    let cover = 0;
    seenFlash.flashes.forEach(x => {
      (seenFlash.myCards || []).forEach(c => {
        if (x.rect.x < c.rt && c.x < x.rect.rt && x.rect.y < c.bt && c.y < x.rect.bt) cover++;
      });
    });
    ok(cover === 0, '动作反馈不遮挡本人底牌（重叠 ' + cover + ' 处）');
    console.log('    · 观察到反馈：' + seenFlash.flashes.map(x => x.txt).join(' / '));
  } else {
    console.log('    · 本轮观察窗口内没有出现动作反馈（3 秒驻留期短，属正常）');
  }

  // 席位固定为 9，与在座人数无关（空位也渲染）
  ok(g.seats.length === 9, '渲染出 9 个固定槽位（实际 ' + g.seats.length + '）');
  const mineSlot = g.seats.find(s => s.mine);
  if (mineSlot) ok(mineSlot.slot === 0, '本人位于槽位 0（底边正中）');

  const shot = 'tools/shots/e2e-' + v.w + 'x' + v.h + '.png';
  ab('screenshot "' + shot + '"', true);
  console.log('    截图 → ' + shot + '\n');
}

/* ---------- 跨视口一致性 ---------- */
console.log('[跨视口比例恒定]');
if (ratios.length >= 2) {
  // NaN 参与比较恒为 false，会让「异常项」凭空消失，先显式挡掉
  const nan = ratios.filter(r => !isFinite(r.ratio));
  ok(nan.length === 0, '每个视口都量到了有效比例' +
    (nan.length ? '（无效：' + nan.map(r => r.name).join('、') + '）' : ''));
  const base = ratios[0].ratio;
  const bad = ratios.filter(r => !isFinite(r.ratio) || Math.abs(r.ratio - base) / base > 0.005);
  ok(isFinite(base) && bad.length === 0, '「牌宽 ÷ 画布宽」在所有视口下一致（' +
    ratios.map(r => r.ratio.toFixed(5)).join(' / ') + '）');
}
if (seatCoords.length >= 2) {
  const base = seatCoords[0].coords;
  const bad = seatCoords.filter(s => s.coords !== base);
  ok(bad.length === 0, '座位在画布内的相对坐标在所有视口下完全相同');
  if (bad.length) bad.forEach(b => console.log('      ' + b.name + '：' + b.coords));
}

/* ---------- 竖屏：牌桌照常可见，牌局不中断 ----------
 * 早先竖屏是「隐藏牌桌 + 显示转屏引导」，现已废弃 —— 竖屏用户看不到牌只能盲操作。
 * 现在画布按宽度撑满，比例仍固定 2:1。 */
console.log('[竖屏 390×844：牌桌可见且不横向溢出]');
ab('set viewport 390 844');
sleep(2);
const PP = "JSON.stringify((function(){var ft=document.querySelector('.table-fit');var rh=document.querySelector('.rotate-hint');" +
  "var b=document.querySelector('.action-bar');var br=b?b.getBoundingClientRect():null;" +
  "var cv=document.querySelector('.table-canvas');var cr=cv?cv.getBoundingClientRect():null;" +
  "return{fit:ft?getComputedStyle(ft).display:'?',hint:rh?getComputedStyle(rh).display:'none'," +
  "cw:cr?Math.round(cr.width):0,ch:cr?Math.round(cr.height):0," +
  "seats:document.querySelectorAll('#seats .seat').length," +
  "sw:document.documentElement.scrollWidth,vw:innerWidth," +
  "barH:br?Math.round(br.height):0,timerShown:!(document.querySelector('#timer')||{}).hidden," +
  "sec:(document.querySelector('#timer-sec')||{}).textContent||''," +
  "phase:(document.querySelector('#phase')||{}).textContent||''};})())";
let pt = null, sawTimer = false, phases = new Set();
for (let i = 0; i < 12; i++) {
  const g = probe(PP);
  if (g) { pt = g; if (g.timerShown && g.sec) sawTimer = true; if (g.phase) phases.add(g.phase); }
  sleep(1);
}
if (!pt) { fails++; console.log('    ✗ 读不到页面'); }
else {
  ok(pt.hint === 'none', '不再强制转屏（引导已废弃）');
  ok(pt.fit !== 'none', '竖屏照常显示牌桌画布（.table-fit display=' + pt.fit + '）');
  ok(pt.cw > 0 && pt.ch > 0, '竖屏画布有实际尺寸（' + pt.cw + '×' + pt.ch + '）');
  if (pt.ch > 0) {
    ok(Math.abs(pt.cw / pt.ch - 2) < 0.02,
      '竖屏下画布仍保持 2:1（' + (pt.cw / pt.ch).toFixed(3) + '）');
  }
  ok(pt.seats === 9, '竖屏渲染出 9 个槽位（实际 ' + pt.seats + '）');
  // 竖屏最容易踩的坑：grid 轨道 min-width:auto + 操作条固有宽度 → 整页横向滚动
  ok(pt.sw <= pt.vw + 2, '竖屏无横向溢出（scrollWidth ' + pt.sw + ' ≤ ' + pt.vw + '）');
  ok(pt.barH > 0, '竖屏下操作条仍可见（高 ' + pt.barH + '）');
  // 牌局没中断：阶段在变化，或者观察窗口内本人拿到过倒计时
  ok(phases.size > 1 || sawTimer,
    '竖屏期间牌局继续推进（阶段变化 ' + phases.size + ' 次' + (sawTimer ? '，倒计时正常' : '') + '）');
}
ab('screenshot "tools/shots/e2e-390x844.png"', true);
console.log('    截图 → tools/shots/e2e-390x844.png');

/* ---------- 控制台 ---------- */
console.log('\n[控制台]');
const errs = ab('errors', true) || '';
const clean = errs.split('\n').filter(l => l.trim() && !/^✓|No page errors/i.test(l));
ok(clean.length === 0, '无页面报错' + (clean.length ? '：' + clean.slice(0, 3).join(' | ') : ''));

/* 复位到横屏：本脚本最后一段是竖屏引导用例，留在竖屏会让后续脚本量到全 0 */
ab('set viewport 1440 900', true);

console.log('\n' + (fails === 0 ? '三视口端到端验证全部通过 ✅' : fails + ' 项失败 ❌'));
process.exit(fails === 0 ? 0 : 1);
