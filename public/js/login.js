/* login.js —— 登录 / 注册 */
(function () {
  const $ = s => document.querySelector(s);
  let mode = 'login';
  let pending = false;

  const el = {
    tabLogin: $('#tab-login'), tabReg: $('#tab-reg'),
    name: $('#name'), pw: $('#pw'), pw2: $('#pw2'),
    err: $('#err'), go: $('#go'), form: $('#form'), conn: $('#conn')
  };

  function setMode(m) {
    mode = m;
    el.tabLogin.classList.toggle('on', m === 'login');
    el.tabReg.classList.toggle('on', m === 'reg');
    el.pw2.hidden = m !== 'reg';
    el.go.textContent = m === 'login' ? '登录' : '注册并进入';
    el.err.textContent = '';
  }
  el.tabLogin.onclick = () => setMode('login');
  el.tabReg.onclick = () => setMode('reg');

  let offlineSince = 0;
  Net.on('conn', s => {
    el.conn.textContent = s === 'online' ? '已连接服务器' : s === 'offline' ? '连不上服务器，正在重连…' : '连接中…';
    el.conn.className = 'conn ' + s;
    if (s === 'offline') offlineSince = offlineSince || Date.now();
    else offlineSince = 0;
  });
  // 连不上时提示去配置服务器地址（静态托管场景）
  setInterval(() => {
    if (offlineSince && Date.now() - offlineSince > 4000) {
      el.conn.innerHTML = '连不上服务器 · <a href="#" id="quick-srv">点这里设置服务端地址</a>' +
        '<div class="tip" style="margin-top:6px">静态页面需要自己指定 WebSocket 服务端，' +
        '例如 192.168.1.20:3000 或 wss://your-server.onrender.com</div>';
      const a = document.getElementById('quick-srv');
      if (a) a.onclick = e => { e.preventDefault(); document.getElementById('srv-set').click(); };
      offlineSince = 0;
    }
  }, 1000);

  Net.on('needLogin', () => { pending = false; });
  Net.on('auth', m => {
    pending = false;
    if (m.ok) location.href = 'lobby.html';
    else { el.err.textContent = m.error || '登录失败'; el.go.disabled = false; }
  });
  Net.on('error', m => { el.err.textContent = m.msg || '出错了'; el.go.disabled = false; pending = false; });

  el.form.onsubmit = e => {
    e.preventDefault();
    const name = el.name.value.trim(), pw = el.pw.value;
    if (!name) return (el.err.textContent = '请输入昵称');
    if (pw.length < 6) return (el.err.textContent = '密码至少 6 位');
    if (mode === 'reg' && pw !== el.pw2.value) return (el.err.textContent = '两次输入的密码不一致');
    el.err.textContent = '';
    el.go.disabled = true;
    pending = true;
    Net.send({ type: mode === 'reg' ? 'register' : 'login', name, password: pw });
    setTimeout(() => {
      if (pending) { pending = false; el.go.disabled = false; el.err.textContent = '服务器没有响应，请重试'; }
    }, 8000);
  };

  /* 服务器地址（前后端分离部署时用） */
  const srvNow = $('#srv-now');
  function refreshSrv() {
    const s = localStorage.getItem('poker_server');
    srvNow.textContent = s ? '当前：' + s : '当前：同源（本机服务）';
  }
  $('#srv-set').onclick = e => {
    e.preventDefault();
    UI.modal({
      type: 'text',
      title: '服务器地址',
      label: 'WebSocket 服务端地址',
      value: localStorage.getItem('poker_server') || '',
      placeholder: '192.168.1.20:3000 或 wss://xxx.onrender.com',
      tip: '留空并确定则恢复为同源。若本页是 https，服务端必须支持 wss。',
      okText: '保存并刷新',
      onOk: v => {
        if (v === '-') localStorage.removeItem('poker_server');
        else localStorage.setItem('poker_server', v);
        location.reload();
      }
    });
  };

  // 凭证续期由 net.js 在连接建立时自动发起，成功后收到 auth → 跳大厅
  refreshSrv();
  setMode('login');
  el.name.focus();
})();
