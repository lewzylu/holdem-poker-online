/* visual-check.js —— 用真实 Chromium 量牌桌的固定画布缩放与固定槽位
 *
 * 牌桌是一块固定 1200×600（2:1）的逻辑画布，整体按 min(可用宽/1200, 可用高/600)
 * 等比缩放后居中，多余空间留白；画布内是一张圆角长方形桌面 + 九个固定座位槽位。
 * 这个脚本验证的是「缩放对不对」与「九席排布对不对」：
 *  - --tscale 是否等于 min(可用宽/1200, 可用高/600)
 *  - 缩放后的画布是否完整落在可用区域内、左右上下留白是否对称
 *  - 有没有出现横向/纵向滚动条
 *  - 是否渲染出九个槽位（与在座人数无关）、本人是否在槽位 0
 *  - 座位有没有互相重叠（等比缩放下这个判定是尺度不变的，可直接在实测坐标上做）
 *  - 底牌与动作反馈是否分处座位卡两侧、互不重叠
 *  - 信息条与公共牌有没有被座位压住
 *  - 本人底牌与对手牌背是否严格等大
 *  - 操作按钮是否没被 --tscale 缩小（它在画布之外）
 *  - 竖屏是否显示旋转引导、画布是否隐藏
 *
 * 前置：服务端已启动、已用 agent-browser 登录进牌桌（或先在浏览器里坐下一局）
 * 用法：node tools/visual-check.js
 */
const { execSync } = require('child_process');
const path = require('path');

const CANVAS_W = 1200, CANVAS_H = 600;      // 必须与 table.js / table.css 一致
const SHOT_DIR = path.join(__dirname, 'shots');
require('fs').mkdirSync(SHOT_DIR, { recursive: true });

