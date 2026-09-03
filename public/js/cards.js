/* cards.js —— 牌组、洗牌、7 张选 5 牌型评估与比较（浏览器 / Node 通用）
 *
 * 这是 vendor/cards.js 的前端副本（由 `npm run vendor` 同步），页面直接引用它，
 * 不再依赖任何仓库外部的 /shared/ 路径。两份必须保持一致。
 */
(function (root, factory) {
  var Cards = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = Cards;
  else root.Cards = Cards;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];              // 黑桃 红心 方块 梅花
  var SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var RANK_LABEL = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

  // 0 高牌 1 一对 2 两对 3 三条 4 顺子 5 同花 6 葫芦 7 四条 8 同花顺 9 皇家同花顺
  var HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'];

  function makeDeck() {
    var d = [];
    for (var i = 0; i < SUITS.length; i++) {
      for (var r = 2; r <= 14; r++) d.push({ r: r, s: SUITS[i] });
    }
    return d;
  }

  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  // uniqDesc: 去重后降序的牌面数组，如 [14,13,12...]。A 可作 1 组成 A2345
  function findStraightHigh(uniqDesc) {
    var arr = uniqDesc.slice();
    if (arr[0] === 14) arr.push(1);
    for (var i = 0; i + 4 < arr.length; i++) {
      if (arr[i] - arr[i + 4] === 4) return arr[i];   // 去重降序 ⇒ 跨度 4 即连续 5 张
    }
    return 0;
  }

  function straightRanks(high) {
    return high === 5 ? [5, 4, 3, 2, 14] : [high, high - 1, high - 2, high - 3, high - 4];
  }

  /**
   * 评估任意 5~7 张牌，返回 {cat, name, values, best}
   * values 用于同牌型之间的比较（字典序）
   */
  function evaluate(cards) {
    var cs = cards.slice();
    var byRank = {}, bySuit = {}, i;
    for (i = 0; i < cs.length; i++) {
      var c = cs[i];
      (byRank[c.r] = byRank[c.r] || []).push(c);
      (bySuit[c.s] = bySuit[c.s] || []).push(c);
    }
    var ranksDesc = Object.keys(byRank).map(Number).sort(function (a, b) { return b - a; });

    var quads = [], trips = [], pairs = [];
    for (i = 0; i < ranksDesc.length; i++) {
      var g = byRank[ranksDesc[i]];
      if (g.length === 4) quads.push(ranksDesc[i]);
      else if (g.length === 3) trips.push(ranksDesc[i]);
      else if (g.length === 2) pairs.push(ranksDesc[i]);
    }

    var flushSuit = null;
    for (var s in bySuit) { if (bySuit[s].length >= 5) { flushSuit = s; break; } }
    var flushCards = null;
    if (flushSuit !== null) {
      flushCards = bySuit[flushSuit].slice().sort(function (a, b) { return b.r - a.r; });
    }

    var straightHigh = findStraightHigh(ranksDesc);

    // 同花顺 / 皇家同花顺
    if (flushCards) {
      var fRanks = [];
      for (i = 0; i < flushCards.length; i++) {
        if (fRanks.indexOf(flushCards[i].r) < 0) fRanks.push(flushCards[i].r);
      }
      var sf = findStraightHigh(fRanks);
      if (sf) {
        var need1 = straightRanks(sf), best1 = [];
        for (i = 0; i < need1.length; i++) {
          for (var k = 0; k < flushCards.length; k++) {
            if (flushCards[k].r === need1[i]) { best1.push(flushCards[k]); break; }
          }
        }
        return { cat: sf === 14 ? 9 : 8, name: HAND_NAMES[sf === 14 ? 9 : 8], values: [sf], best: best1 };
      }
    }

    // 四条
    if (quads.length) {
      var q = quads[0], kicker = ranksDesc.filter(function (r) { return r !== q; })[0];
      return { cat: 7, name: HAND_NAMES[7], values: [q, kicker], best: byRank[q].concat([byRank[kicker][0]]) };
    }

    // 葫芦（三条 + 对子，或两组三条）
    if (trips.length && (pairs.length || trips.length >= 2)) {
      var t = trips[0], pr = trips.length >= 2 ? trips[1] : pairs[0];
      return { cat: 6, name: HAND_NAMES[6], values: [t, pr], best: byRank[t].concat(byRank[pr].slice(0, 2)) };
    }

    // 同花
    if (flushCards) {
      var best5 = flushCards.slice(0, 5);
      return { cat: 5, name: HAND_NAMES[5], values: best5.map(function (x) { return x.r; }), best: best5 };
    }

    // 顺子
    if (straightHigh) {
      var need2 = straightRanks(straightHigh), best2 = [];
      for (i = 0; i < need2.length; i++) {
        for (var m = 0; m < cs.length; m++) { if (cs[m].r === need2[i]) { best2.push(cs[m]); break; } }
      }
      return { cat: 4, name: HAND_NAMES[4], values: [straightHigh], best: best2 };
    }

    // 三条
    if (trips.length) {
      var t3 = trips[0];
      var kicks3 = ranksDesc.filter(function (r) { return r !== t3; }).slice(0, 2);
      var b3 = byRank[t3].slice();
      for (i = 0; i < kicks3.length; i++) b3.push(byRank[kicks3[i]][0]);
      return { cat: 3, name: HAND_NAMES[3], values: [t3].concat(kicks3), best: b3 };
    }

    // 两对
    if (pairs.length >= 2) {
      var p1 = pairs[0], p2 = pairs[1];
      var kk = ranksDesc.filter(function (r) { return r !== p1 && r !== p2; })[0];
      var b2 = byRank[p1].concat(byRank[p2]);
      if (kk !== undefined) b2.push(byRank[kk][0]);
      return { cat: 2, name: HAND_NAMES[2], values: [p1, p2, kk || 0], best: b2 };
    }

    // 一对
    if (pairs.length === 1) {
      var pp = pairs[0];
      var kicks1 = ranksDesc.filter(function (r) { return r !== pp; }).slice(0, 3);
      var b1 = byRank[pp].slice();
      for (i = 0; i < kicks1.length; i++) b1.push(byRank[kicks1[i]][0]);
      return { cat: 1, name: HAND_NAMES[1], values: [pp].concat(kicks1), best: b1 };
    }

    // 高牌
    var top = cs.slice().sort(function (a, b) { return b.r - a.r; }).slice(0, 5);
    return { cat: 0, name: HAND_NAMES[0], values: top.map(function (x) { return x.r; }), best: top };
  }

  // a > b 返回正数，相等返回 0
  function compareEval(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    var len = Math.max(a.values.length, b.values.length);
    for (var i = 0; i < len; i++) {
      var x = a.values[i] || 0, y = b.values[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function cardText(c) { return SUIT_SYMBOL[c.s] + RANK_LABEL[c.r]; }
  function isRed(c) { return c.s === 'h' || c.s === 'd'; }

  // 便捷构造：'Ah' -> {r:14,s:'h'}；'Td'/'10d' -> {r:10,s:'d'}
  function parseCard(str) {
    var s = String(str).trim();
    var suit = s.slice(-1).toLowerCase();
    var rank = s.slice(0, -1).toUpperCase();
    var map = { 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    var r = map[rank] || parseInt(rank, 10);
    return { r: r, s: suit };
  }
  function parseList(str) {
    return String(str).trim().split(/\s+/).map(parseCard);
  }

  return {
    SUITS: SUITS, SUIT_SYMBOL: SUIT_SYMBOL, RANK_LABEL: RANK_LABEL, HAND_NAMES: HAND_NAMES,
    makeDeck: makeDeck, shuffle: shuffle, evaluate: evaluate, compareEval: compareEval,
    cardText: cardText, isRed: isRed, parseCard: parseCard, parseList: parseList
  };
});
