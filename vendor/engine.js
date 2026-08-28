/* engine.js —— 德州扑克规则引擎（纯逻辑，无 DOM 依赖，可在 Node 中跑模拟）
 *
 * hooks（全部可选，可返回 Promise）：
 *   onLog(text, kind)        日志
 *   onUpdate()               状态刷新
 *   onTurn(player)           轮到某人
 *   requestAction(p, legal)  人类玩家决策，必须返回 Promise<action>
 *   onDeal(info)             发牌提示（用于动画）
 *   onHandEnd(result)        一手结束（含摊牌信息），返回值若非 undefined 会被 await
 *   onGameOver(winner)
 */
(function (root, factory) {
  var Cards = (typeof module !== 'undefined' && module.exports) ? require('./cards.js') : root.Cards;
  var AI = (typeof module !== 'undefined' && module.exports) ? require('./ai.js') : root.PokerAI;
  var api = factory(Cards, AI);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerEngine = api;
})(typeof self !== 'undefined' ? self : this, function (Cards, AI) {
  'use strict';

  var PHASE_NAME = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };

  function PokerEngine(cfg, hooks) {
    cfg = cfg || {};
    this.cfg = {
      smallBlind: cfg.smallBlind || 5,
      bigBlind: cfg.bigBlind || 10,
      blindUpHands: cfg.blindUpHands || 0,     // 每 N 手盲注翻倍，0 = 不递增
      difficulty: cfg.difficulty || 'standard', // tight / standard / aggro
      aiDelay: cfg.aiDelay === undefined ? 500 : cfg.aiDelay,
      revealWinnerOnly: !!cfg.revealWinnerOnly
    };
    this.hooks = hooks || {};
    this.seats = (cfg.seats || []).map(function (s, i) {
      // 注意：chips 必须允许为 0（联机时空座位就是 0 筹码，不该被兜底成 1000）
      var chips = (s.chips === undefined || s.chips === null) ? 1000 : s.chips;
      return {
        index: i,
        name: s.name || ('玩家' + (i + 1)),
        type: s.type || 'human',       // human / ai
        chips: chips,
        buyIn: chips,                  // 累计买入，用于结算净盈亏
        hole: [],
        bet: 0,                        // 本轮已投入
        totalContrib: 0,               // 本手累计投入
        folded: false,
        allIn: false,
        acted: false,
        canRaise: true,
        inHand: false,
        lastAction: '',
        won: 0,
        hand: null
      };
    });
    this.buttonIdx = -1;
    this.handCount = 0;
    this.board = [];
    this.deck = [];
    this.sb = this.cfg.smallBlind;
    this.bb = this.cfg.bigBlind;
    this.phase = 'idle';
    this.roundBet = 0;
    this.minRaise = this.cfg.bigBlind;
    this.currentIdx = -1;
    this.finished = false;
    this.aborted = false;
    this.logs = [];
  }

  // 中止牌局（房间解散 / 桌上玩家不足）。中止后所有等待中的决策立即按弃牌处理
  PokerEngine.prototype.abort = function () {
    this.aborted = true;
    this.finished = true;
  };

  PokerEngine.prototype.sleep = function (ms) {
    if (!ms) return Promise.resolve();
    return new Promise(function (r) { setTimeout(r, ms); });
  };
  PokerEngine.prototype.emit = function (name, a, b) {
    var f = this.hooks[name];
    if (!f) return undefined;
    return f(a, b);
  };
  PokerEngine.prototype.log = function (text, kind) {
    this.logs.push({ text: text, kind: kind || 'info', hand: this.handCount });
    return this.emit('onLog', text, kind || 'info');
  };
  PokerEngine.prototype.phaseName = function () { return PHASE_NAME[this.phase] || ''; };

  /* ---------------- 座位遍历 ---------------- */

  // 本手参与（发到牌）的下一家
  PokerEngine.prototype.nextInHandFrom = function (idx) {
    var n = this.seats.length;
    for (var i = 1; i <= n; i++) {
      var s = this.seats[(idx + i) % n];
      if (s.inHand) return s.index;
    }
    return idx;
  };
  // 还能行动（未弃牌、未 all-in）的下一家
  PokerEngine.prototype.nextActiveFrom = function (idx) {
    var n = this.seats.length;
    for (var i = 1; i <= n; i++) {
      var s = this.seats[(idx + i) % n];
      if (s.inHand && !s.folded && !s.allIn) return s.index;
    }
    return -1;
  };
  PokerEngine.prototype.nextSeatWithChips = function (idx) {
    var n = this.seats.length;
    for (var i = 1; i <= n; i++) {
      var j = (idx + i) % n;
      if (this.seats[j].chips > 0) return j;
    }
    return -1;
  };
  // 未弃牌的人（含 all-in）
  PokerEngine.prototype.contenders = function () {
    return this.seats.filter(function (s) { return s.inHand && !s.folded; });
  };
  // 还能继续加注/下注的人数
  PokerEngine.prototype.actableCount = function () {
    return this.seats.filter(function (s) { return s.inHand && !s.folded && !s.allIn; }).length;
  };
  PokerEngine.prototype.potSize = function () {
    var sum = 0;
    for (var i = 0; i < this.seats.length; i++) sum += this.seats[i].totalContrib;
    return sum;
  };
  PokerEngine.prototype.needsAction = function (p) {
    return p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < this.roundBet);
  };

  /* ---------------- 合法动作 ---------------- */

  PokerEngine.prototype.legalActions = function (p) {
    var toCall = Math.max(0, this.roundBet - p.bet);
    var callAmount = Math.min(toCall, p.chips);
    var maxTotal = p.bet + p.chips;
    var minRaiseTotal = this.roundBet + this.minRaise;
    var canRaise = p.canRaise && maxTotal > this.roundBet;
    var minTotal = 0, maxTotalBet = 0;
    if (canRaise) {
      minTotal = maxTotal >= minRaiseTotal ? minRaiseTotal : maxTotal; // 不够最小加注就只能全下
      maxTotalBet = maxTotal;
    }
    return {
      toCall: toCall,
      callAmount: callAmount,
      canCheck: toCall === 0,
      canRaise: canRaise,
      minTotal: minTotal,
      maxTotalBet: maxTotalBet,
      pot: this.potSize(),
      stack: p.chips,
      roundBet: this.roundBet,
      playerBet: p.bet
    };
  };

  // 把任意输入（AI / UI）规范化成合法动作
  PokerEngine.prototype.sanitize = function (p, action, legal) {
    if (!action) action = { type: 'fold' };
    var type = action.type;
    if (type === 'raise' || type === 'bet' || type === 'allin') {
      if (!legal.canRaise) {
        return legal.toCall > 0 ? { type: 'call' } : { type: 'check' };
      }
      if (type === 'allin') return { type: 'raise', total: legal.maxTotalBet };
      var total = Math.round(Number(action.total) || 0);
      if (total >= legal.maxTotalBet) return { type: 'raise', total: legal.maxTotalBet };
      if (total <= legal.minTotal) return { type: 'raise', total: legal.minTotal };
      return { type: 'raise', total: total };
    }
    if (type === 'call') {
      if (legal.toCall <= 0) return { type: 'check' };
      if (legal.callAmount >= p.chips) return { type: 'call' };  // 筹码不够 => 全下跟注
      return { type: 'call' };
    }
    if (type === 'check') {
      if (legal.toCall > 0) return { type: 'call' };
      return { type: 'check' };
    }
    return { type: 'fold' };
  };

  PokerEngine.prototype.applyAction = function (p, action, legal) {
    var self = this;
    if (action.type === 'fold') {
      p.folded = true;
      p.lastAction = '弃牌';
      this.log(p.name + ' 弃牌', 'fold');
      return;
    }
    if (action.type === 'check') {
      p.acted = true;
      p.lastAction = '过牌';
      this.log(p.name + ' 过牌', 'check');
      return;
    }
    if (action.type === 'call') {
      var amt = Math.min(legal.toCall, p.chips);
      p.chips -= amt; p.bet += amt; p.totalContrib += amt;
      p.acted = true;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? '跟注全下 ' + amt : '跟注 ' + amt;
      this.log(p.name + ' 跟注 ' + amt + (p.allIn ? '（全下）' : ''), 'call');
      return;
    }
    if (action.type === 'raise') {
      var total = Math.min(action.total, p.bet + p.chips);
      var add = total - p.bet;
      p.chips -= add; p.bet = total; p.totalContrib += add;
      p.acted = true;
      var raiseSize = total - this.roundBet;
      var isFullRaise = raiseSize >= this.minRaise;
      if (total > this.roundBet) {
        if (isFullRaise) this.minRaise = raiseSize;
        this.seats.forEach(function (o) {
          if (o.index === p.index || o.folded || o.allIn || !o.inHand) return;
          var hadActed = o.acted;
          o.acted = false;                       // 有人加注 => 所有人都需要重新表态
          if (!isFullRaise && hadActed) o.canRaise = false; // 不完整的 all-in 加注：已行动者只能跟或弃
        });
        this.roundBet = total;
      }
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? '全下 ' + total : '加注到 ' + total;
      this.log(p.name + (p.allIn ? ' 全下 ' : ' 加注到 ') + total, 'raise');
      return;
    }
  };

  /* ---------------- 一手牌流程 ---------------- */

  PokerEngine.prototype.postBlind = function (seat, amount, label) {
    var amt = Math.min(amount, seat.chips);
    seat.chips -= amt;
    seat.bet = amt;
    seat.totalContrib += amt;
    if (seat.chips === 0) seat.allIn = true;
    seat.lastAction = label + ' ' + amt;
    this.log(seat.name + ' 下' + label + ' ' + amt + (seat.allIn ? '（全下）' : ''), 'blind');
  };

  PokerEngine.prototype.startHand = async function () {
    var self = this;
    if (this.aborted) return null;
    if (this.cfg.blindUpHands > 0 && this.handCount > 0 && this.handCount % this.cfg.blindUpHands === 0) {
      this.sb *= 2; this.bb *= 2;
      this.log('盲注提升至 ' + this.sb + '/' + this.bb, 'system');
    }

    this.seats.forEach(function (s) {
      s.hole = []; s.bet = 0; s.totalContrib = 0;
      s.folded = s.chips <= 0; s.allIn = false; s.acted = false; s.canRaise = true;
      s.inHand = s.chips > 0; s.lastAction = ''; s.won = 0; s.hand = null;
      s.folded = s.chips <= 0;
    });

    var players = this.seats.filter(function (s) { return s.inHand; });
    if (players.length < 2) { this.finished = true; return null; }

    this.handCount++;
    this.board = [];
    this.deck = Cards.shuffle(Cards.makeDeck());
    this.phase = 'preflop';
    this.settled = false;

    this.buttonIdx = this.nextSeatWithChips(this.buttonIdx);
    if (this.buttonIdx < 0) { this.finished = true; return null; }

    var n = players.length;
    this.sbIdx = n === 2 ? this.buttonIdx : this.nextInHandFrom(this.buttonIdx); // 单挑：庄家 = 小盲
    this.bbIdx = this.nextInHandFrom(this.sbIdx);

    this.log('—— 第 ' + this.handCount + ' 手 · 庄家 ' + this.seats[this.buttonIdx].name +
      ' · 盲注 ' + this.sb + '/' + this.bb + ' ——', 'system');

    this.postBlind(this.seats[this.sbIdx], this.sb, '小盲');
    this.postBlind(this.seats[this.bbIdx], this.bb, '大盲');

    // 发底牌：从小盲开始，每次一张，共两轮
    var order = [], idx = this.sbIdx;
    do { order.push(idx); idx = this.nextInHandFrom(idx); } while (idx !== this.sbIdx && order.length <= n);
    for (var round = 0; round < 2; round++) {
      for (var i = 0; i < order.length; i++) this.seats[order[i]].hole.push(this.deck.pop());
    }
    await this.emit('onDeal', { type: 'hole' });
    await this.emit('onUpdate');

    // 翻牌前
    await this.bettingRound();
    if (this.aborted) return null;
    if (this.contenders().length <= 1) return await this.finishHand('fold');

    // 翻牌 / 转牌 / 河牌
    var streets = [['flop', 3], ['turn', 1], ['river', 1]];
    for (var k = 0; k < streets.length; k++) {
      this.phase = streets[k][0];
      for (var c = 0; c < streets[k][1]; c++) this.board.push(this.deck.pop());
      await this.emit('onDeal', { type: this.phase, cards: this.board.slice() });
      this.log(this.phaseName() + '：' + this.board.map(Cards.cardText).join(' '), 'board');
      await this.emit('onUpdate');

      if (this.contenders().length <= 1) return await this.finishHand('fold');
      if (this.actableCount() >= 2) await this.bettingRound();
      if (this.aborted) return null;
      if (this.contenders().length <= 1) return await this.finishHand('fold');
    }

    return await this.finishHand('showdown');
  };

  PokerEngine.prototype.firstActorIndex = function () {
    var n = this.seats.filter(function (s) { return s.inHand; }).length;
    var start;
    // 翻牌前：单挑由庄家（小盲）先说话；3 人以上由大盲的下家（UTG）先
    if (this.phase === 'preflop') start = (n === 2) ? this.buttonIdx : this.nextActiveFrom(this.bbIdx);
    else start = this.buttonIdx;
    if (start < 0) return -1;
    if (this.needsAction(this.seats[start])) return start;
    var nx = this.nextActiveFrom(start);
    return nx;
  };

  PokerEngine.prototype.bettingRound = async function () {
    var self = this;
    this.seats.forEach(function (s) { s.acted = false; s.canRaise = true; });
    // 翻牌前保留已下的盲注；后续街清零本轮下注额
    var maxBet = 0;
    if (this.phase === 'preflop') {
      this.seats.forEach(function (s) { if (s.bet > maxBet) maxBet = s.bet; });
    } else {
      this.seats.forEach(function (s) { s.bet = 0; });
    }
    this.roundBet = this.phase === 'preflop' ? maxBet : 0;
    this.minRaise = this.bb;

    var idx = this.firstActorIndex();
    if (idx < 0) return;

    var idle = 0, guard = 0;
    while (idle <= this.seats.length && guard++ < 500) {
      if (this.aborted) return;
      if (this.contenders().length <= 1) break;
      if (this.actableCount() === 0) break;
      var p = this.seats[idx];
      if (this.needsAction(p)) {
        idle = 0;
        await this.doTurn(p);
        if (this.contenders().length <= 1) break;
      } else {
        idle++;
      }
      var nx = this.nextActiveFrom(idx);
      if (nx < 0) break;
      idx = nx;
    }
  };

  PokerEngine.prototype.doTurn = async function (p) {
    if (this.aborted) return;
    this.currentIdx = p.index;
    await this.emit('onTurn', p);
    var legal = this.legalActions(p);
    var action;
    if (this.aborted) { action = { type: 'fold' }; }
    else if (p.type === 'ai') {
      await this.sleep(this.cfg.aiDelay);
      action = AI.decide(this, p, legal);
    } else {
      if (!this.hooks.requestAction) throw new Error('缺少人类玩家决策回调 requestAction');
      action = await this.hooks.requestAction(p, legal);
    }
    action = this.sanitize(p, action, legal);
    this.applyAction(p, action, legal);
    this.currentIdx = -1;
    await this.emit('onUpdate');
  };

  PokerEngine.prototype.dealRemainingBoard = function () {
    while (this.board.length < 5) this.board.push(this.deck.pop());
  };

  /* ---------------- 结算 ---------------- */

  PokerEngine.prototype.computePots = function () {
    var contribs = this.seats.map(function (s) { return s.totalContrib; }).filter(function (c) { return c > 0; });
    var levels = contribs.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
    var pots = [], prev = 0;
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i], amt = 0, elig = [];
      for (var j = 0; j < this.seats.length; j++) {
        var s = this.seats[j];
        amt += Math.min(s.totalContrib, lv) - Math.min(s.totalContrib, prev);
        if (s.totalContrib >= lv && !s.folded) elig.push(s.index);
      }
      if (amt > 0) pots.push({ amount: amt, eligible: elig });
      prev = lv;
    }
    // 合并相邻且可争抢者相同的池
    var merged = [];
    for (var k = 0; k < pots.length; k++) {
      var last = merged[merged.length - 1];
      if (last && last.eligible.join(',') === pots[k].eligible.join(',')) last.amount += pots[k].amount;
      else merged.push(pots[k]);
    }
    return merged;
  };

  PokerEngine.prototype.orderFromButton = function (players) {
    var n = this.seats.length, btn = this.buttonIdx;
    return players.slice().sort(function (a, b) {
      return (((a.index - btn) % n) + n) % n - (((b.index - btn) % n) + n) % n;
    });
  };

  PokerEngine.prototype.finishHand = async function (reason) {
    var self = this;
    this.phase = 'showdown';
    this.currentIdx = -1;

    var pots = this.computePots();
    var winners = [];          // 结算展示用
    var awarded = {};

    for (var i = 0; i < pots.length; i++) {
      var pot = pots[i];
      var contenders = pot.eligible.map(function (idx) { return self.seats[idx]; });
      // 保险：理论上不会出现空池
      if (contenders.length === 0) {
        var alive = this.contenders();
        if (!alive.length) continue;
        contenders = [alive[0]];
      }
      var potWinners;
      if (contenders.length === 1) {
        potWinners = [contenders[0]];
      } else {
        var scored = contenders.map(function (p) {
          var ev = Cards.evaluate(p.hole.concat(self.board));
          p.hand = ev;
          return { p: p, ev: ev };
        });
        scored.sort(function (a, b) { return Cards.compareEval(b.ev, a.ev); });
        potWinners = scored.filter(function (x) { return Cards.compareEval(x.ev, scored[0].ev) === 0; })
          .map(function (x) { return x.p; });
      }
      potWinners = this.orderFromButton(potWinners);
      var share = Math.floor(pot.amount / potWinners.length);
      var rem = pot.amount - share * potWinners.length;
      potWinners.forEach(function (w) {
        var extra = rem > 0 ? 1 : 0;
        if (rem > 0) rem--;
        w.chips += share + extra;
        w.won += share + extra;
        awarded[w.index] = (awarded[w.index] || 0) + share + extra;
      });
      pot.winners = potWinners.map(function (w) { return w.index; });
      winners = winners.concat(potWinners);
    }

    // 底池已分配完毕：此后 totalContrib 只是历史账，不能再当作「还在池里的钱」退回
    this.settled = true;

    // 摊牌信息
    var showdown = this.contenders().length > 1 && reason === 'showdown';
    var revealed = this.seats.filter(function (s) { return s.inHand && !s.folded && (showdown || awarded[s.index]); });
    revealed.forEach(function (s) { if (!s.hand) s.hand = Cards.evaluate(s.hole.concat(self.board)); });

    var lines = [];
    if (reason === 'fold') {
      var win = this.contenders()[0];
      this.log(this.contenders().length === 1 ? (win.name + ' 收下底池（其余人弃牌）') : '本手结束', 'win');
    } else {
      var topWinners = [];
      for (var idx2 in awarded) topWinners.push(this.seats[idx2]);
      topWinners = this.orderFromButton(topWinners);
      topWinners.forEach(function (w) {
        var txt = w.name + ' 赢得 ' + awarded[w.index] + (w.hand ? '（' + w.hand.name + '）' : '');
        lines.push(txt);
        self.log(txt, 'win');
      });
    }

    var result = {
      hand: this.handCount,
      reason: reason,                 // fold / showdown
      board: this.board.slice(),
      pots: pots.map(function (p) {
        return { amount: p.amount, winners: p.winners, eligible: p.eligible };
      }),
      revealed: revealed.map(function (s) {
        return {
          index: s.index, name: s.name, hole: s.hole.slice(),
          hand: s.hand, won: awarded[s.index] || 0, folded: s.folded
        };
      }),
      winners: lines,
      seats: this.seats.map(function (s) {
        return { index: s.index, name: s.name, chips: s.chips, delta: s.won - s.totalContrib, won: s.won };
      })
    };

    await this.emit('onUpdate');
    await this.emit('onHandEnd', result);

    if (this.seats.filter(function (s) { return s.chips > 0; }).length < 2) {
      this.finished = true;
      var champ = this.seats.slice().sort(function (a, b) { return b.chips - a.chips; })[0];
      this.log('游戏结束，' + champ.name + ' 获得全部筹码！', 'system');
      await this.emit('onGameOver', champ);
    }
    return result;
  };

  PokerEngine.PHASE_NAME = PHASE_NAME;
  return PokerEngine;
});