function ab(args, quiet) {
  try {
    return execSync('agent-browser ' + args, { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (!quiet) console.log('  ! agent-browser ' + args + ' 失败：' + (e.message || '').slice(0, 120));
    return null;
  }
}

// 在页面里量一圈几何信息，返回 JSON。注意：agent-browser 的 eval 只接受单行 JS
const PROBE = "(()=>{const q=s=>document.querySelector(s);const rect=e=>{if(!e)return null;const b=e.getBoundingClientRect();return{x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),r:+b.right.toFixed(1),bt:+b.bottom.toFixed(1)};};const cv=q('.table-canvas');const ts=cv?(parseFloat(getComputedStyle(cv).getPropertyValue('--tscale'))||1):0;const seats=[...document.querySelectorAll('#seats .seat')].map(e=>{const h=e.querySelector('.hole');const fl=e.querySelector('.act-flash');const cs=e.querySelectorAll('.hole .card');let cardGap=null,rankGap=null;if(cs.length>1){const a=cs[0].getBoundingClientRect(),b=cs[1].getBoundingClientRect();cardGap=+(a.right-b.left).toFixed(1);const rk=cs[0].querySelector('.rank');if(rk)rankGap=+(b.left-rk.getBoundingClientRect().right).toFixed(1);}return Object.assign({mine:e.classList.contains('mine'),empty:e.classList.contains('empty'),slot:+e.dataset.slot,flip:e.classList.contains('flip'),hole:rect(h),parts:[...e.querySelectorAll('.info > .avatar, .info > .nm, .info > .chips')].map(rect),flash:rect(fl),cardGap:cardGap,rankGap:rankGap},rect(e));});const acts=[...document.querySelectorAll('button.act')].map(e=>Object.assign({t:e.textContent.trim().slice(0,4)},rect(e)));const rh=q('.rotate-hint');const ft=q('.table-fit');const sd=q('.side');const bd=q('.board');const hs=getComputedStyle(document.documentElement);const bs=getComputedStyle(document.body);return JSON.stringify({vw:innerWidth,vh:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,ts:ts,fit:rect(ft),canvas:rect(cv),bar:rect(q('.action-bar')),felt:rect(q('.felt')),seats:seats,acts:acts,myCard:rect(q('.seat.mine .hole .card')),opCard:rect(q('.seat:not(.mine):not(.empty) .hole .card')),top:rect(q('.table-top')),board:rect(bd),boardN:bd?bd.querySelectorAll('.card').length:0,rotate:rh?getComputedStyle(rh).display:'none',fitDisp:ft?getComputedStyle(ft).display:'none',sideDisp:sd?getComputedStyle(sd).display:'none',htmlBg:hs.backgroundColor,bodyBg:bs.backgroundColor});})()";

const DEVICES = [
  { name: '桌面 1440×900', w: 1440, h: 900, portrait: false },
  { name: '笔记本 1280×720', w: 1280, h: 720, portrait: false },
  { name: 'iPad 横屏 1180×820', w: 1180, h: 820, portrait: false },
  // 宽而矮的真机横屏：曾经因为 grid 仍留着 320px 侧栏轨道，牌桌白丢三成宽度
  { name: '安卓横屏 1080×490', w: 1080, h: 490, portrait: false },
  { name: 'iPhone 14 横屏 844×390', w: 844, h: 390, portrait: false },
  { name: 'iPhone SE 横屏 667×375', w: 667, h: 375, portrait: false },
  { name: '小安卓横屏 640×320', w: 640, h: 320, portrait: false },
  { name: '竖屏手机 390×844', w: 390, h: 844, portrait: true },
  { name: '竖屏小屏 360×640', w: 360, h: 640, portrait: true }
];

let fails = 0;
function ok(c, m) { if (c) console.log('    ✓ ' + m); else { fails++; console.log('    ✗ ' + m); } }

console.log('在真实 Chromium 中量取固定画布的缩放（共 ' + DEVICES.length + ' 种视口）\n');

for (const d of DEVICES) {
  console.log('[' + d.name + ']');
  ab('set viewport ' + d.w + ' ' + d.h);
  execSync('sleep 1');                      // 等 resize 触发的 fitCanvas
  const out = ab('eval "' + PROBE + '"');
  if (!out) { fails++; console.log('    ✗ 无法读取页面'); continue; }
  let g;
  try {
    g = JSON.parse(out.trim());
    // agent-browser 的 eval 会把返回值再 JSON.stringify 一次，字符串结果要解两层
    if (typeof g === 'string') g = JSON.parse(g);
  }
  catch (e) { fails++; console.log('    ✗ 解析失败：' + out.slice(0, 300)); continue; }
  if (!g || !Array.isArray(g.seats)) {
    fails++; console.log('    ✗ 返回结果缺少 seats：' + JSON.stringify(g).slice(0, 300)); continue;
  }

  // 1. 不能出现滚动条（竖屏的引导页也应当一屏放下）
  ok(g.sw <= g.vw + 2, '无横向滚动（scrollWidth ' + g.sw + ' ≤ 视口 ' + g.vw + '）');

  /* 1b. 画布背景必须是**实色**，不能是透明。
   * 页面用了 viewport-fit=cover，浏览器拿背景色（不是背景图）去填刘海/圆角/安全区
   * 之外的那一圈；body 若只写 `background: <gradient>` 简写，background-color 会被
   * 重置成 transparent，那一圈就露出默认的白色画布 —— 手机横屏上是屏幕左右两条白边。
   * html 与 body 都要有：html 一旦有背景，body 的背景就不再传播到画布。 */
  const opaque = c => !!c && !/transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c);
  ok(opaque(g.htmlBg) && opaque(g.bodyBg),
    'html 与 body 都有实色背景，安全区不露白（html=' + g.htmlBg + '，body=' + g.bodyBg + '）');

  /* ---------- 竖屏：牌桌照常显示，只是按宽度缩放 ----------
   * 早先竖屏是「隐藏牌桌 + 显示转屏引导」，现已废弃：竖屏用户看不到牌只能盲操作。
   * 现在画布在竖屏下按**宽度**撑满（高度只用到宽度的一半），比例仍是固定 2:1。 */
  if (d.portrait) {
    ok(g.rotate === 'none', '不再强制转屏（引导已废弃，display=' + g.rotate + '）');
    ok(g.fitDisp !== 'none', '竖屏照常显示牌桌画布（.table-fit display=' + g.fitDisp + '）');
    ok(!!g.canvas && g.canvas.w > 0, '竖屏画布有实际尺寸（' +
      (g.canvas ? g.canvas.w + '×' + g.canvas.h : '量不到') + '）');
    if (g.canvas && g.canvas.h > 0) {
      ok(Math.abs(g.canvas.w / g.canvas.h - 2) < 0.02,
        '竖屏下画布仍保持 2:1（' + (g.canvas.w / g.canvas.h).toFixed(3) + '）');
      // 竖屏宽度是稀缺资源，画布应当基本吃满可用宽度（留白不超过 8%）
      ok(g.fit && g.canvas.w >= g.fit.w * 0.92,
        '竖屏画布吃满可用宽度（' + g.canvas.w + ' / ' + (g.fit ? g.fit.w : '?') + '）');
    }
    ok(g.seats.length === 9, '竖屏也渲染出 9 个槽位（实际 ' + g.seats.length + '）');
    ok(g.bar && g.bar.h > 0, '竖屏下操作条仍然可见（高 ' + (g.bar ? g.bar.h : 0) + '）');
    const shotP = path.join(SHOT_DIR, d.w + 'x' + d.h + '.png');
    ab('screenshot "' + shotP + '"', true);
    console.log('    截图 → ' + path.relative(process.cwd(), shotP) + '\n');
    continue;
  }

  /* ---------- 横屏 ---------- */
  ok(g.sh <= g.vh + 4, '一屏放下，无纵向滚动（scrollHeight ' + g.sh + ' ≤ ' + g.vh + '）');
  ok(g.rotate === 'none', '横屏不显示旋转引导');
  if (!g.fit || !g.canvas) { fails++; console.log('    ✗ 量不到 .table-fit / .table-canvas\n'); continue; }

  // 2. --tscale 必须等于 min(可用宽/1200, 可用高/600)
  const want = Math.min(g.fit.w / CANVAS_W, g.fit.h / CANVAS_H);
  ok(Math.abs(g.ts - want) / want < 0.01,
    '--tscale = min(' + g.fit.w + '/1200, ' + g.fit.h + '/600) = ' +
    want.toFixed(4) + '（实际 ' + g.ts.toFixed(4) + '）');

  // 3. 缩放是等比的：画布的实测宽高必须等于逻辑尺寸 × tscale，比例仍是 2:1
  ok(Math.abs(g.canvas.w - CANVAS_W * g.ts) <= 2 && Math.abs(g.canvas.h - CANVAS_H * g.ts) <= 2,
    '画布等比缩放，无单轴拉伸（' + g.canvas.w + '×' + g.canvas.h +
    ' ≈ ' + Math.round(CANVAS_W * g.ts) + '×' + Math.round(CANVAS_H * g.ts) + '）');
  ok(Math.abs(g.canvas.w / g.canvas.h - 2) < 0.02,
    '画布宽高比保持 2:1（' + (g.canvas.w / g.canvas.h).toFixed(3) + '）');

  // 4. 画布完整落在可用区域内
  ok(g.canvas.x >= g.fit.x - 1 && g.canvas.r <= g.fit.r + 1 &&
    g.canvas.y >= g.fit.y - 1 && g.canvas.bt <= g.fit.bt + 1,
    '画布完整落在可用区域内');

  // 5. 留白对称
  const padL = g.canvas.x - g.fit.x, padR = g.fit.r - g.canvas.r;
  const padT = g.canvas.y - g.fit.y, padB = g.fit.bt - g.canvas.bt;
  ok(Math.abs(padL - padR) <= 2, '左右留白对称（' + padL.toFixed(1) + ' / ' + padR.toFixed(1) + '）');
  ok(Math.abs(padT - padB) <= 2, '上下留白对称（' + padT.toFixed(1) + ' / ' + padB.toFixed(1) + '）');

  // 6. 座位两两不重叠。等比缩放是尺度不变的，直接在实测坐标上判定即可，
  //    也不再给「我的座位」开豁免 —— 所有人现在共用同一套尺寸。
  let overlap = 0;
  for (let i = 0; i < g.seats.length; i++) {
    for (let j = i + 1; j < g.seats.length; j++) {
      const a = g.seats[i], b = g.seats[j];
      if (a.x < b.r && b.x < a.r && a.y < b.bt && b.y < a.bt) overlap++;
    }
  }
  ok(overlap === 0, g.seats.length + ' 个座位互不重叠' + (overlap ? '（重叠 ' + overlap + ' 对）' : ''));
  // 6b. 席位数固定为 9，与在座人数无关
  ok(g.seats.length === 9, '渲染出 9 个固定槽位（实际 ' + g.seats.length + '）');
  const slots = g.seats.map(s => s.slot).sort((a, b) => a - b).join(',');
  ok(slots === '0,1,2,3,4,5,6,7,8', '槽位编号 0~8 齐全无重复');
  const mineSeat = g.seats.find(s => s.mine);
  if (mineSeat) ok(mineSeat.slot === 0, '本人位于槽位 0（底边正中）');

  // 7. 座位都在画布内（画布本身已在可用区域内，于是也在视口内）
  const outCv = g.seats.filter(s => s.x < g.canvas.x - 1 || s.r > g.canvas.r + 1 ||
    s.y < g.canvas.y - 1 || s.bt > g.canvas.bt + 1);
  ok(outCv.length === 0, '所有座位都在画布内' + (outCv.length ? '（越界 ' + outCv.length + ' 个）' : ''));

  // 7b. 桌面中央的信息条与公共牌不能被座位压住。
  //     顶边正中刻意不放槽位就是为了给信息条腾地方；这条断言守着那个约定。
  const hit = (a, b) => a && b && a.x < b.r && b.x < a.r && a.y < b.bt && b.y < a.bt;
  const topHit = g.seats.filter(s => hit(g.top, s));
  ok(topHit.length === 0, '顶部信息条（底池/房间号）不被座位遮挡' +
    (topHit.length ? '（被 ' + topHit.length + ' 个座位压住）' : ''));
  if (g.boardN > 0) {
    const bdHit = g.seats.filter(s => hit(g.board, s));
    ok(bdHit.length === 0, '公共牌不被座位遮挡' +
      (bdHit.length ? '（被 ' + bdHit.length + ' 个座位压住）' : ''));
    ok(!hit(g.top, g.board), '信息条与公共牌不重叠');
  }

  // 7c. 底牌与动作反馈必须分处座位卡两侧，且不互相重叠。
  //     牌朝桌心，所以「另一侧」随 .flip 翻转：下半部槽位牌在上、反馈在下；
  //     上半部槽位牌在下、反馈在上。废除按人数降级后反馈永远是文字、
  //     没有退化成圆点的退路，一旦重叠就是长期遮挡底牌。
  const bothSides = g.seats.filter(s => s.hole && s.flash);
  if (bothSides.length) {
    const clash = bothSides.filter(s => hit(s.hole, s.flash));
    ok(clash.length === 0, '底牌与动作反馈不重叠（同时存在的 ' + bothSides.length +
      ' 个座位中冲突 ' + clash.length + ' 个）');
    const wrongDown = bothSides.filter(s => !s.flip && !(s.hole.bt <= s.flash.y + 1));
    ok(wrongDown.length === 0, '下半部槽位的底牌在反馈上方（异常 ' + wrongDown.length + ' 个）');
    const wrongUp = bothSides.filter(s => s.flip && !(s.flash.bt <= s.hole.y + 1));
    ok(wrongUp.length === 0, '上半部槽位的反馈在底牌上方（异常 ' + wrongUp.length + ' 个）');
  } else {
    console.log('    · 当前没有座位同时持牌并显示反馈，跳过分侧断言');
  }
  // 7d. 底牌不能压住座位卡的内容（头像 / 昵称 / 筹码）。
  //     牌是 z-index 更低的浮层，文字永远画在上面，所以这不是可读性问题而是观感问题：
  //     白牌底上衬着白字，对比度很差。用户看图反馈过一次，这条断言就是为它加的。
  //
  //     ⚠️ 量的必须是内容元素本身，不能量 .info：.info 铺满整个卡片（靠 padding
  //     给牌区让位），它的盒子与牌区必然交叠，拿它判定会永远失败。
  //
  //     判定留 1px 容差：.info 的 padding 精确等于 --hole-peek，牌区下沿与内容上沿
  //     在逻辑坐标上正好重合，经 --tscale 缩放后会出现 0.1~0.4px 的浮点误差，
  //     零容差会把「刚好贴合」误报成「压住」。
  const withInfo = g.seats.filter(s => s.hole && s.parts && s.parts.length);
  if (withInfo.length) {
    const EPS = 1;
    const deep = (a, b) => Math.min(a.bt, b.bt) - Math.max(a.y, b.y);
    let press = 0, worst = 0;
    withInfo.forEach(s => s.parts.forEach(p => {
      if (hit(s.hole, p) && deep(s.hole, p) > EPS) {
        press++; worst = Math.max(worst, deep(s.hole, p));
      }
    }));
    ok(press === 0, '底牌不压座位卡内容（持牌的 ' + withInfo.length +
      ' 个座位共 ' + withInfo.reduce((n, s) => n + s.parts.length, 0) + ' 个内容元素，冲突 ' +
      press + ' 处' + (press ? '，最深 ' + (worst / g.ts).toFixed(1) + 'px' : '') + '）');
  }
  // 7e. 两张底牌是叠压的，但下层那张的读数不能被上层压掉。
  //     叠压量 14px 已经贴着「点数居中排版」的极限，下层牌的内容靠 translateX 左移避让；
  //     一旦避让失效，「10」这类两位数点数会被直接切掉。
  const fans = g.seats.filter(s => s.cardGap !== null && s.cardGap !== undefined);
  if (fans.length) {
    const overlapped = fans.filter(s => s.cardGap > 0);
    ok(overlapped.length === fans.length,
      '两张底牌为叠压排布（' + overlapped.length + '/' + fans.length + ' 个座位，叠压 ' +
      (fans[0].cardGap / g.ts).toFixed(0) + 'px）');
    const cut = fans.filter(s => s.rankGap !== null && s.rankGap / g.ts < 4);
    ok(cut.length === 0, '下层牌的点数未被上层牌压掉（最小余量 ' +
      Math.min.apply(null, fans.filter(s => s.rankGap !== null).map(s => s.rankGap / g.ts)).toFixed(1) +
      'px，异常 ' + cut.length + ' 个）');
  }

  // 底牌不能越出画布
  const holeOut = g.seats.filter(s => s.hole && (s.hole.x < g.canvas.x - 1 ||
    s.hole.r > g.canvas.r + 1 || s.hole.y < g.canvas.y - 1 || s.hole.bt > g.canvas.bt + 1));
  ok(holeOut.length === 0, '底牌浮层都在画布内' + (holeOut.length ? '（越界 ' + holeOut.length + ' 个）' : ''));

  // 8. 本人底牌与对手牌背严格等大（这是本次改造的核心诉求）
  if (g.myCard && g.opCard) {
    ok(Math.abs(g.myCard.w - g.opCard.w) <= 0.5 && Math.abs(g.myCard.h - g.opCard.h) <= 0.5,
      '本人底牌与对手牌背等大（' + g.myCard.w + '×' + g.myCard.h +
      ' vs ' + g.opCard.w + '×' + g.opCard.h + '）');
  } else {
    console.log('    · 当前没有同时量到本人底牌与对手牌背（可能未发牌），跳过等大断言');
  }

  // 9. 操作条：在画布之外，尺寸不受 --tscale 影响
  ok(g.bar && g.bar.h > 0 && g.bar.bt <= g.vh + 2,
    '操作条完整可见（底部 ' + (g.bar ? g.bar.bt : 0) + ' ≤ ' + g.vh + '）');
  if (g.acts.length) {
    const small = g.acts.filter(a => a.h < 26 || a.w < 44);
    ok(small.length === 0, '操作按钮触摸目标够大（最小 ' +
      Math.min.apply(null, g.acts.map(a => a.h)) + 'px 高，未被 tscale=' + g.ts.toFixed(2) + ' 缩小）');
  }

  // 10. 矮屏横屏：侧栏收起成抽屉，操作条竖排在牌桌**右侧**。
  //     两条要一起守：
  //     a) grid 不能留空轨道（曾因侧栏 display:none 但列轨道还在，白丢 320px）
  //     b) 画布应当卡在**高度**上 —— 这正是把操作条挪到右边的目的：
  //        高度用满了，说明纵向没有被操作条白占。
  if (d.h <= 600) {
    ok(g.sideDisp === 'none', '矮屏侧栏默认收起（display=' + g.sideDisp + '）');
    const pad = (g.fit ? g.fit.x : 0) * 2;
    const barW = g.bar ? g.bar.w : 0;
    ok(g.fit && g.fit.w + barW >= g.vw - pad - 12,
      '牌桌 + 右侧操作条吃满整行（' + (g.fit ? Math.round(g.fit.w) : 0) + ' + ' +
      Math.round(barW) + ' vs 可用 ' + (g.vw - pad) + '）');
    ok(g.bar && g.fit && g.bar.x >= g.fit.r - 1,
      '操作条位于牌桌右侧（bar.x=' + (g.bar ? Math.round(g.bar.x) : '?') +
      ' ≥ fit.right=' + (g.fit ? Math.round(g.fit.r) : '?') + '）');
    // 纵向没被浪费：画布应当卡在高度上（把操作条挪到右侧就是为了这个）。
    // 但窄屏例外 —— 操作条有 120px 下限，屏太窄时它挤走的宽度会让画布转为
    // 「宽度受限」，此时高度用不满是数学上的必然，不是浪费。
    const wantH = g.fit ? g.fit.h / CANVAS_H : 0;
    const wantW = g.fit ? g.fit.w / CANVAS_W : 0;
    if (wantW >= wantH) {
      ok(g.canvas && g.canvas.h >= g.fit.h * 0.97,
        '牌桌用满可用高度（画布 ' + (g.canvas ? Math.round(g.canvas.h) : 0) +
        ' / 可用 ' + (g.fit ? Math.round(g.fit.h) : 0) + '）');
    } else {
      ok(g.canvas && g.canvas.w >= g.fit.w * 0.97,
        '牌桌用满可用宽度（窄屏下画布受限于宽度：' +
        (g.canvas ? Math.round(g.canvas.w) : 0) + ' / ' + (g.fit ? Math.round(g.fit.w) : 0) + '）');
    }
  }

  const shot = path.join(SHOT_DIR, d.w + 'x' + d.h + '.png');
  ab('screenshot "' + shot + '"', true);
  console.log('    截图 → ' + path.relative(process.cwd(), shot) + '\n');
}

/* 复位到横屏再退出：DEVICES 的最后一档是竖屏，跑完若把会话留在竖屏，
 * 牌桌是 display:none 的，接着跑 render-check 会量到一堆 0（真实踩到过）。 */
ab('set viewport 1440 900', true);

console.log(fails === 0 ? '固定画布缩放检查全部通过 ✅' : fails + ' 项失败 ❌');
process.exit(fails === 0 ? 0 : 1);
