/* render-check.js —— 用真实浏览器验证本次界面改造
 *   1) 底牌必须横向并排（而不是竖着堆叠）
 *   2) 日志行不能继承 .board 的绝对定位（否则「河牌：♦A …」会飘到页面正中）
 *   3) 公共牌只渲染已发出的牌，不留空占位
 *   4) 自己的座位在左下方，且底牌比别人大
 * 依赖：agent-browser（真实 Chromium，jsdom 不做布局算不出坐标）
 * 用法：node tools/render-check.js [房间号]
 */
const { execSync } = require('child_process');

const ROOM = process.argv[2] || '';
const BASE = 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('    ✓ ' + msg); }
  else { fail++; console.log('    ✗ ' + msg); }
}
function ab(cmd, ms) {
  try { return execSync('agent-browser ' + cmd, { encoding: 'utf8', timeout: ms || 40000 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
/** agent-browser 的 eval 返回的是「JSON 字符串」的字符串，需要剥两层引号。
 *  输出里还可能夹杂 "✓ Done" 之类的提示行，所以从后往前找第一行能解析的。 */
function probe(js, ms) {
  const out = ab('eval "' + js.replace(/"/g, '\\"') + '"', ms);
  const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l[0] !== '{' && l[0] !== '[' && l[0] !== '"') continue;
    try {
      const v = JSON.parse(l);
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) { /* 换上一行再试 */ }
  }
  if (process.env.DEBUG_PROBE) console.log('[raw] ' + out.slice(0, 400));
  return null;
}

const R = s => s.getBoundingClientRect();

// 探针：量底牌、日志行、公共牌的几何与样式。
// 注意：agent-browser 的 eval 只接受单行，这段代码里不能出现换行。
const PROBE = `JSON.stringify((function(){var rect=function(e){var b=e.getBoundingClientRect();return{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),r:Math.round(b.right),bt:Math.round(b.bottom)};};var mine=document.querySelector('.seat.mine');var hole=mine?mine.querySelector('.hole'):null;var myCards=hole?[].map.call(hole.querySelectorAll('.card'),rect):[];var otherHoles=[].slice.call(document.querySelectorAll('.seat:not(.mine)')).map(function(s){var h=s.querySelector('.hole');return h?[].map.call(h.querySelectorAll('.card'),rect):[];}).filter(function(a){return a.length;});var logs=[].slice.call(document.querySelectorAll('.log .ln')).map(function(d){var cs=getComputedStyle(d);return{cls:d.className,pos:cs.position,top:cs.top,left:cs.left,txt:d.textContent.slice(0,10)};});var boardEls=[].slice.call(document.querySelectorAll('.board')).map(function(e){return{cls:e.className,inFelt:!!e.closest('.felt'),pos:getComputedStyle(e).position};});var board=document.querySelector('.felt .board');var boardCards=board?board.querySelectorAll('.card').length:-1;var felt=document.querySelector('.felt');var tt=document.querySelector('.table-top');return{vw:innerWidth,vh:innerHeight,hasHole:!!hole,myCards:myCards,otherHoles:otherHoles,logs:logs,boardEls:boardEls,boardCards:boardCards,mineRect:mine?rect(mine):null,feltRect:felt?rect(felt):null,tableTop:tt?rect(tt):null};})())`;

(async function () {
  console.log('打开牌桌…');
  ab('open "' + BASE + '/table.html?n=' + Date.now() + '"');
  await new Promise(r => setTimeout(r, 6000));
  if (ROOM) {
    ab('eval "Net.send({type:\'joinRoom\',roomId:\'' + ROOM + '\'});\'j\'"');
    await new Promise(r => setTimeout(r, 1500));
  }

  // 等到公共牌发出（至少翻牌），否则验证不到 board
  let g = null;
  for (let i = 0; i < 20; i++) {
    g = probe(PROBE);
    if (g && g.hasHole && g.boardCards >= 3) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!g) { console.log('无法读取页面'); process.exit(1); }

  console.log('[1] 底牌横向并排');
  ok(g.hasHole, '底牌包在 .hole 容器里');
  ok(g.myCards.length === 2, '「我」有两张底牌（' + g.myCards.length + '）');
  if (g.myCards.length === 2) {
    const a = g.myCards[0], b = g.myCards[1];
    ok(Math.abs(a.y - b.y) <= 2, '两张底牌在同一水平线上（y ' + a.y + ' vs ' + b.y + '）→ 横排');
    ok(b.x >= a.r - 1, '第二张在第一张右侧（' + a.x + ' → ' + b.x + '）');
    ok(Math.abs(a.x - b.x) > a.w * 0.5, '两张牌左右错开而非上下堆叠');
  }
  const badOther = g.otherHoles.filter(cs =>
    cs.length === 2 && Math.abs(cs[0].y - cs[1].y) > 2);
  ok(badOther.length === 0, '其他人的底牌也是横排（异常 ' + badOther.length + ' 个座位）');

  console.log('[2] 日志行不再飘到页面中间');
  const floating = g.logs.filter(l => l.pos !== 'static');
  ok(floating.length === 0,
    '所有日志行 position 都是 static（异常 ' + floating.length + ' 条' +
    (floating[0] ? '：' + floating[0].cls + ' ' + floating[0].pos + ' top:' + floating[0].top : '') + '）');
  const dealLog = g.logs.find(l => /翻牌|转牌|河牌/.test(l.txt));
  ok(!dealLog || dealLog.pos === 'static',
    '发牌日志「' + (dealLog ? dealLog.txt : '尚未产生') + '」不参与绝对定位');
  const strayBoard = g.boardEls.filter(b => !b.inFelt);
  ok(strayBoard.length === 0,
    '页面上不存在游离的 .board 元素（异常 ' + strayBoard.length + ' 个）');

  console.log('[3] 公共牌不留空占位');
  ok(g.boardCards >= 3 && g.boardCards <= 5,
    '公共牌只渲染已发出的 ' + g.boardCards + ' 张（原先固定 5 张含占位）');

  console.log('[4] 整体布局');
  if (g.mineRect && g.feltRect) {
    const cx = g.mineRect.x + g.mineRect.w / 2, cy = g.mineRect.y + g.mineRect.h / 2;
    const fx = g.feltRect.x + g.feltRect.w / 2, fy = g.feltRect.y + g.feltRect.h / 2;
    ok(cx < fx, '我的座位在牌桌左半边');
    ok(cy > fy, '我的座位在牌桌下半边');
  }
  if (g.myCards.length === 2 && g.otherHoles[0] && g.otherHoles[0].length === 2) {
    ok(g.myCards[0].w > g.otherHoles[0][0].w,
      '我的牌比别人的大（' + g.myCards[0].w + ' > ' + g.otherHoles[0][0].w + '）');
  }
  if (g.tableTop) {
    ok(g.tableTop.h < 40, '牌桌顶部信息条已压成一行（高 ' + g.tableTop.h + 'px）');
  }
  ok(g.vw <= 0 || true, '视口 ' + g.vw + '×' + g.vh);

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})();
