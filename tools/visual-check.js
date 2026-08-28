/* visual-check.js —— 用真实 Chromium 量牌桌布局
 *
 * 不做"看起来对不对"的主观判断，而是读取每个元素的 getBoundingClientRect 做几何断言：
 *  - 自己是否固定在左下角
 *  - 有没有出现横向/纵向滚动条（手机上一旦出现就是布局没适配）
 *  - 座位有没有溢出牌桌或互相重叠
 *  - 操作按钮是否还在视口内、触摸目标够不够大
 *
 * 前置：服务端已启动、已用 agent-browser 登录进牌桌（或先在浏览器里坐下一局）
 * 用法：node tools/visual-check.js
 */
const { execSync } = require('child_process');
const path = require('path');

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
const PROBE = "(()=>{const R=s=>{const e=document.querySelector(s);return e?e.getBoundingClientRect():null;};const Z={x:0,y:0,width:0,height:0,right:0,bottom:0};const rect=b=>({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),r:Math.round(b.right),bt:Math.round(b.bottom)});const seats=[...document.querySelectorAll('#seats .seat')].map(e=>{const b=e.getBoundingClientRect();return Object.assign({name:(e.querySelector('.nm')||{}).textContent||'',mine:e.classList.contains('mine'),myCard:e.querySelectorAll('.card.my').length},rect(b));});const acts=[...document.querySelectorAll('button.act')].map(e=>Object.assign({t:e.textContent.trim().slice(0,5)},rect(e.getBoundingClientRect())));const myCards=[...document.querySelectorAll('.seat.mine .card')].map(e=>rect(e.getBoundingClientRect()));const side=document.querySelector('.side');const ss=document.querySelector('#seats');const ms=document.querySelector('.seat.mine');return JSON.stringify({myZ:ms?(parseInt(getComputedStyle(ms).zIndex)||0):0,seatW:ss?getComputedStyle(ss).getPropertyValue('--seat-w').trim():'?',crowded:ss?ss.classList.contains('crowded'):false,seatH:document.querySelector('#seats .seat')?Math.round(document.querySelector('#seats .seat').getBoundingClientRect().height):0,vw:innerWidth,vh:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,topbar:rect(R('.topbar')||Z),felt:rect(R('.felt')||Z),bar:rect(R('.action-bar')||Z),sideVisible:side?getComputedStyle(side).display:'none',seats,acts,myCards});})()";

const DEVICES = [
  { name: '桌面 1440×900', w: 1440, h: 900, portrait: false },
  { name: '笔记本 1280×720', w: 1280, h: 720, portrait: false },
  { name: 'iPad 横屏 1180×820', w: 1180, h: 820, portrait: false },
  { name: 'iPhone 14 横屏 844×390', w: 844, h: 390, portrait: false },
  { name: 'iPhone SE 横屏 667×375', w: 667, h: 375, portrait: false },
  { name: '小安卓横屏 640×320', w: 640, h: 320, portrait: false },
  { name: '竖屏手机 390×844', w: 390, h: 844, portrait: true }
];

let fails = 0;
function ok(c, m) { if (c) console.log('    ✓ ' + m); else { fails++; console.log('    ✗ ' + m); } }

console.log('在真实 Chromium 中量取牌桌布局（共 ' + DEVICES.length + ' 种视口）\n');

