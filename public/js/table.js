/* table.js —— 联机牌桌：只渲染服务端下发的视图，底牌只有本人能看到 */
(function () {
  const $ = s => document.querySelector(s);
  const el = {
    roomTag: $('#room-tag'), blindTag: $('#blind-tag2'), handTag: $('#hand-tag'),
    meName: $('#me-name2'), meChips: $('#me-chips2'), meTable: $('#me-table'),
    btnRebuy: $('#btn-rebuy'), btnStand: $('#btn-stand'), btnLobby: $('#btn-lobby'),
    btnPanel: $('#btn-panel'), side: $('.side'), felt: $('.felt'),
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

  // 自己固定在这个角度：PI*0.75 = 135°，即椭圆左下方
  const MY_ANGLE = Math.PI * 0.75;

  /** 按牌桌实际宽高比算椭圆半径：桌子越扁（手机横屏）纵向半径越小，避免座位溢出桌面 */
  function ellipseGeo(n) {
    const r = el.felt ? el.felt.getBoundingClientRect() : { width: 0, height: 0 };
    // 座位是相对 .felt 的 padding box 用百分比定位的，但 getBoundingClientRect 返回的是
    // 含木边框的 border-box 尺寸。直接用会把可用间距高估约 7%（12px 边框 ÷ 366px），
    // 算出来的座位就偏大、邻座会互相压住。这里减掉边框，拿到真正可用的内容区尺寸。
    let bw = 0, bh = 0;
    if (el.felt) {
      const cs = getComputedStyle(el.felt);
      bw = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      bh = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    }
    const w = Math.max(0, r.width - bw), h = Math.max(0, r.height - bh);
    const ratio = (w > 0 && h > 0) ? w / h : 1.7;
    // 人越多，椭圆越贴近上下边缘，给座位腾出纵向空间
    const crowd = n >= 7 ? 1.3 : (n >= 5 ? 1.15 : 1);
    const ry = Math.max(26, Math.min(46, 56 / Math.max(ratio, 1) * crowd));
    // 竖屏（牌桌偏高）时横向半径要收，否则两侧座位会顶出屏幕
    const rx = ratio < 1.2
      ? Math.min(38, Math.max(32, ry * 0.9))
      : Math.min(46, Math.max(38, ry * 1.35));
    return { rx: rx, ry: ry, ratio: ratio, w: w, h: h };
  }

  /** 座位宽度：遍历椭圆上每一对相邻座位，取能同时满足「水平或垂直至少一个方向分离」的最大宽度。
   *  座位是矩形，判定不重叠的条件是 dx >= W 或 dy >= H（H = hRatio × W），所以对每对座位：
   *  W 不能超过 max(dx, dy / hRatio)。
   *  人多时牌与头像并排（见 .crowded），座位高度只有宽度的 ~0.6 倍，于是同样间距能显示更大的牌。 */
  function seatWidth(n, geo) {
    if (!geo.w || !geo.h) return 118;
    const rxPx = geo.rx / 100 * geo.w, ryPx = geo.ry / 100 * geo.h;
    // 座位实测高宽比：自己的座位（纵向堆叠）≈1.35；
    // 对手座位（横排一行：牌背+头像+昵称+筹码）≈0.38。
    // 9 人桌只有 1 个 mine + 8 个对手，加权平均后取 0.50 已足够安全，
    // 比以前的 0.6（crowded）或 1.35（常规）能算出更大更清晰的座位。
    const hRatio = n >= 7 ? 0.42 : (n >= 5 ? 0.48 : 0.55);
    const step = 2 * Math.PI / Math.max(n, 2);
    let best = Infinity;
    for (let k = 0; k < Math.max(n, 2); k++) {
      // 必须按实际使用的角度（从 MY_ANGLE 递减）来算，否则间距会算偏
      const t1 = MY_ANGLE - k * step, t2 = MY_ANGLE - (k + 1) * step;
      const dx = Math.abs(rxPx * (Math.cos(t1) - Math.cos(t2)));
      const dy = Math.abs(ryPx * (Math.sin(t1) - Math.sin(t2)));
      best = Math.min(best, Math.max(dx, dy / hRatio));
    }
    const cap = window.innerHeight <= 430 ? 76 : (window.innerHeight <= 600 ? 88 : 118);
    return Math.round(Math.max(34, Math.min(cap, best - 4)));
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
      const i = parseInt(node.dataset.seat, 10);

      // 当前行动者：按剩余时间递进档位（与本人倒计时同一套阈值）
      if (t.actSeat === i && t.actDeadline) {
        const tier = tierOf(t.actDeadline);
        if (node.dataset.tier !== tier) {
          node.classList.remove('t-ok', 't-warn', 't-urgent');
          node.classList.add('t-' + tier);
          node.dataset.tier = tier;
        }
        // 少人局时把秒数也显示出来；满桌交给颜色，避免挤爆座位
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
    const players = t.seats.filter(s => s.name);
    // 以「我」为起点重排：自己永远固定在左下方，其余人按顺序环绕，
    // 这样看牌位置固定，手机横屏也能形成肌肉记忆。
    let ordered = players;
    const mi = players.findIndex(s => s.name === myName);
    if (mi > 0) ordered = players.slice(mi).concat(players.slice(0, mi));

    const n = Math.max(ordered.length, 2);
    const geo = ellipseGeo(n);
    el.seats.style.setProperty('--seat-w', seatWidth(n, geo) + 'px');
    // 满桌时精简其他人的信息（昵称/上轮动作），把纵向空间让出来。
    // 反馈的降级也挂在这个类上：决定空间的是人数，不是屏幕尺寸 ——
    // 同一块屏幕 2 人和 9 人的余量差好几倍。
    const crowded = ordered.length >= 7;
    el.seats.classList.toggle('crowded', crowded);
    el.seats.innerHTML = ordered.map((s, k) => {
      const a = MY_ANGLE - k * (2 * Math.PI / n);   // 自己在 MY_ANGLE（左下），其余顺时针排开
      const flip = Math.sin(a) < -0.05;
      const mine = s.name === myName;
      const isTurn = t.currentIdx === s.i;
      // 两张底牌必须包进 .hole 才会横向并排：.seat 本身是纵向 flex，
      // 直接把两张 .card 塞进去会变成上下堆叠。
      let cards = '';
      if (s.inHand) {
        cards = '<div class="hole">' + (s.hole
          // 自己的牌用大一号，方便在手机上快速看牌
          ? s.hole.map(c => UI.cardHTML(c, mine ? 'my' : 'small')).join('')
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

      // 行动中的人：座位上挂一个倒计时秒数（满桌由 CSS 隐掉，只留颜色与脉冲）
      const isActing = t.actSeat === s.i && !!t.actDeadline;
      const tier = isActing ? tierOf(t.actDeadline) : '';
      const secTag = isActing
        ? '<div class="seat-sec">' + secLeft(t.actDeadline) + '</div>'
        : '';

      // 动作反馈浮层：absolute + pointer-events:none，完全不参与布局。
      // 座位宽度是按「相邻座位不重叠」反推出来的，任何参与布局的新元素都会破坏它。
      const f = flashOf(s.i);
      const flash = f
        ? '<div class="act-flash' + (f.byTimeout ? ' by-timeout' : '') + '">' +
            (f.byTimeout ? '<i class="to-tag">超时</i>' : '') +
            '<span class="af-text">' + UI.esc(f.text) + '</span>' +
          '</div>'
        : '';

      return '<div class="seat' + (flip ? ' flip' : '') + (s.folded ? ' folded' : '') +
        (isTurn ? ' turn' : '') + (s.chips <= 0 ? ' out' : '') + (mine ? ' mine' : '') +
        (isActing ? ' acting t-' + tier : '') + '" ' +
        'data-seat="' + s.i + '"' + (isActing ? ' data-tier="' + tier + '"' : '') + ' ' +
        'style="left:' + (50 + geo.rx * Math.cos(a)) + '%;top:' + (50 + geo.ry * Math.sin(a)) + '%">' +
        flash +
        cards +
        '<div class="avatar">' + UI.esc(s.name.slice(0, 1)) + '</div>' +
        '<div class="nm">' + UI.esc(s.name) + (mine ? '（我）' : '') + '</div>' +
        '<div class="chips">' + UI.fmt(s.chips) + '</div>' +
        (badges ? '<div class="sub">' + badges + '</div>' : '') +
        secTag +
        status +
        (s.bet > 0 ? '<div class="bet">' + s.bet + '</div>' : '') +
        '</div>';
    }).join('');

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
  el.btnPanel.onclick = () => el.side.classList.toggle('open');   // 小屏侧栏抽屉
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

  /* 横竖屏切换 / 窗口缩放：椭圆半径是按实测宽高比算的，必须重排座位 */
  let rzTimer = null;
  function onResize() {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => { if (state) render(); }, 120);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 320));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
})();
