/* lobby.js —— 大厅：房间列表、开房/加入、座位与买入、聊天 */
(function () {
  const $ = s => document.querySelector(s);
  const el = {
    meName: $('#me-name'), meChips: $('#me-chips'), logout: $('#btn-logout'), connTip: $('#conn-tip'),
    list: $('#room-list'), refresh: $('#refresh'),
    cTitle: $('#c-title'), cSb: $('#c-sb'), cBb: $('#c-bb'), cBuy: $('#c-buyin'),
    create: $('#create'), joinId: $('#join-id'), join: $('#join'),
    roomTitle: $('#room-title'), roomMeta: $('#room-meta'),
    seats: $('#seats'), ops: $('#room-ops'),
    chat: $('#chat'), chatText: $('#chat-text'), chatSend: $('#chat-send')
  };

  let myName = null, state = null, roomList = [];

  /* ---------- 身份 ----------
   * 千万不能在页面加载时同步判断 Net.isAuthed：那时 WebSocket 还在握手，
   * user 必然是 null，会被误判成未登录 → 跳 index → index 续期成功又跳回来 → 无限循环。
   * 必须等服务端明确回复（me / needLogin）再决定去留。
   */
  function goLogin() { location.href = 'index.html'; }

  Net.on('conn', s => {
    if (s === 'online') Net.send({ type: 'me' });
    if (el.connTip) el.connTip.textContent = s === 'online' ? '' : (s === 'offline' ? '服务器断开，重连中…' : '连接中…');
  });
  Net.on('me', m => {
    if (!m.user) return goLogin();
    myName = m.user.name;
    el.meName.textContent = myName;
    el.meChips.textContent = UI.fmt(m.user.chips);
    Net.send({ type: 'listRooms' });
  });
  Net.on('needLogin', goLogin);          // 无 token 或续期失败
  Net.on('auth', m => { if (!m.ok) goLogin(); });
  Net.on('joined', () => sessionStorage.removeItem('poker_no_auto'));  // 重新进房允许自动进桌
  el.logout.onclick = () => Net.logout();

  /* ---------- 房间列表 ---------- */
  Net.on('rooms', m => { roomList = m.rooms || []; renderList(); });
  el.refresh.onclick = () => Net.send({ type: 'listRooms' });
  setInterval(() => { if (Net.conn === 'online') Net.send({ type: 'listRooms' }); }, 5000);

  function renderList() {
    if (!roomList.length) {
      el.list.innerHTML = '<div class="empty">暂时没有房间，右边开一个吧</div>';
      return;
    }
    el.list.innerHTML = roomList.map(r =>
      '<div class="room-item" data-id="' + r.id + '">' +
      '<div class="ri-main"><b>' + UI.esc(r.title || '牌局') + '</b>' +
      '<span class="rid">' + r.id + '</span></div>' +
      '<div class="ri-sub">盲注 ' + r.sb + '/' + r.bb +
      ' · ' + r.seated + ' 人入座 · ' + r.people + ' 人在房间' +
      (r.status === 'playing' ? ' · <i class="live">进行中</i>' : '') + '</div>' +
      '</div>').join('');
  }
  el.list.onclick = e => {
    const it = e.target.closest('.room-item');
    if (it) Net.send({ type: 'joinRoom', roomId: it.dataset.id });
  };

  el.create.onclick = () => {
    Net.send({
      type: 'createRoom',
      title: el.cTitle.value.trim(),
      sb: el.cSb.value, bb: el.cBb.value, buyIn: el.cBuy.value
    });
  };
  el.join.onclick = () => {
    const id = el.joinId.value.trim().toUpperCase();
    if (!id) return UI.toast('请输入房间号');
    Net.send({ type: 'joinRoom', roomId: id });
  };
  el.joinId.onkeydown = e => { if (e.key === 'Enter') el.join.click(); };

  /* ---------- 当前房间 ---------- */
  Net.on('state', s => { state = s; renderRoom(); });
  Net.on('left', () => { state = null; renderRoom(); });
  Net.on('error', m => UI.toast(m.msg || '操作失败', 'err'));
  Net.on('notice', m => UI.toast(m.msg));

  function renderRoom() {
    if (!state || !state.room) {
      el.roomTitle.textContent = '未加入房间';
      el.roomMeta.textContent = '';
      el.seats.innerHTML = '<div class="empty">从左边选一个房间，或者自己开一个</div>';
      el.ops.innerHTML = '';
      return;
    }
    const room = state.room, table = state.table, you = table.you;
    el.roomTitle.textContent = room.title + '（' + room.id + '）';
    el.roomMeta.innerHTML =
      '房主 <b>' + UI.esc(room.host || '—') + '</b> · 盲注 <b>' + room.sb + '/' + room.bb + '</b>' +
      ' · 状态 <b>' + (room.status === 'playing' ? '进行中 第' + room.handCount + '手' : '等待开始') + '</b>' +
      ' · 在线 ' + room.members.filter(m => m.online).length + '/' + room.members.length;

    el.seats.innerHTML = table.seats.map(s => {
      const mine = s.name && s.name === myName;
      const cls = ['lseat', s.name ? 'taken' : 'free', mine ? 'mine' : ''].join(' ');
      return '<div class="' + cls + '" data-seat="' + s.i + '">' +
        '<div class="ls-no">' + (s.i + 1) + '</div>' +
        '<div class="ls-name">' + (s.name ? UI.esc(s.name) + (s.connected ? '' : ' <i>掉线</i>') : '空位') + '</div>' +
        '<div class="ls-chips">' + (s.name ? UI.fmt(s.chips) : '—') + '</div>' +
        '</div>';
    }).join('');

    const seated = you.seat >= 0;
    const isHost = room.host === myName;
    let ops = '';
    if (isHost) {
      ops += room.status === 'playing'
        ? '<button class="ghost" data-op="stop">结束牌局</button>'
        : '<button class="primary" data-op="start">开始牌局</button>';
    }
    if (seated) {
      ops += '<button class="ghost" data-op="stand">站起结算</button>';
      ops += '<button class="ghost" data-op="rebuy">补给筹码</button>';
    }
    ops += '<button class="ghost" data-op="table">进入牌桌</button>';
    ops += '<button class="ghost danger" data-op="leave">离开房间</button>';
    el.ops.innerHTML = ops;

    renderChat(state.chat || []);
    // 开局后自动进桌；但用户主动点过「返回大厅」后就别再把他拽回去
    if (room.status === 'playing' && sessionStorage.getItem('poker_no_auto') !== room.id) {
      location.href = 'table.html';
    }
  }

  el.seats.onclick = e => {
    const d = e.target.closest('.lseat');
    if (!d || !state) return;
    const seat = parseInt(d.dataset.seat, 10);
    const s = state.table.seats[seat];
    if (s.name === myName) return doOp('stand');
    if (s.name) return;
    const acc = state.table.you.account;
    UI.modal({
      title: '坐下 · ' + (seat + 1) + ' 号位',
      label: '买入筹码（账号余额 ' + UI.fmt(acc) + '）',
      value: Math.min(state.room.buyIn, acc),
      min: 100, max: Math.min(5000, acc),
      tip: '上限 ' + UI.fmt(Math.min(5000, acc)) + '，最低 100',
      okText: '坐下',
      onOk: v => Net.send({ type: 'sit', seat, amount: v })
    });
  };

  el.ops.onclick = e => {
    const b = e.target.closest('[data-op]');
    if (b) doOp(b.dataset.op);
  };

  function doOp(op) {
    if (op === 'table') return location.href = 'table.html';
    if (op === 'leave') return Net.send({ type: 'leaveRoom' });
    if (op === 'start') return Net.send({ type: 'start' });
    if (op === 'stop') return Net.send({ type: 'stop' });
    if (op === 'stand') return Net.send({ type: 'stand' });
    if (op === 'rebuy') {
      const acc = state.table.you.account;
      return UI.modal({
        title: '补给筹码', label: '补给到桌上（账号余额 ' + UI.fmt(acc) + '）',
        value: Math.min(state.room.buyIn, acc), min: 100, max: Math.min(5000, acc),
        okText: '补给', onOk: v => Net.send({ type: 'rebuy', amount: v })
      });
    }
  }

  /* ---------- 聊天 ---------- */
  function renderChat(list) {
    el.chat.innerHTML = (list || []).map(c =>
      '<div class="chat-line"><b>' + UI.esc(c.from) + '</b>' + UI.esc(c.text) + '</div>').join('')
      || '<div class="empty">还没有人说话</div>';
    el.chat.scrollTop = el.chat.scrollHeight;
  }
  function sendChat() {
    const t = el.chatText.value.trim();
    if (!t) return;
    Net.send({ type: 'chat', text: t });
    el.chatText.value = '';
  }
  el.chatSend.onclick = sendChat;
  el.chatText.onkeydown = e => { if (e.key === 'Enter') sendChat(); };

})();
