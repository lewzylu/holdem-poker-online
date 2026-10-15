/* lobby.js —— 大厅：房间列表、开房/加入、聊天。
 * 大厅不承载任何牌局内操作（选座/买入/补给都在牌桌页，房主开局也在牌桌页），
 * 只负责「看房间 → 进房间」：点房间卡 = 加入 = 直接跳牌桌。 */
(function () {
  const $ = s => document.querySelector(s);
  const el = {
    meName: $('#me-name'), meChips: $('#me-chips'), logout: $('#btn-logout'), connTip: $('#conn-tip'),
    claim: $('#btn-claim'),
    list: $('#room-list'), refresh: $('#refresh'),
    cTitle: $('#c-title'), cSb: $('#c-sb'), cBb: $('#c-bb'), cBuy: $('#c-buyin'),
    create: $('#create'), joinId: $('#join-id'), join: $('#join'),
    roomTitle: $('#room-title'), roomMeta: $('#room-meta'),
    ops: $('#room-ops'),
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
    syncClaim();
    Net.send({ type: 'listRooms' });
  });

  /* 领取筹码：随时可领，单次 2000 —— 不设门槛（置灰在手机上没有 hover 提示，
     「为什么点不了」的困惑比无限领取的副作用更伤体验）。
     服务端是权威（房内拒绝、金额），这里只管亮着。
     领取只发生在大厅 —— 房间内服务端会直接拒绝（规则收口）。 */
  function syncClaim(chips) {
    el.claim.disabled = false;
    el.claim.title = '领取 2000 筹码到账号（随时可领，房间内不可）';
  }
  el.claim.onclick = () => Net.send({ type: 'claim' });
  Net.on('needLogin', goLogin);          // 无 token 或续期失败
  Net.on('auth', m => { if (!m.ok) goLogin(); });
  /* 加入成功 = 直接进牌桌。大厅不再有任何房间内操作（选座/买入/补给都在牌桌页），
   * 房间的开局控制也移到了牌桌页的等待浮层 —— 大厅只负责「看房间 → 进房间」。 */
  Net.on('joined', () => {
    sessionStorage.removeItem('poker_no_auto');   // 主动进房，允许牌局进行中自动落桌
    location.href = 'table.html';
  });
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
      '<span class="ri-go">进入 ›</span>' +
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
      el.ops.innerHTML = '<div class="empty">从左边选一个房间，或者自己开一个</div>';
      return;
    }
    const room = state.room;
    el.roomTitle.textContent = room.title + '（' + room.id + '）';
    el.roomMeta.innerHTML =
      '房主 <b>' + UI.esc(room.host || '—') + '</b> · 盲注 <b>' + room.sb + '/' + room.bb + '</b>' +
      ' · 状态 <b>' + (room.status === 'playing' ? '进行中 第' + room.handCount + '手' : '等待开始') + '</b>' +
      ' · 在线 ' + room.members.filter(m => m.online).length + '/' + room.members.length;

    const isHost = room.host === myName;
    let ops = '';
    // 房主的开局控制：房间还空着时从这里开（进桌后等待浮层里也有同一入口）
    if (isHost && room.status !== 'playing') ops += '<button class="primary" data-op="start">开始牌局</button>';
    ops += '<button class="ghost" data-op="table">进入牌桌</button>';
    ops += '<button class="ghost danger" data-op="leave">离开房间</button>';
    el.ops.innerHTML = ops;

    renderChat(state.chat || []);
    // 开局后自动进桌；但用户主动点过「返回大厅」后就别再把他拽回去
    if (room.status === 'playing' && sessionStorage.getItem('poker_no_auto') !== room.id) {
      location.href = 'table.html';
    }
  }

  el.ops.onclick = e => {
    const b = e.target.closest('[data-op]');
    if (b) doOp(b.dataset.op);
  };

  function doOp(op) {
    if (op === 'table') return location.href = 'table.html';
    if (op === 'leave') return Net.send({ type: 'leaveRoom' });
    if (op === 'start') return Net.send({ type: 'start' });
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
