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
      if (m.type === 'joined') c.roomId = m.roomId;
      if (m.type === 'state') c.lastState = m;
      (h[m.type] || []).forEach(f => f(m));
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

/** 打开牌桌页，返回带探测结果的 DOM 摘要。
 *  等待以「收到过房间状态」为准（prompt 不再是初始占位文案），最多 ~12 秒 ——
 *  固定睡 4 秒在房间节奏慢（例如有人挂着超时）时会在状态到达前就采样，
 *  曾经因此把 A 组误报成「无空位 + 领取可用」（读到的是还没渲染的初始 DOM）。 */
async function loadTable(token, ms = 12000) {
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
  const doc0 = dom.window.document;
  const started = Date.now();
  while (Date.now() - started < ms) {
    const p = doc0.getElementById('prompt');
    if (p && p.textContent && !/等待发牌/.test(p.textContent)) break;
    await sleep(400);
  }
  const doc = dom.window.document;
  const out = {
    url: dom.window.location.pathname,
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
  await c.wait('auth', 8000);
  return c;
}

/** 入房并等到第一个房间状态再返回 —— 固定睡眠在房间节奏慢时会读到空的 lastState */
async function joinAndSync(c) {
  c.send({ type: 'joinRoom', roomId: 'PRACTICE1' });
  await c.wait('state', 10000);
}

(async function () {
  console.log('[A] 新用户进练习房：空位常显「＋ 坐下」、牌桌页无领取入口（领取只在大厅）');
  {
    const c = await freshAccount('a');
    await joinAndSync(c);
    const p = await loadTable(c.token);
    ok(p.url === '/table.html' && !/等待发牌/.test(p.prompt),
      '页面收到房间状态（url=' + p.url + '，prompt=' + p.prompt.slice(0, 20) + '…）');
    ok(p.canSitSeats.length >= 3, '存在可坐空位（' + p.canSitSeats.length + ' 个）');
    ok(p.canSitSeats.every(t => /坐下/.test(t)),
      '可坐空位都常显「＋ 坐下」文案（' + JSON.stringify(p.canSitSeats.slice(0, 2)) + '）');
    ok(p.claim === null, '牌桌页没有领取按钮（领取已收口到大厅）');
    ok(p.errs.length === 0, '页面无 JS 错误' + (p.errs.length ? '：' + p.errs[0] : ''));
    c.ws.close();
  }

  console.log('\n[B] 领取规则：房内拒绝、随时可领 2000（大厅专属）');
  {
    const c = await freshAccount('b');
    await joinAndSync(c);
    await sleep(500);                    // 等一拍，让 state 在 lastState 里站稳
    // 房间内领取：服务端必须拒绝（规则收口 —— 在房可领就没有休止符）。
    // 门槛已废除（随时可领），无需构造低余额前置。
    c.send({ type: 'claim' });
    const refused = await c.wait('error', 5000).catch(() => null);
    ok(!!refused && /大厅/.test(refused.msg),
      '房间内领取被拒绝并指路大厅（' + (refused ? refused.msg : '未收到 error') + '）');
    // 金额与无门槛语义进程内直测 db（独立数据文件：db 是单进程内存快照，
    // 跨进程改共享文件会被运行中服务的下一次 save() 覆盖回去，必须完全隔离）。
    const fs = require('fs');
    const unitDb = '/tmp/poker-unit-claim.json';
    try { fs.unlinkSync(unitDb); } catch (e) { /* 首跑无文件 */ }
    const savedEnv = process.env.POKER_DATA;
    process.env.POKER_DATA = unitDb;
    delete require.cache[require.resolve(ROOT + '/server/db.js')];
    const db = require(ROOT + '/server/db.js');
    process.env.POKER_DATA = savedEnv;
    ok(db.CLAIM_AMOUNT === 2000, '单次领取金额为 2000（CLAIM_AMOUNT=' + db.CLAIM_AMOUNT + '）');
    db.ensureBot('claim_t_low', 500);
    const r1 = db.claim('claim_t_low');
    ok(!!r1.ok && r1.amount === 2000 && r1.chips === 2500,
      '余额 500 可领取，到账 2500（' + JSON.stringify(r1) + '）');
    db.ensureBot('claim_t_rich', 1500);
    const r2 = db.claim('claim_t_rich');
    ok(!!r2.ok && r2.chips === 3500,
      '不设门槛：余额充足（1500）同样可领（到账 3500）');
    c.ws.close();
  }

  console.log('\n[C] 已入座：空位一律不可点（防误触）');
  {
    const c = await freshAccount('c');
    await joinAndSync(c);
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
    await joinAndSync(c);
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

    /* E. 快捷注额只「拨杆」不下注：以前点一下 1/2 池就把钱直接推进池，
       误触等于白送一个底池。现在必须按「加注」确认 —— 这条断言守住它不回归。
       点「1 池」而非「1/2 池」：底池很小时 1/2 池的目标会被夹到最小加注，
       与滑杆初始值（即最小值）相同，断言「值变化」就会场景性误报。 */
    const q = dom.window.document.querySelectorAll('#quick button')[2];
    if (q && !q.disabled) {
      const before = dom.window.document.getElementById('raise-slider').value;
      q.click();
      await sleep(300);
      const doc2 = dom.window.document;
      const after = doc2.getElementById('raise-slider').value;
      const stillMine = /轮到你了/.test(doc2.getElementById('prompt').textContent);
      const raiseLabel = doc2.getElementById('btn-raise').textContent.trim().replace(/\s+/g, ' ');
      ok(after !== before, '点快捷注额后滑杆被拨动（' + before + ' → ' + after + '）');
      ok(stillMine, '快捷注额不再直接提交（仍轮到我，等确认）');
      ok(/加注到|全下/.test(raiseLabel), '加注按钮文案随滑杆更新（' + raiseLabel + '）');
    } else {
      console.log('  （本手无可加注场景，跳过 E 组）');
    }

    // 收尾：行动掉这一手并站起，把座位还给真人
    dom.window.eval('Net.send({type:"action",action:{type:"check"}})');
    await sleep(1500);
    c.send({ type: 'stand' });
    await sleep(800);
    dom.window.close();
    c.ws.close();
  }

  console.log('\n[F] 全下跑马：亮牌、等价%、逐街节奏、摊牌接管（GG / PokerStars 的招牌时刻）');
  {
    /* 自建私房打一手「全下被跟」：A 全下、B 跟注。
       守的体验点：跑马时对手的牌必须亮（悬念的前提）、双方都要挂等价%、
       合计 ≈100、逐街有节奏（一口气发完等于把高潮剪掉）、摊牌时等价让位牌型。 */
    const mk = tag => new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
      const c = { tag, ws, name: null, token: null, roomId: null, last: null,
        send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
      ws.on('message', d => {
        let m; try { m = JSON.parse(d); } catch (e) { return; }
        if (m.type === 'auth' && m.ok) { c.token = m.token; c.name = m.user.name; }
        if (m.type === 'joined') c.roomId = m.roomId;
        if (m.type === 'state') {
          c.last = m;
          const act = m.table && m.table.you ? m.table.you.act : null;
          if (act) c.send({ type: 'action', action: tag === 'A' ? { type: 'allin' } : { type: 'call' } });
        }
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
    const A = await mk('A'), B = await mk('B');
    A.send({ type: 'register', name: 'fa' + Math.floor(Math.random() * 1e5), password: 'test123456' });
    B.send({ type: 'register', name: 'fb' + Math.floor(Math.random() * 1e5), password: 'test123456' });
    await sleep(1000);
    A.send({ type: 'createRoom', title: '跑马测试', sb: 5, bb: 10, buyIn: 1000 });
    await sleep(900);
    B.send({ type: 'joinRoom', roomId: A.roomId });
    await sleep(800);
    A.send({ type: 'sit', seat: 0, amount: 1000 });
    B.send({ type: 'sit', seat: 2, amount: 1000 });
    await sleep(1200);
    A.send({ type: 'start' });

    let runout = null, showdown = null, tAllIn = 0, tShowdown = 0;
    const begin = Date.now();
    while (Date.now() - begin < 60000 && !showdown) {
      await sleep(300);
      const m = B.last;
      if (!m || !m.table) continue;
      const t = m.table;
      const opp = t.seats.find(s => s.name === A.name);
      const me = t.seats.find(s => s.name === B.name);
      if (!runout && !m.result && opp && opp.hole && opp.eq != null) {
        runout = { eq: { me: me.eq, opp: opp.eq } };
        tAllIn = Date.now();
      }
      if (m.result) {
        showdown = { hands: t.seats.filter(s => s.hand).map(s => s.hand), eqNow: t.seats.map(s => s.eq) };
        tShowdown = Date.now();
      }
    }
    ok(!!runout, '跑马时对手底牌已亮、等价已挂（' + (runout ? '我 ' + runout.eq.me + '% / 对手 ' + runout.eq.opp + '%' : '未见') + '）');
    if (runout) ok(Math.abs(runout.eq.me + runout.eq.opp - 100) <= 2,
      '等价合计 ≈ 100（实际 ' + (runout.eq.me + runout.eq.opp) + '）');
    ok(!!showdown, '跑马结束进入摊牌（牌型 ' + (showdown ? showdown.hands.join('，') : '-') + '）');
    if (showdown) {
      ok(showdown.hands.length >= 2, '摊牌时双方都挂牌型标签');
      ok(showdown.eqNow.every(e => e == null), '摊牌时等价标签已清空（牌型接管，两者同位不能同屏）');
      ok(tShowdown - tAllIn >= 2200, '逐街节奏 ≥ 2.2s（实际 ' + ((tShowdown - tAllIn) / 1000).toFixed(1) + 's）');
    }
    A.ws.close(); B.ws.close();
  }

  console.log('\n[G] 预选动作与摊牌高亮（GG 标配：轮到我之前就能把动作选好）');
  {
    /* A（WS 自动全下，延迟 1.5s 给 B 勾选窗口）× B（页面玩家）。
       A 坐 0 号位 ⇒ 首手庄家/小盲 = A ⇒ 翻牌前 A 先行动（单挑规则），
       B 有一整个勾选窗口；B 勾「跟注任意」后 A 全下，轮到 B 的瞬间
       页面应自动跟注（不需要人点），进跑马 → 摊牌：构成赢家最佳五张
       的牌应带金色高亮（.card.hl ≥ 5）。 */
    const A = await new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
      const c = { ws, name: null, token: null, roomId: null, last: null,
        send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
      ws.on('message', d => {
        let m; try { m = JSON.parse(d); } catch (e) { return; }
        if (m.type === 'auth' && m.ok) { c.token = m.token; c.name = m.user.name; }
        if (m.type === 'joined') c.roomId = m.roomId;
        if (m.type === 'state') {
          c.last = m;
          const act = m.table && m.table.you ? m.table.you.act : null;
          // 延迟 1.5s：B（页面玩家）要在这段时间里完成预选勾选
          if (act) setTimeout(() => c.send({ type: 'action', action: { type: 'allin' } }), 1500);
        }
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
    A.send({ type: 'register', name: 'ga' + Math.floor(Math.random() * 1e5), password: 'test123456' });
    const B = await freshAccount('g');
    await sleep(1000);
    A.send({ type: 'createRoom', title: '预选测试', sb: 5, bb: 10, buyIn: 1000 });
    await sleep(900);
    B.send({ type: 'joinRoom', roomId: A.roomId });
    await sleep(800);
    A.send({ type: 'sit', seat: 0, amount: 1000 });
    B.send({ type: 'sit', seat: 2, amount: 1000 });
    await sleep(1200);

    // B 以页面玩家身份进桌（ws 连接已入房，页面加载即收到状态）
    const vc = new VirtualConsole();
    const errs = [];
    vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
    const dom = await JSDOM.fromURL(BASE + '/table.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.localStorage.setItem('poker_token', B.token);
        delete win.AudioContext; delete win.webkitAudioContext;
      }
    });
    const doc = dom.window.document;
    const preBox = doc.getElementById('pre-actions');
    const preBtn = doc.getElementById('pre-callany');
    // 等页面收到房间状态（等待开局时预选区应保持隐藏）
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 &&
           /等待发牌/.test(doc.getElementById('prompt').textContent)) await sleep(200);
    await sleep(400);
    ok(preBox.hidden, '开局前（等待阶段）预选区隐藏');

    A.send({ type: 'start' });
    // A 先行动且延迟 1.5s —— 在这个窗口里把预选勾上
    let checked = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 8000 && !checked) {
      await sleep(120);
      if (!preBox.hidden) { preBtn.click(); checked = preBtn.classList.contains('on'); }
    }
    ok(checked, 'B 在座且未轮到时预选区可见，勾选「跟注任意」后按钮亮起（.on）');

    // 等轮到 B → 页面自动跟注（ws 视角观测，与页面渲染同帧）
    let sawAct = false, actAt = 0, autoDone = null, autoState = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 60000 && !autoDone) {
      await sleep(250);
      const st = B.lastState;
      if (!st || !st.table) continue;
      if (st.table.you.act && !sawAct) { sawAct = true; actAt = Date.now(); }
      const me = st.table.seats.find(s => s.name === B.name);
      if (sawAct && me && /跟注/.test(me.lastAction || '')) {
        autoDone = Date.now();
        autoState = me;
      }
    }
    ok(!!autoDone, '轮到 B 时预选自动跟注（lastAction=' +
      (autoState ? autoState.lastAction : '未见') + '）');
    if (autoDone) {
      ok(autoDone - actAt < 4000, '自动跟注在 4 秒内完成（实际 ' + (autoDone - actAt) + 'ms）');
      ok(autoState.byTimeout === false, '是预选提交，不是超时自动处置');
    }

    // 跑马 → 摊牌：赢家最佳五张高亮。result 停留 9s，页面有充足时间渲染
    const t3 = Date.now();
    let hl = -1;
    while (Date.now() - t3 < 60000 && hl < 0) {
      await sleep(300);
      if (B.lastState && B.lastState.result) hl = doc.querySelectorAll('.card.hl').length;
    }
    ok(hl >= 5, '摊牌时赢家最佳五张带高亮（.card.hl = ' + (hl < 0 ? '未见' : hl) + '）');
    ok(errs.length === 0, '页面无 JS 错误' + (errs.length ? '：' + errs[0] : ''));

    dom.window.close();
    A.ws.close(); B.ws.close();
  }

  console.log('\n[H] 结算横幅、展示期文案与最后 5 秒紧迫提示（spec: table-showdown-banner）');
  {
    /* A（ws 自动，第 1 手加注、之后全下）× B（jsdom 页面玩家，坐 2 号位）。
       第一手：A 加注 → B 弃牌 → 弃牌收池横幅（含赢家名 + 「无人摊牌」）
       + 展示期提示「下一手即将开始」+ 新手开始横幅退场；
       第二手：B 跟注、A 全下、B 跟注 → 跑马摊牌 → 横幅含牌型，
       mine 高亮与 B 胜负严格一致；
       第三手：B 挂机制造最后 5 秒 → t-critical 脉冲类挂上（声音在 jsdom 无音频，
       静默退化由 D 组覆盖），全程无 JS 错误。 */
    const A = await new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
      const c = { ws, name: null, token: null, roomId: null, last: null,
        send(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } };
      ws.on('message', d => {
        let m; try { m = JSON.parse(d); } catch (e) { return; }
        if (m.type === 'auth' && m.ok) { c.token = m.token; c.name = m.user.name; }
        if (m.type === 'joined') c.roomId = m.roomId;
        if (m.type === 'state') {
          c.last = m;
          const act = m.table && m.table.you ? m.table.you.act : null;
          if (act) {
            const hand = m.table.handCount || 0;
            c.send({ type: 'action', action: hand <= 1 ? { type: 'raise', total: 30 } : { type: 'allin' } });
          }
        }
      });
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
    A.send({ type: 'register', name: 'ha' + Math.floor(Math.random() * 1e5), password: 'test123456' });
    const B = await freshAccount('h');
    await sleep(1000);
    A.send({ type: 'createRoom', title: '横幅测试', sb: 5, bb: 10, buyIn: 1000 });
    await sleep(900);
    B.send({ type: 'joinRoom', roomId: A.roomId });
    await sleep(800);
    A.send({ type: 'sit', seat: 0, amount: 1000 });
    B.send({ type: 'sit', seat: 2, amount: 1000 });
    await sleep(1200);

    const vc = new VirtualConsole();
    const errs = [];
    vc.on('jsdomError', e => { if (!/navigation/i.test(e.message)) errs.push(e.message); });
    const dom = await JSDOM.fromURL(BASE + '/table.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.localStorage.setItem('poker_token', B.token);
        delete win.AudioContext; delete win.webkitAudioContext;
      }
    });
    const doc = dom.window.document;
    const banner = doc.getElementById('win-banner');
    A.send({ type: 'start' });

    /* ---- 第一手：弃牌收池 ---- */
    let t0 = Date.now();
    while (Date.now() - t0 < 20000 && !/轮到你了/.test(doc.getElementById('prompt').textContent)) await sleep(300);
    dom.window.eval('Net.send({type:"action",action:{type:"fold"}})');
    let banner1 = '';
    t0 = Date.now();
    while (Date.now() - t0 < 15000 && !banner1) {
      await sleep(200);
      if (banner.classList.contains('show')) banner1 = banner.textContent;
    }
    ok(!!banner1 && banner1.indexOf(A.name) >= 0,
      '弃牌收池横幅显示赢家（' + (banner1 || '未见') + '）');
    ok(/无人摊牌/.test(banner1), '弃牌收池标注「无人摊牌」');
    ok(/下一手即将开始/.test(doc.getElementById('prompt').textContent),
      '展示期提示为「下一手即将开始…」（不再与「摊牌」阶段标签矛盾）');
    // fold 展示 4s：等新一手发出来再验横幅退场
    t0 = Date.now();
    while (Date.now() - t0 < 15000 &&
           !(B.lastState && B.lastState.table && !B.lastState.result &&
             B.lastState.table.handCount >= 2)) await sleep(300);
    await sleep(500);
    ok(!banner.classList.contains('show'), '新一手开始横幅已退场（不残留到下一手）');

    /* ---- 第二手：跑马摊牌 ---- */
    // 第二手 button 轮到 B（小盲），B 跟注 → A 全下 → B 再跟注。
    // 两段行动之间必须等 prompt 先离开「轮到你了」：行动提交后广播回来
    // 之前 prompt 还是旧值，第二发 call 会挤进同一帧、被服务端当
    // 「还没轮到你」丢弃 —— B 随即挂机 30 秒被超时弃牌，整手变成弃牌收池。
    t0 = Date.now();
    while (Date.now() - t0 < 20000 && !/轮到你了/.test(doc.getElementById('prompt').textContent)) await sleep(300);
    dom.window.eval('Net.send({type:"action",action:{type:"call"}})');
    t0 = Date.now();
    while (Date.now() - t0 < 15000 && /轮到你了/.test(doc.getElementById('prompt').textContent)) await sleep(200);
    t0 = Date.now();
    while (Date.now() - t0 < 20000 && !/轮到你了/.test(doc.getElementById('prompt').textContent)) await sleep(300);
    dom.window.eval('Net.send({type:"action",action:{type:"call"}})');
    let res2 = null;
    // 跑马期间逐帧采样「筹码动画出现时的棋盘态」：归池动画只应出现在
    // 全下尾注那一次（此时 board 刚发 3 张）；后续每张公共牌都不得再飞筹码
    //（引擎在跑马期间不清 bets，归池动画曾因此每条街重复播放）。
    // 同一循环里采样公共牌入场动画的归属：.deal 只许挂「本街新牌」——
    // 翻牌帧三张全新全挂；转牌帧只有第 4 张挂（前 3 张重闪就是回归，
    // 已发的牌必须纹丝不动）；河牌帧结果广播紧随其后、窗口极短，捕到才断言。
    const flyBoards = new Set();
    let flopDeal = null, turnClean = null, turnNew = null, riverClean = null;
    t0 = Date.now();
    while (Date.now() - t0 < 60000 && !res2) {
      await sleep(250);
      if (B.lastState && B.lastState.result) { res2 = B.lastState.result; break; }
      if (doc.querySelectorAll('#fx .chip-fly').length) {
        flyBoards.add(((B.lastState && B.lastState.table.board) || []).length);
      }
      const dc = [...doc.querySelectorAll('#board .card')].map(c => c.classList.contains('deal'));
      if (dc.length === 3 && flopDeal === null) flopDeal = dc.every(Boolean);
      if (dc.length === 4 && turnClean === null) {
        turnClean = !dc.slice(0, 3).some(Boolean);
        turnNew = dc[3] === true;
      }
      if (dc.length === 5 && dc[4] === true && riverClean === null) {
        riverClean = !dc.slice(0, 4).some(Boolean);
      }
    }
    ok(!flyBoards.has(4) && !flyBoards.has(5),
      '跑马翻牌期间不重复归池（动画出现的棋盘态=' + (flyBoards.size ? [...flyBoards].join('/') : '未捕获') +
      '，转牌/河牌阶段应为空）');
    ok(flopDeal === true, '翻牌三张都挂入场动画（本街全是新牌）');
    ok(turnClean === true && turnNew === true,
      '转牌入场动画只挂新牌，翻牌三张不重闪（前3张deal=' + turnClean + '，第4张deal=' + turnNew + '）');
    ok(riverClean !== false, '河牌入场动画只挂新牌' +
      (riverClean === null ? '（结果帧窗口太短未捕到，跳过）' : '（已发的四张不重闪）'));
    ok(!!res2 && banner.classList.contains('show'), '摊牌结算横幅显示');
    if (res2) {
      // 页面与测试 ws 是两条连接：result 的渲染可能晚一帧，
      // 先等横幅文本带上赢家名（最多 5s）再比对牌型与高亮
      const winIdx = (res2.seats || []).filter(s => s.won > 0).map(s => s.index);
      const handName = ((res2.revealed || []).find(x => winIdx.indexOf(x.index) >= 0 && x.hand) || {}).hand;
      let b2 = '';
      t0 = Date.now();
      while (Date.now() - t0 < 5000 && !b2) {
        const txt = banner.textContent;
        if (txt.indexOf(A.name) >= 0 || txt.indexOf(B.name) >= 0) b2 = txt;
        else await sleep(200);
      }
      ok(!!handName && handName.name && b2.indexOf(handName.name) >= 0,
        '摊牌横幅含赢家牌型（' + (handName && handName.name) + '，横幅「' + b2 + '」）');
      const bWon = ((res2.seats || []).find(s => s.index === 2) || {}).won > 0;
      ok(banner.classList.contains('mine') === bWon,
        '我赢高亮与胜负严格一致（B 赢=' + bWon + '，banner.mine=' + banner.classList.contains('mine') + '）');
    } else {
      ok(false, '摊牌结算横幅显示（未等到结算结果）');
    }

    /* ---- 第三手：挂机制造最后 5 秒 ---- */
    // 第二手谁输光谁破产：真人（A/B 都是 ws 客户端）不会自动补码 ——
    // 桌上不足两人有筹码时引擎直接终止整局（onHandEnd 后 finished），
    // 第三手根本不存在。所以：见底先补码（waiting 态 rebuy 直接入座，
    // playing 态走 pendingRebuy 下一手生效），整局若已停再由房主 A 重开。
    const roomStopped = !!(B.lastState && B.lastState.room.status !== 'playing');
    const aAfter = ((res2.seats || []).find(s => s.index === 0) || {});
    if ((aAfter.chips || 0) <= 0) { A.send({ type: 'rebuy', amount: 1000 }); await sleep(800); }
    const bAfter = ((res2.seats || []).find(s => s.index === 2) || {});
    if ((bAfter.chips || 0) <= 0) {
      B.send({ type: 'rebuy', amount: 1000 });
      await sleep(800);
    }
    if (roomStopped) { A.send({ type: 'start' }); await sleep(1200); }
    // 第三手 A 先行动（A 全下）→ B 挂机 ~25s → 最后 5 秒 t-critical 挂上。
    // 整局可能在第二手结算的 9 秒展示期**之后**才被判终止（输光者不足两人）——
    // 展示期里 status 还是 playing，提前判不出来；这里在轮询中检测 waiting，
    // 检测到就由房主 A 重开（前面 rebuy 的钱此时已由 loop 收尾结转到座位）。
    let urgent = false;
    let restarted = false;
    t0 = Date.now();
    while (Date.now() - t0 < 90000 && !urgent) {
      await sleep(500);
      urgent = !!doc.querySelector('.timer.t-critical') ||
               !!doc.querySelector('.seat.acting.t-critical .seat-sec');
      if (!urgent && !restarted && B.lastState && B.lastState.room.status !== 'playing') {
        restarted = true;
        A.send({ type: 'start' });
        await sleep(800);
      }
    }
    ok(urgent, '最后 5 秒倒计时挂上 t-critical 脉冲档（本人操作条或座位胶囊）');
    ok(errs.length === 0, '全程无 JS 错误' + (errs.length ? '：' + errs[0] : ''));

    dom.window.eval('Net.send({type:"action",action:{type:"fold"}})');
    await sleep(1200);
    dom.window.close();
    A.ws.close(); B.ws.close();
  }

  console.log('\n[I] 补给闭环：余额见底指路大厅（领取已收口）、灰按钮的原因说明');
  {
    /* 三个断言场景（不开局，补给与领取都不依赖牌局进行）：
       1) 未入座：补给按钮灰（补给是把账号的钱加到桌上，没座没去处），
          但 title 必须把原因说出来 —— 用户对着一个无解释的灰按钮毫无办法；
       2) 在座、账号余额 0：点补给不弹 max=0 的死弹窗（弹窗内任何输入都是
          矛盾值），也不代办领取（房内禁止领），只指路「返回大厅」；
       3) 桌上打光 + 账号见底：prompt 直接把出路说全（返回大厅领取再回桌）。 */
    const A = await freshAccount('i0');
    await sleep(500);
    A.send({ type: 'createRoom', title: '补给测试', sb: 5, bb: 10, buyIn: 1000 });
    // 等 roomId 到手（wsClient 收到 joined 时写入；轮询避开 handler 时序）
    const tA = Date.now();
    while (Date.now() - tA < 8000 && !A.roomId) await sleep(300);
    ok(!!A.roomId, '前置：测试房已建好');

    // C：未入座观察者 —— 按钮应灰 + title 解释
    const C = await freshAccount('i2');
    C.send({ type: 'joinRoom', roomId: A.roomId });
    const tJoin = Date.now();
    while (Date.now() - tJoin < 8000 && !C.lastState) await sleep(300);   // 等房间状态站稳
    const domC = await JSDOM.fromURL(BASE + '/table.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(win) { win.localStorage.setItem('poker_token', C.token); }
    });
    const docC = domC.window.document;
    const tC = Date.now();
    while (Date.now() - tC < 8000 &&
           /等待发牌/.test(docC.getElementById('prompt').textContent)) await sleep(300);
    const btnC = docC.getElementById('btn-rebuy');
    ok(btnC && btnC.disabled === true, '未入座时补给按钮置灰（没有座位可补）');
    ok(/入座后/.test(btnC ? btnC.title : ''), '灰按钮的 title 解释了原因（' + (btnC && btnC.title) + '）');
    domC.window.close();

    // B：入座 → 补光账号 → 点补给应自动领取
    const B = await freshAccount('i1');
    B.send({ type: 'joinRoom', roomId: A.roomId });
    const tJoinB = Date.now();
    while (Date.now() - tJoinB < 8000 && !B.lastState) await sleep(300);
    B.send({ type: 'sit', seat: 1, amount: 1000 });
    await sleep(1000);
    // 把账号余额补到桌上去（4000 全部 rebuy），账号归零
    B.send({ type: 'rebuy', amount: 4000 });
    await sleep(900);
    ok(B.lastState && B.lastState.table.you.account === 0, '前置：账号余额已清零');

    const dom = await JSDOM.fromURL(BASE + '/table.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(win) { win.localStorage.setItem('poker_token', B.token); }
    });
    const doc = dom.window.document;
    const tB = Date.now();
    while (Date.now() - tB < 8000 &&
           /等待发牌/.test(doc.getElementById('prompt').textContent)) await sleep(300);
    const btn = doc.getElementById('btn-rebuy');
    ok(btn && btn.disabled === false, '在座（哪怕账号 0）补给按钮可用');
    btn.click();                       // 账号 0 < 100 → 不弹死弹窗、不代办领取，只指路
    await sleep(500);
    const toastTxt = doc.getElementById('toast').textContent;
    ok(/返回大厅/.test(toastTxt) && !doc.querySelector('.overlay'),
      '账号 0 点补给指路「返回大厅」且不弹窗（toast=' + toastTxt.slice(0, 22) + '…）');
    dom.window.close();
    A.ws.close(); B.ws.close(); C.ws.close();
  }

  console.log(fails === 0 ? '\n体验走查测试全部通过 ✅' : '\n' + fails + ' 项失败 ❌');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e.message); process.exit(1); });
