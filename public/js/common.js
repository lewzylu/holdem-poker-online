/* common.js —— 各页共用的小工具：格式化、牌面渲染、弹窗、吐司 */
window.UI = (function () {
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cardHTML(c, size) {
    if (!c) return '<div class="card ' + size + ' back"></div>';
    return '<div class="card ' + size + ' ' + (Cards.isRed(c) ? 'red' : 'black') + '">' +
      '<span class="rank">' + Cards.RANK_LABEL[c.r] + '</span>' +
      '<span class="suit">' + Cards.SUIT_SYMBOL[c.s] + '</span></div>';
  }

  let toastTimer = null;
  function toast(msg, kind) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /** 简单输入框弹窗：UI.modal({title, label, value, tip, okText, type:'number'|'text', onOk(value)}) */
  function modal(opt) {
    const isText = opt.type === 'text';
    const wrap = document.createElement('div');
    wrap.className = 'overlay';
    wrap.innerHTML =
      '<div class="dialog">' +
      '<h3>' + esc(opt.title) + '</h3>' +
      (opt.label ? '<label>' + esc(opt.label) + '</label>' : '') +
      (isText
        ? '<input type="text" value="' + esc(opt.value || '') + '" placeholder="' + esc(opt.placeholder || '') + '">'
        : '<input type="number" value="' + esc(opt.value || '') + '" min="' + (opt.min || 1) + '" max="' + (opt.max || 999999) + '">') +
      (opt.tip ? '<p class="tip">' + esc(opt.tip) + '</p>' : '') +
      '<div class="dialog-btns">' +
      '<button class="ghost" data-x>取消</button>' +
      '<button class="primary" data-ok>' + esc(opt.okText || '确定') + '</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    const input = wrap.querySelector('input');
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.hasAttribute('data-x')) close();
      if (e.target.hasAttribute('data-ok')) {
        let v;
        if (isText) {
          v = input.value.trim();
          if (!v) { input.focus(); return; }
        } else {
          v = parseInt(input.value, 10);
          if (isNaN(v)) { input.focus(); return; }
        }
        close();
        opt.onOk && opt.onOk(v);
      }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') wrap.querySelector('[data-ok]').click(); });
    input.focus(); input.select();
  }

  return { fmt, esc, cardHTML, toast, modal };
})();
