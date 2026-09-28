/* common.js —— 各页共用的小工具：格式化、牌面渲染、弹窗、吐司 */
window.UI = (function () {
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* 花色矢量图形 —— 四种花色各一段 SVG，全部在 viewBox 0 0 100 100 里、fill=currentColor。
   *
   * 为什么弃用 Unicode ♠♥♦♣：字符花色的字形完全交给系统字体，各平台粗细/比例天差地别，
   * 部分系统还把 ♥♦ 渲染成彩色 emoji —— 同一张牌换台设备就变了样，这是「不好看」的根源。
   * 改成内联 SVG 后字形由我们自己定义，任何设备下都是同一套精心打磨的曲线，
   * 且能用 currentColor 跟随红/黑牌色、按牌尺寸等比缩放，不依赖任何字体。
   *
   * 形状经过手工调校：黑桃顶尖收腰 + 双弧底座，红心饱满对称，方块用微弧菱形（比直线菱形更柔和），
   * 梅花三圆 + 收腰茎。都是纯常量，不含任何用户输入。 */
  var SUIT_SVG = {
    s: '<path d="M50 12 C40 29 18 40 18 58 C18 71 27 78 37 78 C43 78 47 75 50 70 C49 82 43 89 35 92 L65 92 C57 89 51 82 50 70 C53 75 57 78 63 78 C73 78 82 71 82 58 C82 40 60 29 50 12 Z"/>',
    h: '<path d="M50 88 C20 67 11 51 11 34 C11 22 20 15 30 15 C39 15 46 21 50 30 C54 21 61 15 70 15 C80 15 89 22 89 34 C89 51 80 67 50 88 Z"/>',
    d: '<path d="M50 8 C58 27 71 42 86 50 C71 58 58 73 50 92 C42 73 29 58 14 50 C29 42 42 27 50 8 Z"/>',
    c: '<circle cx="50" cy="30" r="17"/><circle cx="29" cy="55" r="17"/><circle cx="71" cy="55" r="17"/><path d="M45 50 C45 68 41 82 34 92 L66 92 C59 82 55 68 55 50 Z"/>'
  };
  /** 生成一枚花色 SVG（cls 决定它是中央大花色 .pip 还是左上角小花色 .suit）。
   *  s 只用于查表，非法值兜底为黑桃，杜绝注入。 */
  function suitSVG(s, cls) {
    var body = SUIT_SVG[s] || SUIT_SVG.s;
    return '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' + body + '</svg>';
  }

  /* 牌面 HTML —— 结构照真牌来：左上角索引（点数 + 小花色竖排）+ 中央大花色。
   *
   * 为什么不是「点数 + 花色居中堆叠」：那样看着像个 UI 徽章，而且叠压时
   * 中间那团正好落在被压区。索引挪到左上角后，牌叠得再多也总能从露出的
   * 一角读到点数和花色 —— 这也是真牌把索引放角上的原因。
   *
   * 花色改用内联 SVG（见 SUIT_SVG）：左上角小花色 .suit、中央大花色 .pip 各一枚，
   * 都跟随 .card 的红/黑 currentColor。data-suit 保留花色字母（s/h/d/c）作样式钩子。
   * .rank / .suit 两个类名保留：tools 的叠压避让断言按它们定位。 */
  function cardHTML(c, size) {
    // 牌背：一枚居中的金色黑桃徽记（同样用 SVG，与牌面同一套字形语言）
    if (!c) return '<div class="card ' + size + ' back">' + suitSVG('s', 'pip back-pip') + '</div>';
    var label = Cards.RANK_LABEL[c.r];
    // 「10」比其他点数宽一位，标出来让 CSS 收窄字号，免得索引顶到中央大花色
    var rankCls = label.length > 1 ? 'rank two-char' : 'rank';
    return '<div class="card ' + size + ' ' + (Cards.isRed(c) ? 'red' : 'black') +
      '" data-suit="' + c.s + '">' +
      '<span class="idx">' +
        '<span class="' + rankCls + '">' + label + '</span>' +
        suitSVG(c.s, 'suit') +
      '</span>' +
      suitSVG(c.s, 'pip') +
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
