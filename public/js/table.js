/* table.js —— 联机牌桌：只渲染服务端下发的视图，底牌只有本人能看到 */
(function () {
  const $ = s => document.querySelector(s);
  const el = {
    roomTag: $('#room-tag'), blindTag: $('#blind-tag2'), handTag: $('#hand-tag'),
    meName: $('#me-name2'), meChips: $('#me-chips2'), meTable: $('#me-table'),
    btnRebuy: $('#btn-rebuy'), btnStand: $('#btn-stand'), btnLobby: $('#btn-lobby'),
    btnPanel: $('#btn-panel'), side: $('.side'),
    fit: $('#table-fit'), canvas: $('#table-canvas'),
    phase: $('#phase'), pot: $('#pot b'), blind: $('#blind'),
    board: $('#board'), seats: $('#seats'), waiting: $('#waiting'),
    fx: $('#fx'), btnSound: $('#btn-sound'),
    prompt: $('#prompt'),
    btnFold: $('#btn-fold'), btnCall: $('#btn-call'), btnRaise: $('#btn-raise'),
    btnAllin: $('#btn-allin'), slider: $('#raise-slider'), quick: $('#quick'),
    timer: $('#timer'), timerBar: $('#timer-bar'), timerSec: $('#timer-sec'),
    log: $('#log'), chat: $('#chat'),
    chatText: $('#chat-text'), chatSend: $('#chat-send'),
    preActions: $('#pre-actions'), preCF: $('#pre-checkfold'), preCA: $('#pre-callany'),
    waitingText: $('#waiting-text'), btnStart: $('#btn-start'), btnStop: $('#btn-stop'),
    winBanner: $('#win-banner'), potStack: $('#pot-stack')
  };
  let myName = null, state = null, timerId = null;
  const ACTION_TIMEOUT = 30000;

  /* ---------- 预选动作（GG / PokerStars 标配） ----------
   * 轮不到我时把这一手要做的动作先勾好，轮到我的一瞬间自动执行 ——
   * 手机玩家没盯着屏幕时，这是唯一不靠运气不错过行动的方式。
   * 只在「当手」有效：换手 / 弃牌 / 全下时自动清除，
   * 避免勾了「过牌/弃牌」忘取消、下一手被自动弃掉这种最伤的误伤。 */
  let preAction = null;      // null | 'checkfold' | 'callany'

  // 新一手的底牌要挂「错峰淡入」动画：换手的那一帧置位，renderSeats 消费后复位
  let holeDeal = false;
  // 摊牌高亮集合：构成赢家最佳五张的牌（r-s 字符串为键），非摊牌态为 null
  let winCards = null;

  /* 街序表：判定「phase 是否向前推进了一条街」。
   * 街推进时座位前的下注筹码要收进底池（动画+音效）；
   * 新一手从 showdown/preflop 回到 preflop 属于回退，不触发。 */
  const STREET_ORDER = { preflop: 0, flop: 1, turn: 2, river: 3, showdown: 4 };
  // 上一次归池的签名（手数 + 注码组合）：全下跑马期间 bets 不清、逐街不变，
  // 靠它把「已经归过池的注码」挡住，不让跑马的每张公共牌重复触发归池动画
  let lastCollectSig = '';

  /* ---------- 倒计时的共用规则 ----------
   * 「我的倒计时」和「对手座位状态」必须用同一套阈值，否则同一时刻我看到黄、
   * 对手座位显示红，两边标准不一致就没法互相参照了。
   * 阈值：> 11s 充裕 / 8~11s 提醒 / < 8s 紧急。
   */
  const TIER_WARN = 11000;
  const TIER_URGENT = 8000;

  /** 服务端下发的超时时长；拿不到就退回本地常量。0 = 本房间不限制 */
  function actionTimeout() {
    const t = state && state.table ? state.table.actTimeout : 0;
    if (t === 0) return 0;                    // 不限制：调用方据此隐藏倒计时
    return t > 0 ? t : ACTION_TIMEOUT;
  }
  /** 剩余毫秒，已夹在 [0, timeout]，不会出现负值 */
  function msLeft(deadline) {
    if (!deadline) return 0;
    return Math.max(0, deadline - Date.now());
  }
  /** 剩余整秒。用 ceil：还剩 0.4 秒时显示 1 而不是 0，
   *  显示 0 会让玩家以为已经超时了但其实还能操作。 */
  function secLeft(deadline) {
    return Math.ceil(msLeft(deadline) / 1000);
  }
  /** 告警档位：ok / warn / urgent */
  function tierOf(deadline) {
    const left = msLeft(deadline);
    if (left < TIER_URGENT) return 'urgent';
    if (left <= TIER_WARN) return 'warn';
    return 'ok';
  }

  /* ---------- 固定比例画布 ----------
   * 牌桌不再按实测宽高比反推几何，而是固定在一块 1200×600（2:1）的逻辑画布上，
   * 整体按 min(可用宽/1200, 可用高/600) 等比缩放后居中，多余空间留白。
   * 这样任何视口下「牌 ÷ 桌」「座位相对位置」都是同一个数，玩家换设备不用重建空间记忆。
   */
  const CANVAS_W = 1200;      // 逻辑画布宽（CSS 像素），= table.css 的 .table-canvas width
  const CANVAS_H = 600;       // 逻辑画布高，2:1 是横屏设备比例的居中取值

  /* ---------- 九个固定座位槽位 ----------
   * 桌面是画布内居中的 900×400、圆角 120 的圆角长方形（见 table.css 的 .felt），
   * 于是直边区段为：水平 x ∈ [270, 930]，竖直 y ∈ [220, 380]。
   * 九个槽位全部落在直边上，没有一个骑在圆角弧上 —— 这是「同侧席位严格对齐」的前提。
   *
   * 编号即渲染顺序：0 号是本人（底边正中），其余自本人起顺时针环绕。
   * 座位数固定为 9，与在座人数无关；没人坐的槽位渲染成空位占位。
   *
   * 布局（底 3 / 右 2 / 顶 2 / 左 2，左右严格镜像）：
   *
   *        [6]                     [5]              y=100  顶边
   *   [7]                               [4]         y=220
   *   [8]                               [3]         y=380
   *        [1]      [0]=我      [2]                  y=500  底边
   *      x=430     x=600      x=770
   *   x=150                          x=1050
   *
   * ⚠️ 改动下面任何一个数都必须重跑 `node tools/layout-test.js`：
   *    「九席不重叠」这件事只由这张表保证，而且余量很紧 ——
   *    碰撞盒 140×101（卡片 140×56 + 牌向桌心探出 45）下最紧的是
   *    侧边上下两席（3-4 / 7-8，牌相向而出）只剩 14px，其次底边 0-1 / 0-2 的 30px。
   */
  const SLOTS = [
    { x: 600,  y: 500 },   // 0  本人，底边正中
    { x: 430,  y: 500 },   // 1  底边左
    { x: 770,  y: 500 },   // 2  底边右
    { x: 1050, y: 380 },   // 3  右下
    { x: 1050, y: 220 },   // 4  右上
    { x: 700,  y: 100 },   // 5  顶边右
    { x: 500,  y: 100 },   // 6  顶边左
    { x: 150,  y: 220 },   // 7  左上
    { x: 150,  y: 380 }    // 8  左下
  ];
  const SLOT_COUNT = SLOTS.length;

  /** 第 k 个槽位在 .seats 里的百分比坐标（.seats 铺满整块画布，所以直接除画布尺寸）。
   *  纯查表，与在座人数和视口都无关 —— 缩放只由 --tscale 承担。 */
  function seatPos(k) {
    const s = SLOTS[k];
    return {
      left: s.x / CANVAS_W * 100,
      top: s.y / CANVAS_H * 100,
      // 上半部的槽位要把下注额等浮层翻到另一侧，避免压住桌心
      flip: s.y < CANVAS_H / 2
    };
  }

  /** 算出画布的等比缩放系数写进 --tscale。
   *  只取一个系数、两轴同用：任一轴单独缩放就会破坏「比例固定」这个前提。
   *
   *  用 offsetWidth/offsetHeight（布局尺寸）而不是 getBoundingClientRect()：
   *  竖屏时 .rot-root 整体 rotate(90°)，getBoundingClientRect 返回的是**旋转后**的
   *  视觉包围盒（宽高被对调），会把 --tscale 算错、画布尺寸也不对；offsetWidth/Height
   *  是元素自身的布局尺寸，不受任何祖先 transform 影响，正是我们要的「旋转前可用区域」。
   *  量不到（元素未布局 / jsdom 无布局引擎）时直接跳过，留着上一次的值比写入 0 安全。 */
  function fitCanvas() {
    if (!el.fit || !el.canvas) return;
    const w = el.fit.offsetWidth, h = el.fit.offsetHeight;
    if (!w || !h) return;
    const s = Math.min(w / CANVAS_W, h / CANVAS_H);
    if (s > 0) el.canvas.style.setProperty('--tscale', s);
  }

  /* ---------- 身份 ---------- */
  Net.on('conn', s => { if (s === 'online') Net.send({ type: 'me' }); });
  Net.on('me', m => {
    if (!m.user) return location.href = 'index.html';
    myName = m.user.name;
    el.meName.textContent = myName;
    if (m.room) return;
    // me 里没带房间，可能是刚刷新页面、服务端还没把这条连接关联上。
    // 别立刻跳走（会和「大厅发现牌局进行中→跳牌桌」形成死循环），
    // 等一小会儿看有没有收到房间广播再决定。
    setTimeout(() => { if (!state) location.href = 'lobby.html'; }, 1500);
  });
  Net.on('needLogin', () => location.href = 'index.html');
  Net.on('auth', m => { if (!m.ok) location.href = 'index.html'; });
  Net.on('error', m => UI.toast(m.msg || '操作失败', 'err'));
  Net.on('notice', m => UI.toast(m.msg));
  Net.on('state', s => {
    const prevHand = state && state.table ? state.table.handCount : 0;
    const prevPhase = state && state.table ? state.table.phase : '';
    const prevPot = state && state.table ? state.table.pot : 0;
    const prev = state;                 // 旧状态对象：收集动画的坐标要从它取
    state = s;
    // 换手 / 回到空闲：上一手的动作反馈与预选必须清掉，否则会残留到下一手
    const curHand = s.table ? s.table.handCount : 0;
    const curPhase = s.table ? s.table.phase : '';
    if (curHand !== prevHand || (curPhase === 'idle' && prevPhase !== 'idle')) {
      clearFlashes();
      preAction = null;                 // 预选只在当手有效
      syncPreBtns();
      if (s.room && s.room.status === 'playing' && curHand > 0) holeDeal = true;
    }
    // 预选失效条件：我弃牌 / 全下 / 不在牌里 —— 此刻不清，预选会在
    // 下一手继续生效，玩家以为早就不在了却被自动弃一手牌。
    if (preAction && s.table) {
      const me = s.table.you && s.table.you.seat >= 0 ? s.table.seats[s.table.you.seat] : null;
      if (!me || me.folded || me.allIn || !me.inHand || s.table.phase === 'idle') {
        preAction = null; syncPreBtns();
      }
    }
    // 街推进：座位前的下注筹码收进底池。必须在 render 之前 ——
    // 收集动画的起点坐标取自旧 DOM 的 .bet 元素，render 一重建就没了。
    if (prev && STREET_ORDER[curPhase] > STREET_ORDER[prevPhase]) {
      const betters = (prev.table.seats || []).filter(x => x.bet > 0 && x.name);
      if (betters.length) {
        // 同一手里同样的注码组合只归池一次。引擎在整个跑马期间不清 s.bet
        //（清零发生在下一条街的 bettingRound 开头，而跑马没有下注圈），
        // 不去重的话每翻一张牌都会把已经归过池的全下注码再「归」一遍。
        // 手数进签名：连续两手同为盲注底池时，注码组合相同但钱是新的，不能跳。
        const sig = curHand + '|' + betters.map(b => b.i + ':' + b.bet).join(',');
        if (sig !== lastCollectSig) { lastCollectSig = sig; collectBets(betters); }
      }
      playStreetSound();
    }
    trackActions();
    render();
    // 底池有进账：数字弹一拍
    if (s.table && s.table.pot > prevPot) bumpPot();
    // 轮到我的一瞬间：执行预选动作
    maybeAutoPre();
  });

  /* ---------- 渲染 ---------- */
  let firstRender = true;
  let prevSeat = null;      // 上一次渲染时我的座位号（null = 尚未渲染过），用于判定「刚入座」
  let prevMyTurn = false;   // 上一次渲染时是否轮到我行动，用于判定「刚轮到我」
  function render() {
    if (!state) return;
    const room = state.room, t = state.table, you = t.you;
    // 摊牌高亮集合：结算结果里每个赢家 hand.best 的五张牌（服务端本来就在下发，
    // 引擎 evaluate 的产物）。弃牌收池没有 revealed，集合保持空 —— 不高亮。
    winCards = null;
    const res = state.result;
    if (res && res.revealed && res.seats) {
      const wonIdx = {};
      res.seats.forEach(x => { if (x.won > 0) wonIdx[x.index] = true; });
      res.revealed.forEach(x => {
        if (!wonIdx[x.index]) return;
        (x.hand && x.hand.best || []).forEach(c => {
          (winCards = winCards || {})[c.r + '-' + c.s] = 1;
        });
      });
    }
    el.roomTag.textContent = room.title + '（' + room.id + '）';
    el.blindTag.textContent = '盲注 ' + room.sb + '/' + room.bb;
    el.handTag.textContent = '第 ' + (room.handCount || 0) + ' 手';
    el.meChips.textContent = UI.fmt(you.account);
    el.meTable.textContent = '桌上 ' + UI.fmt(you.tableChips || 0);
    // 阶段/手数、房间号/盲注都放在牌桌内部标签里：手机横屏会隐藏顶栏信息条，这里必须自给自足
    el.phase.textContent = (room.status === 'playing' ? (t.phaseName || '准备') : '等待开局') +
      (t.handCount ? ' · 第 ' + t.handCount + ' 手' : '');
    // 摊牌结算期底池已清空（引擎到下一手才归零）：显示 0 而不是残留旧值
    el.pot.textContent = UI.fmt(t.phase === 'showdown' ? 0 : t.pot);
    el.blind.textContent = room.id + ' · 盲注 ' + room.sb + '/' + room.bb;
    el.waiting.hidden = room.status === 'playing';
    // 房主的开局控制（大厅不再承载房间内操作，控制跟着房主进牌桌）：
    // 等待阶段显示「开始牌局」，人数不足时置灰并说明原因；
    // 牌局进行中顶栏显示「结束牌局」（作废本手、筹码退回，危险操作藏一次点击）。
    if (el.btnStart && el.btnStop) {
      const isHost = room.host === myName;
      el.btnStart.hidden = !(isHost && room.status !== 'playing');
      if (!el.btnStart.hidden) {
        const ready = (t.seats || []).filter(s => s.name && s.chips > 0).length;
        el.btnStart.disabled = ready < 2;
        el.btnStart.title = ready < 2 ? '至少需要 2 位玩家坐下并持有筹码' : '';
      }
      el.btnStop.hidden = !(isHost && room.status === 'playing');
    }
    el.btnStand.disabled = you.seat < 0;
    el.btnRebuy.disabled = you.seat < 0;
    // 补给按钮的两种状态说清楚：灰 = 还没入座（补给是把账号的钱加到**桌上**，
    // 没有座就没有去处），title 把原因写出来而不是让人干看着一个灰按钮；
    // 亮 + 高亮 = 在座且桌上筹码已打光 —— 这是最需要补给的时刻，
    // 引擎不会给 0 筹码的人发牌，不提示的话玩家只会疑惑「为什么没我的牌」。
    el.btnRebuy.title = you.seat < 0
      ? '入座后才能把账号筹码补给到桌上'
      : '把账号筹码补给到桌上';
    el.btnRebuy.classList.toggle('need', you.seat >= 0 && (you.tableChips || 0) <= 0);
    // 轮到我时给一声轻提示（音效开着才有）：手机玩家不会一直盯着屏幕，
    // 没有声音提醒的话 30 秒一到就被判超时弃牌 —— 那是最委屈的输法。
    // 只在「从没轮到我 → 轮到我」的跳变时响一次，行动完/弃牌后标志复位。
    if (you.act) {
      if (!prevMyTurn) playTurnCue();
      prevMyTurn = true;
    } else {
      prevMyTurn = false;
    }
    // 牌局进行中落座要等下一手才发牌，不提示的话玩家会以为没坐上
    if (prevSeat !== null && prevSeat < 0 && you.seat >= 0 && room.status === 'playing') {
      UI.toast('已入座，从下一手开始参与');
    }
    prevSeat = you.seat;

    renderBoard();
    renderSeats();
    renderWinBanner(res);  // 结算展示期：桌面中央的获胜横幅（res 即上文 winCards 用的 state.result）
    renderPotStack();      // 桌心底池筹码堆：pot 金额的图形化
    maybeAward();          // 必须在 renderSeats 之后：动画要按座位 DOM 的落点算坐标
    renderLog(state.logs || []);
    renderChat(state.chat || []);
    renderActions();
    // 首帧渲染完再补一次：脚本执行时侧栏/操作条可能还没定下最终高度
    if (firstRender) { firstRender = false; scheduleFit(); }
  }

  /** 公共牌：五个位置固定（GG 同款）。以前按已发张数整体居中 —— 翻牌三张
   *  在中央，转牌落下时三张一起左移给新牌让位，河牌再挪一次，玩家建立的
   *  位置记忆每条街被打破一次。现在五个槽位从翻牌前就钉死：未发出的位置
   *  渲染透明占位（.bslot），只有几何锚点的作用 —— 不是视觉占位，玩家
   *  看到的依然只有已发出的牌。
   *  新街翻开的牌错峰入场（对比上一帧的张数，多出来的就是本街新牌）；
   *  摊牌时构成赢家最佳五张的公共牌描金框（.hl）。 */
  function renderBoard() {
    const b = state.table.board || [];
    const lastN = renderBoard.n || 0;
    // 入场动画只挂「本帧新出现」的牌（下标 ≥ 上一帧张数）。
    // 以前写成「有新牌时全体挂 .deal」：转牌落下时已翻的翻牌三张会全部
    // 重闪一遍 —— 已发出的牌必须纹丝不动，动画只属于正在发的那张。
    const cls = (c, i) =>
      (i >= lastN ? 'deal ' : '') + (winCards && winCards[c.r + '-' + c.s] ? 'hl' : '');
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += b[i] ? UI.cardHTML(b[i], cls(b[i], i)) : '<div class="bslot"></div>';
    }
    el.board.innerHTML = html;
    // 新牌错峰：本街第几张决定延迟（翻牌三张连着翻，转牌/河牌单独翻）
    if (b.length > lastN) {
      let k = 0;
      [].forEach.call(el.board.querySelectorAll('.card.deal'),
        n => { n.style.animationDelay = (k++ * 0.13) + 's'; });
    }
    el.board.classList.toggle('has-cards', b.length > 0);
    renderBoard.n = b.length;
  }

  /* ---------- 获胜横幅（GG 的结算横幅） ----------
   * 结算展示期内桌面中央显示「谁 赢得 多少（牌型）」。弃牌收池没有摊牌、
   * 没有牌型标签，赢家在桌面上原本完全不可见 —— 这行横幅是那一手唯一的
   * 桌面级结论；摊牌时则与牌型标签互补（标签在座位上，横幅是全桌结论）。
   * 内容每帧按 state.result 重建（幂等，动画只由 .show 的首挂触发）；
   * result 清空（展示期结束）自动退场，天然不会残留到下一手。 */
  function renderWinBanner(res) {
    const b = el.winBanner;
    if (!b) return;
    const winners = res && res.seats ? res.seats.filter(x => x.won > 0) : [];
    if (!winners.length) { b.classList.remove('show', 'mine'); return; }
    // 摊牌赢家从 revealed 匹配牌型；弃牌收池无 revealed，显示「无人摊牌」
    const handOf = {};
    (res.revealed || []).forEach(x => { if (x.hand && x.hand.name) handOf[x.index] = x.hand.name; });
    const fold = res.reason === 'fold';
    const you = state.table.you;
    const mine = !!(you && you.seat >= 0 && winners.some(w => w.index === you.seat));
    // 弃牌收池不展示牌型：没摊牌就没有牌型可展示（赢家的 hand 虽然在
    // revealed 里，亮出来等于替他翻开本可以 muck 的牌）。只有摊牌才配牌型括号。
    // 结算分池（边池）：每个池一行 —— 「主池 5,000 · Lew123（两对）」；
    // 曾挤成一根长胶囊（多赢家顿号相连），竖屏上超屏截断、主次不分。
    const nameOf = idx => { const s = res.seats[idx]; return s ? s.name : '?'; };
    const row = (txt, side) => '<div class="wb-row' + (side ? ' wb-side' : '') + '">' + txt + '</div>';
    const pots = (res.pots || []).filter(p => p.amount > 0 && p.winners.length);
    let html;
    if (!fold && pots.length > 1) {
      html = pots.map((p, i) => {
        const names = p.winners.map(idx => {
          const h = handOf[idx];
          return UI.esc(nameOf(idx)) + (h ? '（' + UI.esc(h) + '）' : '');
        }).join('、');
        return row('<b>' + (i === 0 ? '主池' : '边池 ' + i) + ' ' + UI.fmt(p.amount) + '</b> · ' + names, i > 0);
      }).join('');
    } else {
      html = row(winners.map(w =>
        UI.esc(w.name) + ' 赢得 ' + UI.fmt(w.won) +
        (!fold && handOf[w.index] ? '（' + UI.esc(handOf[w.index]) + '）' : '')
      ).join('、') + (fold ? ' · 无人摊牌' : ''));
    }
    b.innerHTML = html;
    b.classList.toggle('mine', mine);
    b.classList.add('show');
    fitBannerText(b);
  }

  /** 结算行文字自适应：名字过长时不打省略号，先把字号缩到装得下（GG 同款）。
   *  每行独立缩放 —— 主池行正常、只有名字超长的边池行缩小，主次仍然分明。
   *  幂等：renderWinBanner 每帧重建 innerHTML 后调用，style.fontSize 先复位再量。 */
  function fitBannerText(b) {
    b.querySelectorAll('.wb-row').forEach(row => {
      row.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(row).fontSize);
      // 缩到装下为止；10px 是下限（再小读不了，宁可在极长名字下回到省略号）
      while (row.scrollWidth > row.clientWidth + 1 && fs > 10) {
        fs -= 1;
        row.style.fontSize = fs + 'px';
      }
    });
  }

  /* ---------- 桌心底池筹码堆 ----------
   * 底池数字的大小感交给眼睛：0 无堆、小额 3 枚、中额 5 枚、大额 7 枚封顶，
   * 金额越大掺入的红/紫面额越多（与真筹码「高面额换色」的直觉一致）。
   * 每帧按 t.pot 重建（幂等）；等待期 pot=0 自然消失。 */
  function renderPotStack() {
    const box = el.potStack;
    if (!box) return;
    const tb = state.table || {};
    const pot = tb.pot || 0;
    // 摊牌结算期：底池已分走（引擎到下一手才清 pot），桌心的筹码堆清空
    if (pot <= 0 || tb.phase === 'showdown') { box.innerHTML = ''; return; }
    const n = pot <= 200 ? 3 : pot <= 2000 ? 5 : 7;
    let html = '';
    for (let i = 0; i < n; i++) {
      // 自下而上叠；中额起掺红、大额再掺紫
      const color = (i >= n - 2 && n >= 5) ? (i === n - 1 && n === 7 ? 'c-purple' : 'c-red') : 'c-gold';
      html += '<i class="' + color + '" style="bottom:' + (i * 4) + 'px"></i>';
    }
    box.innerHTML = html;
  }

  /* ---------- 动作反馈（闪现 3 秒） ----------
   * 判定「这是一次新动作」靠服务端下发的 actionSeq 变化，不比较文案：
   * 同一轮里两个人都可能是「跟注 50」，比文案会漏判。
   *
   * 状态存在 JS 里而不是 DOM 里：renderSeats 是整块重建 innerHTML 的，
   * 存在 DOM 上会被下一次渲染冲掉。
   */
  const FLASH_MS = 3000;
  const flashes = new Map();       // 座位号 -> { seq, text, byTimeout, until, hand }
  let seatTickId = null;

  /** 对比 actionSeq，登记新动作。
   *  每条记录带上「属于第几手」：渲染时只认当前手的记录，反馈天然不跨手。
   *  不这么做的话换手很难处理 —— 新一手的盲注动作和 handCount 的变化是同一帧到达的，
   *  「先清空再登记」会让盲注立刻把反馈填回来，看起来就像上一手没清掉。 */
  function trackActions() {
    const t = state && state.table;
    if (!t) return;
    const hand = t.handCount || 0;
    (t.seats || []).forEach(s => {
      if (!s.name || !s.lastAction) return;
      const seq = s.actionSeq || 0;
      if (seq <= 0) return;
      const cur = flashes.get(s.i);
      // 同一玩家连续行动时：内容更新，驻留计时重新开始
      if (!cur || cur.seq !== seq) {
        flashes.set(s.i, {
          seq: seq, text: s.lastAction, byTimeout: !!s.byTimeout,
          until: Date.now() + FLASH_MS, hand: hand
        });
        // 对手把筹码推进池（跟注/加注/全下）：一声轻碰撞。自己的动作不响
        // （自己下注自己听是回声）；过牌/弃牌无筹码转移、盲注文案
        // （小盲/大盲）是规则动作，正则天然都不命中。
        if (s.name !== myName && /跟注|加注|全下/.test(s.lastAction)) playBetSound();
      }
    });
  }

  /** 取某座位当前有效的反馈：跨手的、已到点的都不算 */
  function flashOf(seatIdx) {
    const f = flashes.get(seatIdx);
    if (!f) return null;
    const hand = (state && state.table) ? (state.table.handCount || 0) : 0;
    if (f.hand !== hand) return null;          // 属于上一手，不显示
    if (Date.now() >= f.until) return null;    // 已过 3 秒驻留期
    return f;
  }

  /** 座位下的动作文字去掉金额：「加注到 200」→「加注」。金额在下注额胶囊
   *  与 3 秒动作反馈里都有（第三处重复），且 16px 的大号胶囊向卡内生长后，
   *  带金额的长文字会与它在卡下方水平打架 —— 精简后这行永远短于胶囊左沿。 */
  function shortAction(a) {
    return String(a || '').replace(/\s+[\d.,K]+$/, '').replace('加注到', '加注');
  }

  /** 牌局整体回到空闲时彻底清空，避免下次开局闪出旧内容 */
  function clearFlashes() { flashes.clear(); }

  /** 只改 class 与文本，不重建 DOM ——
   *  重建会让脉冲动画每帧重启，看起来像坏了。 */
  function tickSeats() {
    if (!state || !state.table) return;
    const t = state.table;
    const nodes = el.seats.querySelectorAll('.seat');
    let alive = false;

    [].forEach.call(nodes, node => {
      // 空槽位没有 data-seat，也没有任何需要逐帧更新的东西，直接跳过
      if (node.dataset.seat === undefined) return;
      const i = parseInt(node.dataset.seat, 10);

      // 当前行动者：按剩余时间递进档位（与本人倒计时同一套阈值）
      if (t.actSeat === i && t.actDeadline) {
        const tier = tierOf(t.actDeadline);
        if (node.dataset.tier !== tier) {
          node.classList.remove('t-ok', 't-warn', 't-urgent');
          node.classList.add('t-' + tier);
          node.dataset.tier = tier;
        }
        // 最后 5 秒：座位倒计时胶囊脉冲（视觉与操作条同拍；声音只有本人那条路径）
        node.classList.toggle('t-critical', secLeft(t.actDeadline) <= 5);
        const secNode = node.querySelector('.seat-sec');
        if (secNode) secNode.textContent = secLeft(t.actDeadline);
        alive = true;
      } else if (node.dataset.tier) {
        node.classList.remove('t-ok', 't-warn', 't-urgent', 't-critical');
        delete node.dataset.tier;
      }

      // 动作反馈到点淡出
      const f = flashOf(i);
      const box = node.querySelector('.act-flash');
      if (f) {
        alive = true;
      } else if (box && !box.classList.contains('gone')) {
        box.classList.add('gone');
      }
    });

    if (!alive && seatTickId) { clearInterval(seatTickId); seatTickId = null; }
  }

  function startSeatTick() {
    if (seatTickId) return;
    seatTickId = setInterval(tickSeats, 200);
  }

  function renderSeats() {
    const t = state.table;
    const all = t.seats || [];
    // 服务端固定下发 9 个槽位（空位 name 为 null），这里全部渲染，不再过滤在座玩家。
    // 席位因此在人员进出时完全稳定：别人坐下或离座不会让其他人换位置。
    const mi = all.findIndex(s => s.name && s.name === myName);

    // 服务端座位号 -> 槽位号 的映射
    const slotOf = new Array(SLOT_COUNT).fill(-1);
    if (mi >= 0) {
      // 已入座：本人落在槽位 0（底边正中），其余按服务端座位顺序顺时针铺开。
      for (let k = 0; k < SLOT_COUNT; k++) slotOf[(mi + k) % SLOT_COUNT] = k;
    } else {
      // 未入座（旁观）：没有「本人」这个基准点可供旋转。
      // 若直接拿服务端座位号当槽位号，3 个人会全落在槽位 0/1/2 —— 恰好都在底边，
      // 看起来像所有人挤在一侧、另外三边全空。
      // 改为把在座玩家沿九个槽位等距摊开：
      //   第 j 个在座玩家 -> 槽位 round(j * 9 / 人数)
      // 这样同时满足「分散」「保持相对顺序」「同一房间状态下结果稳定」，
      // 满席时 9/9 = 1，退化成一一对应。
      const occupied = [];
      all.forEach((s, i) => { if (s && s.name) occupied.push(i); });
      const n = occupied.length;
      if (n > 0) {
        occupied.forEach((seatIdx, j) => {
          slotOf[seatIdx] = Math.round(j * SLOT_COUNT / n) % SLOT_COUNT;
        });
      }
    }
    // 反向索引：槽位号 -> 服务端座位（没人则为 null）
    const bySlot = new Array(SLOT_COUNT).fill(null);
    slotOf.forEach((slot, seatIdx) => {
      if (slot >= 0 && all[seatIdx] && all[seatIdx].name) bySlot[slot] = all[seatIdx];
    });

    // 未入座时空位可点击直接坐下（买入额取「房间买入」与「账号余额」的较小者，
    // 服务端还会再夹一次上下限，余额低于最低买入时会自动按全部身家上桌）
    const you = t.you || {};
    const seated = you.seat >= 0;
    const acc = you.account || 0;
    const buyAmt = Math.max(1, Math.min(state.room.buyIn, acc));

    // 跑马等价的最大值（领跑方高亮用）
    let maxEq = -1;
    all.forEach(s => { if (s && s.eq != null && s.eq > maxEq) maxEq = s.eq; });

    let html = '';
    for (let k = 0; k < SLOT_COUNT; k++) {
      const s = bySlot[k];
      const p = seatPos(k);
      const posStyle = 'style="left:' + p.left + '%;top:' + p.top + '%"';

      // ---- 空槽位：占位形态，不含任何玩家信息 ----
      if (!s) {
        // 已入座或账号没钱时保持只读，避免误触；其余情况可点击坐下。
        // 槽位号 ≠ 服务端座位号（槽位是前端按「本人居中」重排的虚拟位置），
        // 所以落座由前端挑一个真实空位号，坐下后本人会自动落到槽位 0（底边正中）。
        // 可坐的空位**常显「＋坐下」**：以前只在 hover 时才亮出来，触屏有
        // hover:none 兜底、桌面端却什么都没有 —— 新用户第一眼根本不知道能点。
        const canSit = !seated && acc > 0;
        html += '<div class="seat empty' + (p.flip ? ' flip' : '') + (canSit ? ' can-sit' : '') + '" ' +
          'data-slot="' + k + '"' + (canSit ? ' title="坐下 · 买入 ' + UI.fmt(buyAmt) + '"' : '') + ' ' + posStyle + '>' +
          '<div class="info"><span class="empty-tag">' + (canSit ? '＋ 坐下' : '空位') + '</span></div>' +
          '</div>';
        continue;
      }

      const mine = s.name === myName;
      const isTurn = t.currentIdx === s.i;
      // 两张底牌必须包进 .hole 才会横向并排。
      // 对手之间等大（.card.small）；本人的牌加 .big（对手 × 1.2，GG 式）——
      // 全屏唯一需要读清数字的牌，放大是可读性投资而非炫技。
      // （旧约定"所有人等大"已由本变更按用户决策废除，断言见 layout/visual-test。）
      // .hole 是卡片上方的绝对定位浮层，不参与座位卡布局：
      // 空位/未发牌/弃牌时它整块消失，若参与布局座位就会忽高忽低。
      let cards = '';
      if (s.inHand) {
        // 新一手挂 .deal（错峰淡入），delay 按「座位号 × 70ms」写在 data-d 上。
        // 摊牌时构成赢家最佳五张的底牌同样描金框。
        const hlC = c => 'small' + (mine ? ' big' : '') +
          (winCards && winCards[c.r + '-' + c.s] ? ' hl' : '');
        cards = '<div class="hole' + (holeDeal ? ' deal' : '') + '" data-d="' + (s.i * 70) + '">' +
          (s.hole
            ? s.hole.map(c => UI.cardHTML(c, hlC(c))).join('')
            : '<div class="card small back"></div><div class="card small back"></div>') + '</div>';
      }
      let badges = '';
      if (s.bot) badges += '<span class="badge bot">AI</span>';
      if (!s.connected) badges += '<span class="badge hand">掉线</span>';
      // 小盲/大盲：缩成头像左上角的圆标 —— 曾挂在右上角与「你的牌」并排，
      // 实测横排正好盖住本人手牌下缘（GG 同款：盲注标就贴在头像角上）。
      const posTags = (t.sbIdx === s.i ? '<span class="pos-tag sb">小</span>' : '') +
        (t.bbIdx === s.i ? '<span class="pos-tag bb">大</span>' : '');
      // 我的当前牌型（翻牌起服务端每条街都在算，stateFor 的 you.hand）：
      // 挪到名牌下方的反馈位常驻绿字 —— 曾挂在右上角，横排「大盲/你的牌 一对」
      // 实测盖住手牌。下方是行动反馈位（act-flash 飞入动画已播过即时反馈）。
      const myHandLive = (mine && t.you && t.you.hand && s.inHand && !s.folded)
        ? '你的牌 ' + UI.esc(t.you.hand) : null;
      // 牌型不放在这里 —— 对手的 .sub 是整体隐藏的（见 app.css），
      // 塞进来就只有自己看得见。它单独走 .hand-tag 浮层（见下）。
      const status = isTurn
        ? '<div class="thinking">' + (s.connected ? '行动中…' : '掉线等待') + '</div>'
        : (myHandLive
          ? '<div class="last hand-live">' + UI.esc(myHandLive) + '</div>'
          : (s.lastAction ? '<div class="last">' + UI.esc(shortAction(s.lastAction)) + '</div>' : ''));

      // 行动中的人：座位上挂一个倒计时秒数
      const isActing = t.actSeat === s.i && !!t.actDeadline;
      const tier = isActing ? tierOf(t.actDeadline) : '';
      const secTag = isActing
        ? '<div class="seat-sec">' + secLeft(t.actDeadline) + '</div>'
        : '';

      // 动作反馈浮层：absolute + pointer-events:none，完全不参与布局。
      // 它在画布内，所以随画布一起等比缩放，与座位的相对关系恒定。
      // 位置在座位卡下方 —— 上方归底牌，两者不能抢同一块地方：
      // 反馈已经没有「退化成圆点」的退路，一旦重叠就是长期遮挡底牌。
      const f = flashOf(s.i);
      const flash = f
        ? '<div class="act-flash' + (f.byTimeout ? ' by-timeout' : '') + '">' +
            (f.byTimeout ? '<i class="to-tag">超时</i>' : '') +
            '<span class="af-text">' + UI.esc(f.text) + '</span>' +
          '</div>'
        : '';

      // 「出局」只在筹码为 0 且**不在本手牌局中**时成立：全下的玩家身后也是 0，
      // 但他仍在牌里、不该被灰掉（那会和「已淘汰」混为一谈）。
      const isOut = s.chips <= 0 && !s.inHand;
      // 本轮下注：全下时标注「ALL IN」，否则显示金额；押注前不占位。
      // 摊牌后桌面清场（GG 同款）：底池已分给赢家，座位前的注码胶囊不再显示。
      // 引擎要到下一手 startHand 才清 s.bet，不去掉的话整个结算展示期
      // 注码都挂在座位旁 —— 实测挡住名牌/筹码数，玩家以为钱没进池。
      const settled = t.phase === 'showdown';
      const betTag = s.bet > 0 && !settled
        ? '<div class="bet' + (s.allIn ? ' allin' : '') + '">' + UI.fmt(s.bet) + '</div>'
        : '';
      // 庄家按钮（Dealer Button）：独立浮层，不放进 .sub（对手的 .sub 是隐藏的）——
      // 庄位是全桌公开信息，所有人都必须看得见。做成醒目的白金圆形筹码。
      const dealerChip = (t.buttonIdx === s.i)
        ? '<div class="dealer-chip" title="庄家">D</div>'
        : '';
      // 摊牌牌型：独立浮层，所有未弃牌者都显示 —— .sub 对对手是隐藏的，
      // 而摊牌恰恰要看所有人的牌型。s.hand 由服务端在摊牌态下发，未摊牌时为空。
      const handTag = s.hand
        ? '<div class="hand-tag' + (s.won > 0 ? ' won' : '') + '">' + UI.esc(s.hand) + '</div>'
        : '';
      // 全下跑马等价：与 .hand-tag 同一个位置（两者从不同屏：跑马结束等价清空、
      // 牌型上岗）。领跑的一方金色高亮 —— 跑马的看点就是「谁领先、牌面怎么翻」。
      const eqTag = (s.eq != null)
        ? '<div class="eq-tag' + (s.eq === maxEq ? ' lead' : '') + '">' + s.eq + '%</div>'
        : '';
      html += '<div class="seat' + (p.flip ? ' flip' : '') + (s.folded ? ' folded' : '') +
        (isTurn ? ' turn' : '') + (isOut ? ' out' : '') + (mine ? ' mine' : '') +
        (isActing ? ' acting t-' + tier : '') + '" ' +
        'data-seat="' + s.i + '" data-slot="' + k + '"' +
        (isActing ? ' data-tier="' + tier + '"' : '') + ' ' + posStyle + '>' +
        cards +
        handTag +
        eqTag +
        '<div class="info">' +
          '<div class="avatar">' + UI.esc(s.name.slice(0, 1)) + '</div>' + posTags +
          '<div class="itxt">' +
            // 不带「（我）」后缀：金色高亮 + 固定 0 号位已经标识了自己，
            // 后缀会把窄昵称行挤到截断（fb99227（我）→ fb9922…）
            '<div class="nm">' + UI.esc(s.name) + '</div>' +
            '<div class="chips">' + UI.fmt(s.chips) + '</div>' +
          '</div>' +
        '</div>' +
        (badges ? '<div class="sub">' + badges + '</div>' : '') +
        dealerChip +
        secTag +
        status +
        flash +
        betTag +
        '</div>';
    }
    el.seats.innerHTML = html;

    // 新一手底牌的错峰入场：把 data-d 写成 animation-delay，然后消费掉标志。
    // 顺带播一声发牌的「唰」—— 音效开着才有。
    if (holeDeal) {
      [].forEach.call(el.seats.querySelectorAll('.hole.deal'),
        h => { h.style.animationDelay = (h.dataset.d || 0) + 'ms'; });
      holeDeal = false;
      playStreetSound();
    }

    if (flashes.size || (t.actSeat >= 0 && t.actDeadline)) startSeatTick();
  }

  /* ---------- 结算：底池筹码飞向赢家 + 音效 ---------- */
  let lastAwardSeq = -1;

  function maybeAward() {
    const r = state.result;
    if (!r || !r.seats) return;
    // 用服务端给的结果序号判定新旧：handCount 在重开一局后从 1 重新数，会撞车
    if (r.seq === lastAwardSeq) return;
    lastAwardSeq = r.seq;
    awardChips(r);
    bounceWinnerChips(r);
    // 赢家提示：结算信息目前都在牌局记录里，赢了的人却没有任何直接反馈。
    // 弹一条 toast —— 这是牌桌上唯一属于「我的时刻」，值得说一声。
    const t = state.table;
    if (t && t.you && t.you.seat >= 0) {
      const mine = (r.seats || []).find(x => x.index === t.you.seat);
      if (mine && mine.won > 0) {
        const hand = (r.revealed || []).find(x => x.index === t.you.seat);
        UI.toast('你赢得 ' + UI.fmt(mine.won) + (hand && hand.hand ? '（' + hand.hand.name + '）' : ''), 'win');
      }
    }
  }

  /** 赢家座位筹码数字弹一拍：结算帧里飞筹码之外，座位上的数字本身也要
   *  「跳」一下 —— 到账的反馈不只靠声音。renderSeats 每帧整块重建 innerHTML
   *  会重置 CSS class 动画，所以走 Web Animations 的一次性 animate；
   *  用 result.seq 去重（与结算动画同一判定），不依赖筹码快照对比。 */
  function bounceWinnerChips(r) {
    const winners = (r.seats || []).filter(s => s.won > 0);
    winners.forEach(w => {
      const seat = el.seats.querySelector('.seat[data-seat="' + w.index + '"]');
      const chip = seat && seat.querySelector('.chips');
      if (!chip || !chip.animate) return;      // jsdom / 老浏览器静默跳过
      chip.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(1.28)', offset: .4 },
        { transform: 'scale(1)' }
      ], { duration: 460, delay: 560, easing: 'cubic-bezier(.3,1.4,.4,1)' });
    });
  }

  function awardChips(r) {
    const fx = el.fx;
    if (!fx) return;
    const winners = (r.seats || []).filter(s => s.won > 0);
    if (!winners.length) return;

    // 起点是桌面正中（底池所在），终点是各赢家座位中心。
    // 坐标取 offsetLeft/offsetTop：那是不含 --tscale 的布局像素，
    // 与 .fx 的 clientWidth/Height 同一坐标系，不必再换算缩放。
    const ox = fx.clientWidth / 2, oy = fx.clientHeight / 2;
    let flew = 0;
    winners.forEach(w => {
      const node = el.seats.querySelector('.seat[data-seat="' + w.index + '"]');
      if (!node) return;                    // 赢家已离座（座位不再渲染）就没得飞
      const tx = node.offsetLeft + node.offsetWidth / 2;
      const ty = node.offsetTop + node.offsetHeight / 2;
      // 赢得越多推过去的筹码越多
      const n = Math.max(3, Math.min(8, 3 + Math.floor(w.won / 250)));
      for (let i = 0; i < n; i++) flyChip(ox, oy, tx, ty, i);
      flew += n;
    });
    if (flew) playAward(Math.min(flew, 10));
  }

  /** 一枚筹码的飞行。抛物线靠中间关键帧抬高 30px 做出来；起点/终点各加随机散布 ——
   *  整齐划一地平移不像筹码，像进度条。 */
  function flyChip(ox, oy, tx, ty, i) {
    const c = document.createElement('div');
    c.className = 'chip-fly';
    const sx = ox + (Math.random() - 0.5) * 46;
    const sy = oy + (Math.random() - 0.5) * 24;
    const ex = tx + (Math.random() - 0.5) * 34;
    const ey = ty + (Math.random() - 0.5) * 16;
    c.style.left = sx + 'px';
    c.style.top = sy + 'px';
    el.fx.appendChild(c);
    const dx = ex - sx, dy = ey - sy;
    const dur = 620 + Math.random() * 220;
    const delay = i * 65 + Math.random() * 40;
    const drop = () => c.remove();
    // 双保险：onfinish 在后台标签页会随动画一起暂停、极端情况下不来，
    // fill:forwards 的筹码就永远停在赢家座位上 —— 定时器晚 400ms 兜底强制清场
    setTimeout(drop, delay + dur + 400);
    // 没有 Web Animations（老浏览器 / jsdom）就不硬撑，直接把元素撤掉
    if (!c.animate) { setTimeout(drop, delay + dur); return; }
    const a = c.animate([
      { transform: 'translate(0px,0px) scale(.55) rotate(0deg)', opacity: 0 },
      { transform: 'translate(' + (dx * .2) + 'px,' + (dy * .2 - 30) + 'px) scale(1.08) rotate(140deg)', opacity: 1, offset: .2 },
      { transform: 'translate(' + (dx * .65) + 'px,' + (dy * .65 - 34) + 'px) scale(1) rotate(280deg)', opacity: 1, offset: .62 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.8) rotate(400deg)', opacity: 1 }
    ], { duration: dur, delay, easing: 'cubic-bezier(.3,.12,.35,1)', fill: 'forwards' });
    a.onfinish = drop;
  }

  /* ---------- 街末收集：座位前的下注筹码飞进底池 ----------
   * 每条街结束时，各家面前的筹码动画收进底池正中 —— 没有这一步的话，
   * 筹码是「啪」一下凭空消失、底池数字默默变大，钱去哪了全靠脑补。
   * GG / PokerStars 都有「下注在座位前 → 街末归池 → 摊牌推给赢家」的
   * 完整链路；本项目此前只有最后一段（awardChips）。
   * 调用时机在 render 之前：起点坐标取自旧 DOM 的 .bet 元素。 */
  function collectBets(betters) {
    const fx = el.fx;
    if (!fx) return;
    const ox = fx.clientWidth / 2, oy = fx.clientHeight / 2;
    let flew = 0;
    betters.forEach(b => {
      const seat = el.seats.querySelector('.seat[data-seat="' + b.i + '"]');
      if (!seat) return;
      const betEl = seat.querySelector('.bet');
      // .bet 的 offsetParent 是 .seat（.seat 是定位元素），要补上座位自身的偏移
      const sx = betEl
        ? seat.offsetLeft + betEl.offsetLeft + betEl.offsetWidth / 2
        : seat.offsetLeft + seat.offsetWidth - 8;
      const sy = betEl
        ? seat.offsetTop + betEl.offsetTop + betEl.offsetHeight / 2
        : seat.offsetTop + seat.offsetHeight;
      // 注码越大飞的筹码越多，但封顶 —— 这是节奏音效不是礼花
      const n = Math.max(2, Math.min(5, Math.ceil(b.bet / 120)));
      for (let k = 0; k < n; k++) flyChip(sx, sy, ox, oy, k);
      flew += n;
    });
    if (flew) playCollect(Math.min(flew, 8));
  }

  /** 底池数字弹一拍：钱的进出要有反馈，不然只是另一个静态数字。
   *  重复触发同一段动画要先移除 class 再强制回流，否则第二次起不播。 */
  function bumpPot() {
    const box = el.pot.parentElement;   // #pot b 的父级 .pot
    if (!box) return;
    box.classList.remove('bump');
    void box.offsetWidth;
    box.classList.add('bump');
  }

  /* ---------- 音效（Web Audio 现场合成，不引外部音频文件） ----------
   * 浏览器要求音频上下文在用户手势之后才能发声，所以首次点击/按键时解锁一次。 */
  const MUTE_KEY = 'poker_mute';
  let actx = null;
  let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; } })();

  function audio() {
    if (muted) return null;
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { actx = new AC(); } catch (e) { return null; }
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function unlockAudio() {
    audio();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  }
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  /** 一声筹码碰撞：极短的带通噪声（塑料筹码的「嗒」） */
  function clink(ctx, t0, freq, gain) {
    const dur = 0.05;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.3;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(t0);
  }
  function tone(ctx, t0, freq, dur, type, gain) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /** 一把筹码被推给赢家：n 声错落的碰撞，收尾一声厚实的「落袋」 */
  function playAward(n) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.03;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.07 + Math.random() * 0.015;
      clink(ctx, t, 2400 + Math.random() * 1400, 0.13);
      tone(ctx, t, 1700 + Math.random() * 1000, 0.05, 'triangle', 0.045);
    }
    const end = t0 + n * 0.07 + 0.06;
    tone(ctx, end, 523, 0.2, 'sine', 0.1);
    tone(ctx, end + 0.08, 784, 0.24, 'sine', 0.08);
  }

  /** 轮到我了：两声短促上行的「叮咚」。要轻 —— 牌桌上它会频繁出现，
   *  比结算音更常听到，响了大就成了噪音。 */
  function playTurnCue() {
    const ctx = audio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    tone(ctx, t, 660, 0.09, 'sine', 0.06);
    tone(ctx, t + 0.11, 880, 0.12, 'sine', 0.06);
  }

  /** 最后 5 秒的滴答：极短、比轮到提示音还轻 —— 一秒一次连续响，
   *  音量必须压到「催而不惊」。 */
  function playTick() {
    const ctx = audio();
    if (!ctx) return;
    tone(ctx, ctx.currentTime + 0.01, 1250, 0.035, 'square', 0.045);
  }

  /** 对手下注/加注/全下：一声轻筹码碰撞。归池音的 2/3 音量 ——
   *  它只服务「有人往池里推钱了」的警觉，不是主角。 */
  function playBetSound() {
    const ctx = audio();
    if (!ctx) return;
    clink(ctx, ctx.currentTime + 0.02, 2300 + Math.random() * 900, 0.06);
  }

  /** 筹码归池：几声清脆的碰撞。比结算音轻、比结算音密 ——
   *  一条街它至少响一次，太响就成了背景噪音。 */
  function playCollect(n) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.03;
    for (let i = 0; i < n; i++) {
      clink(ctx, t0 + i * 0.05 + Math.random() * 0.012, 2200 + Math.random() * 1200, 0.09);
    }
  }

  /** 翻开新的一条街 / 发一手新底牌：一声短促的「唰」。
   *  带通噪声快速衰减 —— 纸牌落在毛毡上的那个声音。 */
  function playStreetSound() {
    const ctx = audio();
    if (!ctx) return;
    const dur = 0.16;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 1400; bp.Q.value = 0.9;
    const g = ctx.createGain(); g.gain.value = 0.12;
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(ctx.currentTime + 0.02);
  }

  function syncSoundBtn() {
    if (el.btnSound) el.btnSound.textContent = muted ? '音效 关' : '音效 开';
  }

  function renderLog(list) {
    el.log.innerHTML = list.map(l =>
      // class 必须加 ln- 前缀：裸用 kind 会撞上同名的全局样式
      // （发牌日志 kind='board' 会命中 .board 的绝对定位规则，飘到页面正中间）
      '<div class="ln' + (l.kind ? ' ln-' + UI.esc(l.kind) : '') + '">' +
      UI.esc(l.text) + '</div>').join('');
    el.log.scrollTop = el.log.scrollHeight;
  }

  function renderChat(list) {
    el.chat.innerHTML = (list || []).map(c =>
      '<div class="chat-line"><b>' + UI.esc(c.from) + '</b>' + UI.esc(c.text) + '</div>').join('')
      || '<div class="empty">还没有人说话</div>';
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  /* ---------- 操作条 ---------- */
  function renderActions() {
    const act = state.table.you.act;
    if (!act) {
      [el.btnFold, el.btnCall, el.btnRaise, el.btnAllin].forEach(b => b.disabled = true);
      el.slider.disabled = true;
      [].forEach.call(el.quick.querySelectorAll('button'), b => b.disabled = true);
      el.timer.hidden = true;
      el.timer.className = 'timer';
      clearInterval(timerId); timerId = null;
      // 预选按钮：在座、在牌里、没弃牌没全下、牌局进行中才出现 ——
      // 其余状态（旁观/等待开局/已弃牌/全下后看跑马）勾了也没有意义
      const t0 = state.table;
      const me = state.table.you.seat >= 0 ? t0.seats[state.table.you.seat] : null;
      const showPre = state.room.status === 'playing' && me && me.inHand && !me.folded && !me.allIn;
      if (el.preActions) el.preActions.hidden = !showPre;
      const t = state.table;
      if (state.room.status !== 'playing') el.prompt.textContent = '牌局未开始';
      // 桌上筹码打光：引擎不会给 0 筹码的人发牌（下一手自动观战），
      // 必须把「为什么没我的牌」说破，并指到唯一的出路（顶栏「补给」）；
      // 账号也见底时补给同样无门 —— 领取只在大厅，指路要指到底。
      else if (state.table.you.seat >= 0 && (state.table.you.tableChips || 0) <= 0) {
        const acc = state.table.you.account || 0;
        el.prompt.innerHTML = acc >= 100
          ? '你的筹码已打光 · 点顶栏 <b class="need-call">补给</b> 后从下一手继续'
          : '你的筹码已打光 · 请<b class="need-call">返回大厅</b>领取筹码后再回桌补给';
      }
      else if (t.currentIdx >= 0) {
        const p = t.seats[t.currentIdx];
        el.prompt.innerHTML = '等待 <b>' + UI.esc(p ? p.name : '') + '</b> 行动…';
      }
      // 上桌大盲预告：坐下时系统日志说过一次，但那是一闪而过的滚动条 ——
      // 行动条这里常驻一行，玩家点「坐下」到真正发牌之间随时能看到要交多少
      else if (state.table.you.mustPostBB) {
        el.prompt.innerHTML = '你已上桌 · <b class="need-call">下一手需上桌大盲</b>（座位徽章会标记金额）';
      } else if (state.result) {
        // 结算展示期：上一手的结论摆在横幅里，这里预告的是节奏。
        // 以前这行写「等待发牌…」，和阶段标签「摊牌 · 第 N 手」自相矛盾。
        el.prompt.textContent = '下一手即将开始…';
      } else el.prompt.textContent = '等待发牌…';
      return;
    }
    if (el.preActions) el.preActions.hidden = true;   // 行动中不显示预选（已用不上）
    const L = act.legal, you = state.table.you;
    el.btnFold.disabled = false;
    el.btnCall.disabled = false;
    el.btnAllin.disabled = !(you.tableChips > 0);
    // 文案写进 <span class="lbl">，不依赖 firstChild 是不是文本节点
    el.btnCall.querySelector('.lbl').textContent = L.toCall > 0
      ? (L.callAmount >= you.tableChips ? '全下跟注 ' + L.callAmount : '跟注 ' + L.callAmount)
      : '过牌';

    const canRaise = L.canRaise && L.maxTotalBet > 0;
    el.slider.disabled = !canRaise;
    el.btnRaise.disabled = !canRaise;
    [].forEach.call(el.quick.querySelectorAll('button'), b => b.disabled = !canRaise);
    if (canRaise) {
      el.slider.min = L.minTotal; el.slider.max = L.maxTotalBet;
      el.slider.step = Math.max(1, Math.round(L.minTotal / 20));
      if (el.slider.value < L.minTotal || el.slider.value > L.maxTotalBet) el.slider.value = L.minTotal;
      updateRaiseLabel();
    } else {
      el.btnRaise.querySelector('.lbl').textContent = '加注';
    }
    // 行动提示只留决策必需（GG 同款做减法）：轮到你了 · 底池 · 需跟注/可过牌 · 赔率。
    // 「你的牌」挪到本人座位的徽章（renderSeats，位置与 GG 一致 —— 牌型属于座位，
    // 不属于行动条）；「我的筹码」座位卡与顶栏都有，行动条里是第三次重复。
    el.prompt.innerHTML = '<b>轮到你了</b> · 底池 <b>' + UI.fmt(L.pot) + '</b>' +
      (L.toCall > 0
        ? ' · 需跟注 <b class="need-call">' + L.toCall.toLocaleString() + '</b>' +
          // 需跟注是决策数字，保留精确值不走 UI.fmt（≥10K 会缩写成 x.xK，歧义不可接受）；
          // 底池只是规模感，缩写无妨
          ' · 赔率 <b class="odds">' + Math.round(L.toCall / (L.pot + L.toCall) * 100) + '%</b>'
        : ' · <b class="can-check">可以过牌</b>') +
      // 连续超时警告：第 2 次就开始喊（第 3 次就被请离了），颜色用红——是惩罚不是参考
      (you.timeoutStreak >= 1
        ? ' · <b style="color:var(--red)">已连续超时 ' + you.timeoutStreak +
          ' 次，再超时' + (you.timeoutStreak >= 2 ? '' : '两次') + '将被请离座位</b>'
        : '');
    startTimer();
  }

  function updateRaiseLabel() {
    const act = state.table.you.act; if (!act) return;
    const v = parseInt(el.slider.value, 10);
    el.btnRaise.querySelector('.lbl').textContent =
      (v >= act.legal.maxTotalBet ? '全下 ' + v : '加注到 ' + v);
  }

  function startTimer() {
    // 不限制超时的房间：没有可倒数的时限，计时条整个藏起来（按钮照常可用）
    if (!actionTimeout() || !(state.table.you.act && state.table.you.act.deadline)) {
      el.timer.hidden = true;
      el.timer.className = 'timer';
      return;
    }
    if (timerId) return;
    el.timer.hidden = false;
    let lastTickSec = -1;        // 上一次滴答响过的整秒（-1 = 还没进入 5 秒区）
    const tick = () => {
      const act = state && state.table.you ? state.table.you.act : null;
      if (!act) {
        // 提前完成行动：立刻收掉倒计时，不留残影
        clearInterval(timerId); timerId = null;
        el.timer.hidden = true;
        el.timer.className = 'timer';
        lastTickSec = -1;
        return;
      }
      const left = msLeft(act.deadline);
      // 整秒文字。归零时显示 0，不会出现负数
      const sec = secLeft(act.deadline);
      el.timerSec.textContent = sec;
      el.timerBar.style.width = Math.min(100, left / actionTimeout() * 100) + '%';
      // 颜色交给 CSS 的档位类，JS 不直接写颜色值，避免和样式表两处维护
      // t-critical：最后 5 秒档（滴答 + 脉冲），比 t-urgent（8 秒颜色档）更深一级
      el.timer.className = 'timer t-' + tierOf(act.deadline) + (sec <= 5 ? ' t-critical' : '');
      // 最后 5 秒：每个整秒跳变滴答一声（同秒只响一次），催的是将要被
      // 超时处置的本人 —— 超时自动弃牌是最委屈的输法，宁可吵一点。
      // 只挂在 startTimer（本人倒计时）里，对手的座位倒计时不会响。
      if (sec <= 5 && sec !== lastTickSec) { lastTickSec = sec; playTick(); }
    };
    tick();                      // 立即画一帧，避免头 200ms 是空的
    timerId = setInterval(tick, 200);
  }

  function submit(action) {
    if (!state || !state.table.you.act) return;
    Net.send({ type: 'action', action });
  }
  function quickTarget(frac) {
    const L = state.table.you.act.legal;
    const t = L.roundBet + Math.round(frac * (L.pot + L.toCall));
    return Math.min(L.maxTotalBet, Math.max(L.minTotal, t));
  }

  el.btnFold.onclick = () => submit({ type: 'fold' });
  el.btnCall.onclick = () => submit({ type: 'call' });
  el.btnAllin.onclick = () => submit({ type: 'allin' });
  el.btnRaise.onclick = () => submit({ type: 'raise', total: parseInt(el.slider.value, 10) });
  el.slider.oninput = updateRaiseLabel;
  /* 快捷注额（1/2 池等）只把滑杆**拨到目标额**，不直接下注 ——
   * 以前是点一下就把钱推进池，误触一下「1 池」就等于白送一个底池；
   * 而且三个按钮紧挨着滑杆，手机上误触概率不低。
   * 改成拨杆 + 更新加注按钮文案，确认永远走「加注」那一下（或 R/Enter）。
   * 这是主流客户端（PokerStars / GGPoker）的标准做法：快捷键设额，确认键出牌。 */
  el.quick.onclick = e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !state.table.you.act) return;
    el.slider.value = quickTarget(parseFloat(b.dataset.frac));
    updateRaiseLabel();
  };
  document.addEventListener('keydown', e => {
    if (!state || !state.table.you.act) return;
    if (/input|textarea/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'f') submit({ type: 'fold' });
    else if (k === 'c' || k === 'k') submit({ type: 'call' });
    else if (k === 'r' || k === 'enter') { if (!el.btnRaise.disabled) submit({ type: 'raise', total: parseInt(el.slider.value, 10) }); }
    else if (k === 'a') submit({ type: 'allin' });
  });

  /* ---------- 预选动作的交互 ----------
   * 再点一次取消；换手/弃牌/全下时由状态接收侧清除（见 Net.on('state')）。 */
  el.preCF.onclick = () => togglePre('checkfold');
  el.preCA.onclick = () => togglePre('callany');
  function togglePre(k) {
    preAction = (preAction === k ? null : k);
    syncPreBtns();
  }
  function syncPreBtns() {
    if (!el.preCF) return;
    el.preCF.classList.toggle('on', preAction === 'checkfold');
    el.preCA.classList.toggle('on', preAction === 'callany');
  }

  /** 轮到我的一瞬间执行预选。在每次 state 渲染完之后调用：
   *  动作从「act 到达」到「提交」之间没有任何人工参与 —— 这正是预选的意义。
   *  checkfold = 能过牌就过、有人下注就弃；callany = 有注就跟、没注就过。
   *  执行一次即清除：连续多手自动弃牌/跟注比忘了取消更伤。 */
  function maybeAutoPre() {
    const you = state && state.table ? state.table.you : null;
    if (!you || !you.act || !preAction) return;
    const L = you.act.legal;
    let act;
    if (preAction === 'checkfold') act = L.canCheck ? { type: 'check' } : { type: 'fold' };
    else act = L.toCall > 0 ? { type: 'call' } : { type: 'check' };
    preAction = null;
    syncPreBtns();
    Net.send({ type: 'action', action: act });
    UI.toast('已按预选自动' +
      (act.type === 'fold' ? '弃牌' : (act.type === 'call' ? '跟注' : '过牌')));
  }

  /* ---------- 摊牌展示 ----------
   * 不再用结算浮层弹窗。摊牌时一切都摆在牌桌本身上：
   *   - 公共牌（5 张）在桌面正中依次翻开；
   *   - 未弃牌玩家的底牌由服务端下发、在各自座位上正面亮出（renderSeats 负责）；
   *   - 每位摊牌者座位上挂出牌型徽标（renderSeats 的 s.hand）；
   *   - 谁赢多少走牌局记录。
   * 服务端把这份「摊牌态」多保留一段时间（room.js 的 RESULT_SHOW_SHOWDOWN_MS），
   * 让所有人看清后再进入下一手。这里因此不需要任何浮层逻辑。 */

  /* ---------- 顶栏与聊天 ---------- */
  /* 侧栏开关：桌面（沉浸式布局）默认展开、位置由 localStorage 记忆；
   * 小屏仍是抽屉（默认收起，不记忆 —— 每次进来都干净）。 */
  const SIDE_KEY = 'poker_side';
  function wideScreen() { return window.innerWidth > 1000 && window.innerHeight > 600; }
  function savedOpen() {
    try { return localStorage.getItem(SIDE_KEY) !== '0'; } catch (e) { return true; }
  }
  (function initSide() {
    if (wideScreen() && savedOpen()) el.side.classList.add('open');
    // 跨视口档切换（拖窗口/旋转）时 open 状态会跨档残留 —— 桌面开着侧栏
    // 缩到矮屏，抽屉会保持打开，与矮屏「默认收起」相悖。跨档重置为该档默认，
    // 同档内的手动开关不受影响。
    let lastWide = wideScreen();
    window.addEventListener('resize', () => {
      const w = wideScreen();
      if (w !== lastWide) {
        lastWide = w;
        el.side.classList.toggle('open', w && savedOpen());
        scheduleFit();
      }
    });
  })();
  el.btnPanel.onclick = () => {
    el.side.classList.toggle('open');
    try { if (wideScreen()) localStorage.setItem(SIDE_KEY, el.side.classList.contains('open') ? '1' : '0'); } catch (e) {}
    scheduleFit();                      // 抽屉开合会改变 .table-fit 的宽度，重算缩放
  };
  el.btnLobby.onclick = () => {
    // 记一下「这个房间是我主动退回大厅的」，大厅就不会再把人拽回牌桌
    const id = state && state.room ? state.room.id : '';
    if (id) sessionStorage.setItem('poker_no_auto', id);
    location.href = 'lobby.html';
  };
  el.btnStand.onclick = () => Net.send({ type: 'stand' });
  // 房主开局/结束：服务端校验身份与人数，这里只管发
  if (el.btnStart) el.btnStart.onclick = () => Net.send({ type: 'start' });
  if (el.btnStop) el.btnStop.onclick = () => Net.send({ type: 'stop' });
  el.btnSound.onclick = () => {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* 隐私模式不记 */ }
    syncSoundBtn();
    if (!muted) { const c = audio(); if (c) tone(c, c.currentTime + 0.02, 880, 0.12, 'sine', 0.07); }
  };
  syncSoundBtn();

  /* 领取筹码只在大厅（规则收口：房内可领的话「桌上输光 → 秒补 → 继续推」
     没有休止符），牌桌页不再设入口；服务端也会拒绝房内的 claim。
     补给（把账号的钱加到桌上）不受影响，仍在本页。 */
  el.btnRebuy.onclick = () => {
    const acc = state.table.you.account;
    // 账号余额低于最低补给（100）时弹窗必然不可用（max = min(5000, acc) < min = 100，
    // 输什么都是矛盾值）。领取已收口到大厅，这里只指路不代办：
    // 「返回大厅 → 领取 2000 → 回桌补给」三步都得玩家自己走。
    if (acc < 100) {
      return UI.toast('账号余额不足 · 请点「返回大厅」领取筹码后再回桌补给', 'err');
    }
    UI.modal({
      title: '补给筹码', label: '补给到桌上（账号余额 ' + UI.fmt(acc) + '）',
      value: Math.min(state.room.buyIn, acc), min: 100, max: Math.min(5000, acc),
      okText: '补给', onOk: v => Net.send({ type: 'rebuy', amount: v })
    });
  };

  /* ---------- 点击空位坐下 ----------
   * 牌桌上的槽位是前端按「本人居中」重排后的虚拟位置，与服务端座位号不是一回事，
   * 所以不能拿槽位号去坐下；真实座位号由前端挑一个没人坐的即可 —— 坐下之后
   * 本人固定落在槽位 0（底边正中），坐在几号位对观感没有区别。 */
  el.seats.addEventListener('click', e => {
    if (e.target.closest('.seat.empty.can-sit')) trySit();
  });

  function trySit() {
    if (!state || !state.table) return;
    const t = state.table;
    if (t.you.seat >= 0) return UI.toast('你已经在座了');
    const acc = t.you.account || 0;
    if (acc <= 0) return UI.toast('账号余额不足 · 请点「返回大厅」，在大厅点「领取筹码」后再来', 'err');
    const free = (t.seats || []).find(s => !s.name);
    if (!free) return UI.toast('已经没有空位了', 'err');
    Net.send({ type: 'sit', seat: free.i, amount: Math.max(1, Math.min(state.room.buyIn, acc)) });
  }
  function sendChat() {
    const t = el.chatText.value.trim();
    if (!t) return;
    Net.send({ type: 'chat', text: t });
    el.chatText.value = '';
  }
  el.chatSend.onclick = sendChat;
  el.chatText.onkeydown = e => { if (e.key === 'Enter') sendChat(); };

  /* ---------- 画布缩放的更新时机 ----------
   * 几何已经是常量了，所以这里不需要再 render()（以前必须重排座位）——
   * 只需要重算一个 --tscale。用 rAF 合并同一帧里的多次触发：
   * 拖动窗口边缘会连续抛 resize，每次都同步读一次布局会掉帧。 */
  const raf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : f => setTimeout(f, 16);
  let fitPending = false;
  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    raf(() => { fitPending = false; fitCanvas(); });
  }
  window.addEventListener('resize', scheduleFit);
  // 转屏时视口尺寸更新得比事件晚，立刻算一次 + 延迟再算一次
  window.addEventListener('orientationchange', () => { scheduleFit(); setTimeout(scheduleFit, 320); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleFit);
  fitCanvas();                 // 首帧：不等任何事件，先把 --tscale 算准
})();
