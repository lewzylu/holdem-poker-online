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
    prompt: $('#prompt'),
    btnFold: $('#btn-fold'), btnCall: $('#btn-call'), btnRaise: $('#btn-raise'),
    btnAllin: $('#btn-allin'), slider: $('#raise-slider'), quick: $('#quick'),
    timer: $('#timer'), timerBar: $('#timer-bar'), timerSec: $('#timer-sec'),
    score: $('#score'), log: $('#log'), chat: $('#chat'),
    chatText: $('#chat-text'), chatSend: $('#chat-send'),
    result: $('#result')
  };

  let myName = null, state = null, timerId = null;
  const ACTION_TIMEOUT = 30000;

  /* ---------- 倒计时的共用规则 ----------
   * 「我的倒计时」和「对手座位状态」必须用同一套阈值，否则同一时刻我看到黄、
   * 对手座位显示红，两边标准不一致就没法互相参照了。
   * 阈值：> 11s 充裕 / 8~11s 提醒 / < 8s 紧急。
   */
  const TIER_WARN = 11000;
  const TIER_URGENT = 8000;

  /** 服务端下发的超时时长；拿不到就退回本地常量 */
  function actionTimeout() {
    const t = state && state.table ? state.table.actTimeout : 0;
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
   *  可用区域量不到（竖屏下 .table-fit 被隐藏、或 jsdom 没有布局引擎）时直接跳过，
   *  留着上一次的值比写入 0 安全。 */
  function fitCanvas() {
    if (!el.fit || !el.canvas) return;
    const r = el.fit.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = Math.min(r.width / CANVAS_W, r.height / CANVAS_H);
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
    state = s;
    // 换手 / 回到空闲：上一手的动作反馈必须清掉，否则会残留到下一手的牌桌上
    const curHand = s.table ? s.table.handCount : 0;
    const curPhase = s.table ? s.table.phase : '';
    if (curHand !== prevHand || (curPhase === 'idle' && prevPhase !== 'idle')) clearFlashes();
    trackActions();
    render();
  });

  /* ---------- 渲染 ---------- */
  let firstRender = true;
  function render() {
    if (!state) return;
    const room = state.room, t = state.table, you = t.you;
    el.roomTag.textContent = room.title + '（' + room.id + '）';
    el.blindTag.textContent = '盲注 ' + room.sb + '/' + room.bb;
    el.handTag.textContent = '第 ' + (room.handCount || 0) + ' 手';
    el.meChips.textContent = UI.fmt(you.account);
    el.meTable.textContent = '桌上 ' + UI.fmt(you.tableChips || 0);
    // 阶段/手数、房间号/盲注都放在牌桌内部标签里：手机横屏会隐藏顶栏信息条，这里必须自给自足
    el.phase.textContent = (room.status === 'playing' ? (t.phaseName || '准备') : '等待开局') +
      (t.handCount ? ' · 第 ' + t.handCount + ' 手' : '');
    el.pot.textContent = UI.fmt(t.pot);
    el.blind.textContent = room.id + ' · 盲注 ' + room.sb + '/' + room.bb;
    el.waiting.hidden = room.status === 'playing';
    el.btnStand.disabled = you.seat < 0;
    el.btnRebuy.disabled = you.seat < 0;

    renderBoard();
    renderSeats();
    renderScore();
    renderLog(state.logs || []);
    renderChat(state.chat || []);
    renderActions();
    renderResult(state.result);
    // 首帧渲染完再补一次：脚本执行时侧栏/操作条可能还没定下最终高度
    if (firstRender) { firstRender = false; scheduleFit(); }
  }

  /** 公共牌：只渲染已经发出的牌。以前会补 5 个半透明空占位，视觉上很脏，
   *  而且「还剩几张没发」这个信息玩家心里有数，不需要画出来。 */
  function renderBoard() {
    const b = state.table.board || [];
    el.board.innerHTML = b.map(c => UI.cardHTML(c, '')).join('');
    el.board.classList.toggle('has-cards', b.length > 0);
    el.board.style.setProperty('--board-n', b.length);
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
        const secNode = node.querySelector('.seat-sec');
        if (secNode) secNode.textContent = secLeft(t.actDeadline);
        alive = true;
      } else if (node.dataset.tier) {
        node.classList.remove('t-ok', 't-warn', 't-urgent');
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

    let html = '';
    for (let k = 0; k < SLOT_COUNT; k++) {
      const s = bySlot[k];
      const p = seatPos(k);
      const posStyle = 'style="left:' + p.left + '%;top:' + p.top + '%"';

      // ---- 空槽位：占位形态，不含任何玩家信息，也不绑定交互 ----
      if (!s) {
        html += '<div class="seat empty' + (p.flip ? ' flip' : '') + '" ' +
          'data-slot="' + k + '" ' + posStyle + '>' +
          '<div class="info"><span class="empty-tag">空位</span></div>' +
          '</div>';
        continue;
      }

      const mine = s.name === myName;
      const isTurn = t.currentIdx === s.i;
      // 两张底牌必须包进 .hole 才会横向并排。
      // 尺寸对所有人统一（都是 .card.small）：本人与对手的区分只靠牌面朝向，
      // 不靠大小 —— 以前自己的牌是对手的两倍，看起来像渲染坏了。
      // .hole 是卡片上方的绝对定位浮层，不参与座位卡布局：
      // 空位/未发牌/弃牌时它整块消失，若参与布局座位就会忽高忽低。
      let cards = '';
      if (s.inHand) {
        cards = '<div class="hole">' + (s.hole
          ? s.hole.map(c => UI.cardHTML(c, 'small')).join('')
          : '<div class="card small back"></div><div class="card small back"></div>') + '</div>';
      }
      let badges = '';
      if (t.buttonIdx === s.i) badges += '<span class="badge dealer">D</span>';
      if (t.sbIdx === s.i) badges += '<span class="badge sb">小盲</span>';
      if (t.bbIdx === s.i) badges += '<span class="badge bb">大盲</span>';
      if (s.allIn) badges += '<span class="badge allin">ALL IN</span>';
      if (!s.connected) badges += '<span class="badge hand">掉线</span>';
      if (s.hand) badges += '<span class="badge hand">' + UI.esc(s.hand) + '</span>';
      const status = isTurn
        ? '<div class="thinking">' + (s.connected ? '行动中…' : '掉线等待') + '</div>'
        : (s.lastAction ? '<div class="last">' + UI.esc(s.lastAction) + '</div>' : '');

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

      html += '<div class="seat' + (p.flip ? ' flip' : '') + (s.folded ? ' folded' : '') +
        (isTurn ? ' turn' : '') + (s.chips <= 0 ? ' out' : '') + (mine ? ' mine' : '') +
        (isActing ? ' acting t-' + tier : '') + '" ' +
        'data-seat="' + s.i + '" data-slot="' + k + '"' +
        (isActing ? ' data-tier="' + tier + '"' : '') + ' ' + posStyle + '>' +
        cards +
        '<div class="info">' +
          '<div class="avatar">' + UI.esc(s.name.slice(0, 1)) + '</div>' +
          '<div class="nm">' + UI.esc(s.name) + (mine ? '（我）' : '') + '</div>' +
          '<div class="chips">' + UI.fmt(s.chips) + '</div>' +
        '</div>' +
        (badges ? '<div class="sub">' + badges + '</div>' : '') +
        secTag +
        status +
        flash +
        (s.bet > 0 ? '<div class="bet">' + s.bet + '</div>' : '') +
        '</div>';
    }
    el.seats.innerHTML = html;

    if (flashes.size || (t.actSeat >= 0 && t.actDeadline)) startSeatTick();
  }

  function renderScore() {
    const t = state.table;
    let html = '<tr><th>座位</th><th style="text-align:right">桌上</th><th style="text-align:right">本轮</th></tr>';
    t.seats.filter(s => s.name).forEach(s => {
      html += '<tr class="' + (s.chips <= 0 ? 'out' : '') + '">' +
        '<td>' + UI.esc(s.name) + (s.name === myName ? '（我）' : '') + '</td>' +
        '<td style="text-align:right">' + UI.fmt(s.chips) + '</td>' +
        '<td style="text-align:right">' + (s.bet || '—') + '</td></tr>';
    });
    el.score.innerHTML = html;
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
      const t = state.table;
      if (state.room.status !== 'playing') el.prompt.textContent = '牌局未开始';
      else if (t.currentIdx >= 0) {
        const p = t.seats[t.currentIdx];
        el.prompt.innerHTML = '等待 <b>' + UI.esc(p ? p.name : '') + '</b> 行动…';
      } else el.prompt.textContent = '等待发牌…';
      return;
    }
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
    el.prompt.innerHTML = '<b>轮到你了</b> · 底池 <b>' + L.pot + '</b>' +
      (L.toCall > 0 ? ' · 需跟注 <b>' + L.toCall + '</b>' : ' · 可以过牌');
    startTimer();
  }

  function updateRaiseLabel() {
    const act = state.table.you.act; if (!act) return;
    const v = parseInt(el.slider.value, 10);
    el.btnRaise.querySelector('.lbl').textContent =
      (v >= act.legal.maxTotalBet ? '全下 ' + v : '加注到 ' + v);
  }

  function startTimer() {
    if (timerId) return;
    el.timer.hidden = false;
    const tick = () => {
      const act = state && state.table.you ? state.table.you.act : null;
      if (!act) {
        // 提前完成行动：立刻收掉倒计时，不留残影
        clearInterval(timerId); timerId = null;
        el.timer.hidden = true;
        el.timer.className = 'timer';
        return;
      }
      const left = msLeft(act.deadline);
      // 整秒文字。归零时显示 0，不会出现负数
      el.timerSec.textContent = secLeft(act.deadline);
      el.timerBar.style.width = Math.min(100, left / actionTimeout() * 100) + '%';
      // 颜色交给 CSS 的档位类，JS 不直接写颜色值，避免和样式表两处维护
      el.timer.className = 'timer t-' + tierOf(act.deadline);
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
  el.quick.onclick = e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !state.table.you.act) return;
    submit({ type: 'raise', total: quickTarget(parseFloat(b.dataset.frac)) });
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

  /* ---------- 结算浮层 ---------- */
  function renderResult(r) {
    if (!r) { el.result.hidden = true; return; }
    const board = (r.board || []).map(c => UI.cardHTML(c, 'mini')).join('');
    const rows = (r.revealed || []).map(p =>
      '<div class="res-row ' + (p.won > 0 ? 'iswin' : '') + '">' +
      '<div class="rname">' + UI.esc(p.name) + '</div>' +
      '<div class="rcards">' + (p.hole || []).map(c => UI.cardHTML(c, 'mini')).join('') + '</div>' +
      '<div class="rhand">' + (p.hand ? UI.esc(p.hand.name) : '') + '</div>' +
      (p.won > 0 ? '<div class="rwon">+' + UI.fmt(p.won) + '</div>' : '<div class="rlost">—</div>') +
      '</div>').join('');
    el.result.innerHTML =
      '<h4>第 ' + r.hand + ' 手 · ' + (r.reason === 'showdown' ? '摊牌' : '其余人弃牌') + '</h4>' +
      '<div class="result-board">' + board + '</div>' + rows;
    el.result.hidden = false;
  }

  /* ---------- 顶栏与聊天 ---------- */
  el.btnPanel.onclick = () => {
    el.side.classList.toggle('open');   // 小屏侧栏抽屉
    scheduleFit();                      // 抽屉开合会改变 .table-fit 的宽度，重算缩放
  };
  el.btnLobby.onclick = () => {
    // 记一下「这个房间是我主动退回大厅的」，大厅就不会再把人拽回牌桌
    const id = state && state.room ? state.room.id : '';
    if (id) sessionStorage.setItem('poker_no_auto', id);
    location.href = 'lobby.html';
  };
  el.btnStand.onclick = () => Net.send({ type: 'stand' });
  el.btnRebuy.onclick = () => {
    const acc = state.table.you.account;
    UI.modal({
      title: '补给筹码', label: '补给到桌上（账号余额 ' + UI.fmt(acc) + '）',
      value: Math.min(state.room.buyIn, acc), min: 100, max: Math.min(5000, acc),
      okText: '补给', onOk: v => Net.send({ type: 'rebuy', amount: v })
    });
  };
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
