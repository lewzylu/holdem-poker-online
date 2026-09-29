/* common.js —— 各页共用的小工具：格式化、牌面渲染、弹窗、吐司 */
window.UI = (function () {
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* 牌面 HTML —— 版式照参考图：底色色块 + 同色系更暗的花色剪影 + 白色点数居中。
   *
   * 色块与剪影来自雪碧图 public/img/cards.png（用参考图重排而成）：
   * data-suit 选**行**、data-rank 选**列**，由 table.css 用 background-position 定位。
   * 花色图形因此不再需要内联 SVG —— 剪影形状直接取自参考图，比手绘的更准。
   *
   * 生成雪碧图时把原图上的白字擦掉了：点数仍由 CSS 渲染，好处是字形保持矢量，
   * 且十可以写「T」（单字符，与其余 12 个点数等宽），不被图上的字形绑死。
   *
   * 居中有一个已知代价：底牌两张叠压后，下层牌的点数会伸到被压区边缘。
   * tools/visual-check.js 有一条断言守着「不越界」，最宽的点数是 Q，余量实测 3.1px。
   *
   * .rank 这个类名必须留着：tools 的叠压断言按它定位。 */
  function cardHTML(c, size) {
    // 牌背：纯色块 + 白边，不放任何徽记 —— 桌上有九个人的牌背，图案只会显杂
    if (!c) return '<div class="card ' + size + ' back"></div>';
    var label = Cards.RANK_LABEL[c.r];
    // 十写作 T 之后所有点数都是单字符，这个分支只在将来改回「10」时才用到
    var rankCls = label.length > 1 ? 'rank two-char' : 'rank';
    return '<div class="card ' + size + ' ' + (Cards.isRed(c) ? 'red' : 'black') +
      '" data-suit="' + c.s + '" data-rank="' + c.r + '">' +
      '<span class="' + rankCls + '">' + label + '</span>' +
      '</div>';
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
