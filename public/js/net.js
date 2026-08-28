/* net.js —— WebSocket 客户端：认证、自动重连、消息分发 */
window.Net = (function () {
  const TOKEN_KEY = 'poker_token';
  let ws = null, handlers = {}, token = localStorage.getItem(TOKEN_KEY) || '';
  let user = null, retry = 0, stopped = false, connState = 'connecting';
  const queue = [];

  function on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); return Net; }
  function emit(type, msg) {
    (handlers[type] || []).forEach(f => { try { f(msg); } catch (e) { console.error(e); } });
  }
  function state(s) { connState = s; emit('conn', s); }

  /** 服务端地址：优先 ?s= 参数，其次 localStorage，最后同源 */
  function serverURL() {
    const q = new URLSearchParams(location.search).get('s');
    const raw = String(q || localStorage.getItem('poker_server') || '').trim();
    if (!raw) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    if (/^wss?:\/\//i.test(raw)) return raw;
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return scheme + raw.replace(/\/+$/, '') + '/ws';
  }

  function connect() {
    if (stopped) return;
    try { ws = new WebSocket(serverURL()); }
    catch (e) { state('offline'); setTimeout(connect, 2000); return; }

    // 「已连接且已认证」才算真正上线。有 token 时必须先等 resume 结果，
    // 否则页面一收到 online 就发业务消息（如 me），此时服务端还没把这条连接和用户关联，
    // 会回 user:null，页面据此判定未登录 → 跳登录页 → 登录页续期成功又跳回来 → 无限循环。
    function goOnline() {
      state('online');
      while (queue.length) { try { ws.send(queue.shift()); } catch (e) { break; } }
    }

    ws.onopen = () => {
      retry = 0;
      if (token) send({ type: 'resume', token: token });   // 等 auth 回来再 goOnline()
      else { goOnline(); emit('needLogin'); }
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'auth') {
        if (m.ok) {
          token = m.token; user = m.user; localStorage.setItem(TOKEN_KEY, token);
          goOnline();
        } else {
          // 登录/续期失败：清掉本地凭证，并明确告诉页面「需要登录」
          token = ''; user = null; localStorage.removeItem(TOKEN_KEY);
          goOnline();
          emit('needLogin');
        }
      }
      if (m.type === 'me' && m.user) user = m.user;
      emit(m.type, m);
      emit('*', m);
    };
    ws.onclose = () => {
      state('offline');
      if (stopped) return;
      const wait = Math.min(8000, 400 * Math.pow(2, retry++));
      setTimeout(connect, wait);
    };
    ws.onerror = () => { /* close 会接着触发 */ };
  }

  function send(obj) {
    const data = JSON.stringify(obj);
    if (ws && ws.readyState === 1) { try { ws.send(data); return true; } catch (e) { /* fallthrough */ } }
    if (queue.length < 50) queue.push(data);
    return false;
  }

  function logout() {
    send({ type: 'logout', token: token });
    token = ''; user = null; localStorage.removeItem(TOKEN_KEY);
    location.href = 'index.html';
  }

  const Net = {
    on, send, connect, logout,
    get token() { return token; },
    get user() { return user; },
    get conn() { return connState; },
    get isAuthed() { return !!user; }
  };
  return Net;
})();
Net.connect();
