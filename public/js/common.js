/* common.js —— 各页共用的小工具：格式化、牌面渲染、弹窗、吐司 */
window.UI = (function () {
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* 牌面 HTML —— 结构照真牌来：左上角索引（点数 + 小花色竖排）+ 中央大花色。
   *
   * 为什么不是「点数 + 花色居中堆叠」：那样看着像个 UI 徽章，而且叠压时
   * 中间那团正好落在被压区。索引挪到左上角后，牌叠得再多也总能从露出的
   * 一角读到点数和花色 —— 这也是真牌把索引放角上的原因。
   *
   * data-suit 供 CSS 画中央大花色与角落暗纹（.card::before / ::after 读它），
   * 取值来自 Cards.SUIT_SYMBOL 常量表，只有 ♠♥♦♣ 四种，不含任何用户输入。
   * .rank / .suit 两个类名保留：tools 的叠压避让断言按它们定位。 */
  function cardHTML(c, size) {
    if (!c) return '<div class="card ' + size + ' back"></div>';
    var sym = Cards.SUIT_SYMBOL[c.s];
    var label = Cards.RANK_LABEL[c.r];
    // 「10」比其他点数宽一位，标出来让 CSS 收窄字号，免得索引顶到中央大花色
    var rankCls = label.length > 1 ? 'rank two-char' : 'rank';
    return '<div class="card ' + size + ' ' + (Cards.isRed(c) ? 'red' : 'black') +
      '" data-suit="' + sym + '">' +
      '<span class="idx">' +
        '<span class="' + rankCls + '">' + label + '</span>' +
        '<span class="suit">' + sym + '</span>' +
      '</span></div>';
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
