/* room.js —— 房间：座位/买入/开局，服务端权威地跑 PokerEngine，决策走 WebSocket
 *
 * 设计要点：
 *  - engine 的座位索引 == 房间座位索引（0..8），空座位 chips=0 会被引擎自动跳过
 *  - 每个玩家的视图单独生成（stateFor），底牌只发给本人，摊牌时才公开
 *  - 行动有超时（默认 30s），超时自动弃牌/过牌；掉线会缩短等待时间
 */
'use strict';
const { PokerEngine, Cards } = require('./poker-core.js');
const db = require('./db.js');

const SEATS = 9;
const ACTION_TIMEOUT = 30000;
const RESULT_SHOW_MS = 6500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Room {
  constructor(id, opts, ctx) {
    this.id = id;
    this.title = opts.title || '好友局';
    this.host = opts.host;               // 房主昵称
    this.sb = opts.sb;
    this.bb = opts.bb;
    this.buyIn = opts.buyIn;
    this.seats = [];
    for (let i = 0; i < SEATS; i++) {
      this.seats.push({ index: i, name: null, chips: 0, leaveAfterHand: false });
    }
    this.members = new Set();            // 房间内所有人（含旁观）
    this.status = 'waiting';             // waiting | playing
    this.game = null;
    this.pending = null;
    this.lastResult = null;
    this.logs = [];
    this.chat = [];
    this.ctx = ctx;                      // { send(name,msg), online(name), getUser(name) }
  }

  /* ---------------- 基础信息 ---------------- */
  info() {
    return {
      id: this.id, title: this.title, host: this.host,
      sb: this.sb, bb: this.bb, buyIn: this.buyIn,
      status: this.status,
      handCount: this.game ? this.game.handCount : 0,
      seated: this.seats.filter(s => s.name).length,
      members: [...this.members].map(n => ({ name: n, online: this.ctx.online(n) }))
    };
  }
  brief() {
    return {
      id: this.id, title: this.title, host: this.host,
      sb: this.sb, bb: this.bb, status: this.status,
      seated: this.seats.filter(s => s.name).length,
      people: this.members.size
    };
  }
  pushLog(text, kind) {
    this.logs.push({ text, kind: kind || 'info', t: Date.now() });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
  }
  say(name, text) {
    text = String(text || '').slice(0, 120);
    if (!text) return;
    this.chat.push({ from: name, text, t: Date.now() });
    if (this.chat.length > 60) this.chat.shift();
  }
  seatOf(name) { return this.seats.findIndex(s => s.name === name); }
  inActiveHand(i) {
    const g = this.game;
    return !!(g && g.phase !== 'idle' && g.seats[i] && g.seats[i].inHand && !g.seats[i].folded);
  }

  /* ---------------- 成员进出 ---------------- */
  join(name) {
    this.members.add(name);
    this.pushLog(name + ' 进入房间', 'system');
    this.broadcast();
  }
  leave(name) {
    const i = this.seatOf(name);
    if (i >= 0) this.stand(name, true);
    this.members.delete(name);
    this.pushLog(name + ' 离开房间', 'system');
    // 房主走了就顺延给还在线的人
    if (this.host === name) {
      const next = [...this.members][0];
      this.host = next || null;
    }
    this.broadcast();
  }

  /* ---------------- 坐下 / 站起 / 补给 ---------------- */
  sit(name, seatIndex, amount) {
    if (seatIndex < 0 || seatIndex >= SEATS) return { error: '座位不存在' };
    const s = this.seats[seatIndex];
    if (s.name && s.name !== name) return { error: '这个座位已经有人了' };
    if (s.name === name) return { error: '你已经坐在这里了' };

    const cur = this.seatOf(name);
    if (cur >= 0) {
      const r = this.stand(name, true);
      if (r && r.error) return r;
    }
    const cap = this.bb * 200;
    let amt = Math.round(amount || this.buyIn);
    amt = Math.max(db.MIN_BUYIN, Math.min(Math.min(amt, cap), db.MAX_BUYIN));
    const u = this.ctx.getUser(name);
    if (!u) return { error: '账号不存在' };
    if (u.chips < amt) return { error: '账号余额不足（可用 ' + u.chips + '）' };

    db.addChips(name, -amt);
    s.name = name;
    s.chips = amt;
    s.leaveAfterHand = false;
    if (this.game) {
      const es = this.game.seats[seatIndex];
      es.name = name; es.chips = amt;
    }
    this.pushLog(name + ' 坐下，买入 ' + amt, 'system');
    this.broadcast();
    return { ok: true, amount: amt };
  }

  stand(name, force) {
    const i = this.seatOf(name);
    if (i < 0) return { error: '你还没有坐下' };
    const s = this.seats[i];
    const active = this.inActiveHand(i);
    if (active) {
      // 牌局进行中：先把自己从行动里摘出来（否则引擎会一直等这个 Promise）
      if (this.pending && this.pending.index === i) this.finishPending({ type: 'fold' });
      else if (this.game) this.game.seats[i].folded = true;
    }
    if (active && !force) {
      s.leaveAfterHand = true;              // 已投入的筹码留到本手结束，剩余筹码到时再退
      this.pushLog(name + ' 已弃牌，将在本手结束后离座', 'system');
      this.broadcast();
      return { ok: true, deferred: true };
    }
    this.refundSeat(i);
    this.broadcast();
    return { ok: true };
  }

  rebuy(name, amount) {
    const i = this.seatOf(name);
    if (i < 0) return { error: '你还没有坐下' };
    const s = this.seats[i];
    let amt = Math.round(amount || this.buyIn);
    amt = Math.max(db.MIN_BUYIN, Math.min(amt, db.MAX_BUYIN));
    const u = this.ctx.getUser(name);
    if (!u || u.chips < amt) return { error: '账号余额不足' };
    db.addChips(name, -amt);
    s.chips += amt;
    if (this.game) this.game.seats[i].chips += amt;   // 下一手生效
    this.pushLog(name + ' 补给 ' + amt + ' 筹码', 'system');
    this.broadcast();
    return { ok: true, chips: s.chips };
  }

  /** 牌局进行中时，座位上的 chips 是「本手开始时」的旧值，必须取引擎里的实时值 */
  liveChips(i) {
    const s = this.seats[i];
    if (!this.game) return s.chips;
    const es = this.game.seats[i];
    if (!es) return s.chips;
    return es.chips + (this.game.settled ? 0 : es.totalContrib);
  }

  /** 把桌上筹码退回账号并清空座位 */
  refundSeat(i) {
    const s = this.seats[i];
    if (!s.name) return;
    const amt = this.liveChips(i);
    const who = s.name;
    if (amt > 0) db.addChips(s.name, amt);
    s.name = null; s.chips = 0; s.leaveAfterHand = false;
    if (this.game) {
      const es = this.game.seats[i];
      es.chips = 0; es.name = ''; es.folded = true; es.inHand = false;
    }
    if (amt > 0) this.pushLog(who + ' 收下 ' + amt + ' 筹码，离开座位', 'system');
  }
  processLeaves() {
    this.seats.forEach((s, i) => { if (s.leaveAfterHand) this.refundSeat(i); });
  }
  refundAll() {
    this.seats.forEach((s, i) => { if (s.name) this.refundSeat(i); });
  }

  /* ---------------- 牌局 ---------------- */
  start(name) {
    if (name && this.host && name !== this.host) return { error: '只有房主可以开始牌局' };
    if (this.status === 'playing') return { error: '牌局已在进行中' };
    const ready = this.seats.filter(s => s.name && s.chips > 0);
    if (ready.length < 2) return { error: '至少需要 2 位玩家坐下并持有筹码' };

    this.status = 'playing';
    this.lastResult = null;
    this.pending = null;
    const cfg = {
      seats: this.seats.map(s => ({ name: s.name || '', type: 'human', chips: s.chips })),
      smallBlind: this.sb, bigBlind: this.bb, aiDelay: 0
    };
    this.game = new PokerEngine(cfg, this.hooks());
    this.pushLog('牌局开始 · 盲注 ' + this.sb + '/' + this.bb, 'system');
    this.broadcast();
    this.loop();
    return { ok: true };
  }

  stop(name) {
    if (name && this.host && name !== this.host) return { error: '只有房主可以结束牌局' };
    if (!this.game) return { error: '当前没有进行中的牌局' };
    this.status = 'waiting';
    if (this.pending) this.finishPending({ type: 'fold' });
    this.audit('stop前');
    this.game.abort();
    // 中止时把「剩余筹码 + 本手已投入」全部退回，避免筹码卡在池里
    // 注意：若本手已经结算过（settled），底池已分进筹码，就不能再退 totalContrib
    this.seats.forEach((s, i) => {
      if (!s.name || !this.game) return;
      const es = this.game.seats[i];
      const contrib = (es && !this.game.settled) ? es.totalContrib : 0;
      s.chips = (es ? es.chips : 0) + contrib;
      if (es) es.totalContrib = 0;
    });
    this.audit('stop后');
    this.pushLog('房主结束了牌局，本手作废、投入已退回', 'system');
    return { ok: true };
  }

  hooks() {
    const self = this;
    return {
      onLog: (text, kind) => self.pushLog(text, kind),
      onUpdate: () => self.broadcast(),
      onDeal: () => self.broadcast(),
      onTurn: () => self.broadcast(),
      requestAction: (p, legal) => self.waitAction(p, legal),
      onHandEnd: (result) => self.onHandEnd(result)
    };
  }

  waitAction(p, legal) {
    const self = this;
    return new Promise(resolve => {
      self.pending = {
        index: p.index, name: p.name, legal,
        resolve, deadline: Date.now() + ACTION_TIMEOUT
      };
      self.pending.timer = setTimeout(() => self.timeoutAction(), ACTION_TIMEOUT);
      self.broadcast();
    });
  }

  finishPending(action) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const resolve = this.pending.resolve;
    this.pending = null;
    resolve(action || { type: 'fold' });
    this.broadcast();
  }

  timeoutAction() {
    if (!this.pending) return;
    const legal = this.pending.legal;
    const name = this.pending.name;
    this.pushLog(name + ' 超时未操作，自动' + (legal.toCall > 0 ? '弃牌' : '过牌'), 'system');
    this.finishPending(legal.toCall > 0 ? { type: 'fold' } : { type: 'check' });
  }

  /** 玩家掉线：如果在等他行动，把等待时间压缩到 12 秒 */
  onDisconnect(name) {
    if (!this.pending || this.pending.name !== name) return;
    const left = this.pending.deadline - Date.now();
    const wait = Math.min(left, 12000);
    clearTimeout(this.pending.timer);
    this.pending.deadline = Date.now() + wait;
    this.pending.timer = setTimeout(() => this.timeoutAction(), Math.max(500, wait));
    this.broadcast();
  }

  submitAction(name, action) {
    if (!this.pending) return { error: '现在不是你的行动时机' };
    if (this.pending.name !== name) return { error: '还没轮到你' };
    if (!action || typeof action !== 'object') return { error: '无效的操作' };
    const ok = ['fold', 'check', 'call', 'raise', 'allin'];
    if (ok.indexOf(action.type) < 0) return { error: '无效的操作' };
    this.finishPending({ type: action.type, total: action.total });
    return { ok: true };
  }

  async onHandEnd(result) {
    this.syncChips();
    this.seats.forEach((s, i) => {
      if (!s.name || !this.game) return;
      const es = this.game.seats[i];
      if (es && es.inHand) db.recordHand(s.name, es.won);
    });
    this.lastResult = result;
    this.processLeaves();
    this.broadcast();
    await sleep(RESULT_SHOW_MS);
    this.lastResult = null;
    this.broadcast();
  }

  syncChips() {
    if (!this.game) return;
    this.seats.forEach((s, i) => {
      if (s.name) s.chips = this.game.seats[i].chips;
    });
  }
  /** 自检：引擎内筹码合计（调试用，可通过 DEBUG_CHIPS=1 打开） */
  audit(tag) {
    if (!process.env.DEBUG_CHIPS) return;
    const inEngine = this.game ? this.game.seats.reduce((a, s) => a + s.chips, 0) : 0;
    const pot = this.game ? this.game.potSize() : 0;
    const atTable = this.seats.reduce((a, s) => a + this.liveChips(s.index), 0);
    console.log('[audit ' + this.id + '] ' + tag +
      ' 引擎筹码=' + inEngine + ' 池=' + pot + ' 引擎合计=' + (inEngine + pot) +
      ' 座位视图合计=' + atTable + (this.game ? ' settled=' + this.game.settled : ''));
  }

  async loop() {
    try {
      while (this.status === 'playing' && this.game && !this.game.finished && !this.game.aborted) {
        const ready = this.seats.filter(s => s.name && s.chips > 0);
        if (ready.length < 2) break;
        this.audit('第' + (this.game.handCount + 1) + '手前');
        await this.game.startHand();
        this.audit('第' + this.game.handCount + '手后');
        // 中止时不把引擎的值覆盖回座位（stop() 已经做过退回结算了），但仍要处理待离座
        if (this.game && !this.game.aborted) this.syncChips();
        this.processLeaves();
      }
      this.processLeaves();
    } catch (e) {
      console.error('[room ' + this.id + '] 牌局异常：', e);
      this.pushLog('牌局异常已终止：' + e.message, 'system');
    }
    this.status = 'waiting';
    this.game = null;
    this.pending = null;
    this.broadcast();
  }

  /* ---------------- 视图 ---------------- */
  stateFor(name) {
    const g = this.game;
    const mySeat = this.seatOf(name);
    const showdown = !!this.lastResult;

    const seats = this.seats.map((s, i) => {
      const es = g ? g.seats[i] : null;
      const mine = s.name === name;
      const reveal = !!es && (mine || (showdown && !es.folded && es.inHand));
      return {
        i,
        name: s.name,
        chips: this.liveChips(i),     // 牌局中用引擎实时值，避免显示「本手开始时」的旧筹码
        bet: es ? es.bet : 0,
        folded: es ? es.folded : false,
        allIn: es ? es.allIn : false,
        inHand: es ? es.inHand : false,
        lastAction: es ? es.lastAction : '',
        connected: s.name ? this.ctx.online(s.name) : false,
        leaveAfterHand: !!s.leaveAfterHand,
        hole: reveal ? es.hole : null,
        hand: (showdown && es && es.hand && !es.folded) ? es.hand.name : null,
        won: es ? es.won : 0
      };
    });

    let you = { seat: mySeat, account: 0, tableChips: 0, hole: null, hand: null, act: null };
    const u = this.ctx.getUser(name);
    if (u) you.account = u.chips;
    if (mySeat >= 0) {
      you.tableChips = this.liveChips(mySeat);
      you.leaveAfterHand = this.seats[mySeat].leaveAfterHand;
      if (g && g.seats[mySeat] && g.seats[mySeat].hole.length === 2) {
        you.hole = g.seats[mySeat].hole;
        if (g.board.length >= 3) {
          you.hand = Cards.evaluate(g.seats[mySeat].hole.concat(g.board)).name;
        }
      }
    }
    if (this.pending && this.pending.name === name) {
      you.act = { legal: this.pending.legal, deadline: this.pending.deadline };
    }

    return {
      phase: g ? g.phase : 'idle',
      phaseName: g ? g.phaseName() : '',
      handCount: g ? g.handCount : 0,
      pot: g ? g.potSize() : 0,
      board: g ? g.board : [],
      buttonIdx: g ? g.buttonIdx : -1,
      sbIdx: g ? g.sbIdx : -1,
      bbIdx: g ? g.bbIdx : -1,
      currentIdx: g ? g.currentIdx : -1,
      seats, you
    };
  }

  broadcast() {
    const info = this.info();
    const payload = {
      type: 'state',
      room: info,
      result: this.lastResult,
      logs: this.logs.slice(-80),
      chat: this.chat.slice(-30)
    };
    for (const name of this.members) {
      this.ctx.send(name, Object.assign({}, payload, { table: this.stateFor(name) }));
    }
  }
}

module.exports = { Room, SEATS, ACTION_TIMEOUT };