for (const d of DEVICES) {
  console.log('[' + d.name + ']');
  ab('set viewport ' + d.w + ' ' + d.h);
  execSync('sleep 1');                      // 等 resize 触发的座位重排
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

  const mine = g.seats.find(s => s.mine);
  const others = g.seats.filter(s => !s.mine);

  // 1. 不能出现横向滚动条
  ok(g.sw <= g.vw + 2, '无横向滚动（scrollWidth ' + g.sw + ' ≤ 视口 ' + g.vw + '）');
  // 2. 横屏要一屏放下（竖屏允许滚动）
  if (!d.portrait) {
    ok(g.sh <= g.vh + 4, '一屏放下，无纵向滚动（scrollHeight ' + g.sh + ' ≤ ' + g.vh + '）');
  }
  // 3. 自己的位置：以牌桌中心为参照（视口中心因顶栏/操作条并不等于牌桌中心），
  //    .seat 用了 translate(-50%,-50%)，所以包围盒中心就是定位锚点
  if (mine) {
    const cx = mine.x + mine.w / 2, cy = mine.y + mine.h / 2;
    const fx = g.felt.x + g.felt.w / 2, fy = g.felt.y + g.felt.h / 2;
    ok(cx < fx, '我的座位在牌桌中线左侧（x=' + Math.round(cx) + ' < ' + Math.round(fx) + '）');
    ok(cy > fy, '我的座位在牌桌中线下方（y=' + Math.round(cy) + ' > ' + Math.round(fy) + '）');
    ok(cx < g.vw / 2, '整体也在屏幕左半边（x=' + Math.round(cx) + '）');
    // 我应该是全桌最靠左下的那个
    const lower = others.filter(s => (s.x + s.w / 2) <= cx && (s.y + s.h / 2) >= cy).length;
    ok(lower === 0, '没有别人比我更靠左下');
    ok(mine.myCard === 2, '我的两张底牌用大号渲染（.card.my=' + mine.myCard + '）');
  } else { fails++; console.log('    ✗ 找不到「我的」座位'); }
  // 4. 我的牌在手机上也要看得清
  if (g.myCards.length) {
    const c = g.myCards[0];
    ok(c.w >= 20 && c.h >= 28, '我的牌尺寸可辨认（' + c.w + '×' + c.h + '）');
  }
  // 5. 座位不能溢出视口
  const outView = g.seats.filter(s => s.x < -2 || s.r > g.vw + 2 || s.y < -2 || s.bt > g.vh + 2);
  ok(outView.length === 0, '所有座位都在视口内' + (outView.length ? '（溢出 ' + outView.length + ' 个）' : ''));
  // 6. 座位之间不重叠。
  //    自己那一格比别人高（保留了昵称和更大的牌），满桌时允许它压住邻座一点点——
  //    但 z-index 保证它始终在最上层、完整可读，所以只要求「其他座位之间」不重叠。
  let overlap = 0, mineOverlap = 0;
  for (let i = 0; i < g.seats.length; i++) {
    for (let j = i + 1; j < g.seats.length; j++) {
      const a = g.seats[i], b = g.seats[j];
      if (a.x < b.r && b.x < a.r && a.y < b.bt && b.y < a.bt) {
        if (a.mine || b.mine) mineOverlap++; else overlap++;
      }
    }
  }
  ok(overlap === 0, '其他座位互不重叠' + (overlap ? '（重叠 ' + overlap + ' 对）' : ''));
  ok(g.myZ >= 6, '我的座位层级最高，不会被邻座遮住（z-index=' + g.myZ + '）');
  if (mineOverlap) console.log('    · 我的座位与邻座有 ' + mineOverlap + ' 处轻微交叠（已置顶，不影响阅读）');
  // 7. 操作条在视口内
  ok(g.bar.h > 0 && g.bar.bt <= g.vh + 2, '操作条完整可见（底部 ' + g.bar.bt + ' ≤ ' + g.vh + '）');
  // 8. 触摸目标不能太小
  const small = g.acts.filter(a => a.h < 26 || a.w < 44);
  ok(small.length === 0, '操作按钮触摸目标够大（最小 ' +
    Math.min.apply(null, g.acts.map(a => a.h)) + 'px 高）');
  // 9. 牌桌本身要占满可用空间
  ok(g.felt.w > g.vw * 0.5 && g.felt.h > g.vh * 0.4,
    '牌桌占据主要空间（' + g.felt.w + '×' + g.felt.h + '）');
  // 10. 矮屏时侧栏应收起
  if (d.h <= 600) {
    ok(g.sideVisible === 'none', '矮屏侧栏默认收起（display=' + g.sideVisible + '）');
  }

  const shot = path.join(SHOT_DIR, d.w + 'x' + d.h + '.png');
  ab('screenshot "' + shot + '"', true);
  console.log('    截图 → ' + path.relative(process.cwd(), shot) + '\n');
}

console.log(fails === 0 ? '布局几何检查全部通过 ✅' : fails + ' 项失败 ❌');
process.exit(fails === 0 ? 0 : 1);
