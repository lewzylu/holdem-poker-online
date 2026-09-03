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
      this.seats.push({ index: i, name: null, chips: 0, leaveAfterHand: false, pendingRebuy: 0 });
    }
    this.members = new Set();            // 房间内所有人（含旁观）
    this.status = 'waiting';             // waiting | playing
    this.game = null;
    this.pending = null;
    this.lastResult = null;
    this.epoch = 0;                      // 第几「局」：用来区分先后两局，防止旧 loop 收尾清掉新局状态
    this._bcQueued = false;              // 广播合并标记
    // 动作序号：前端靠「序号变化」判定这是一次新动作，从而触发动作反馈。
    // 不能让前端比较动作文案 —— 同一轮里两个人都可能是「跟注 50」。
    // 序号在视图生成侧（stateFor）通过对比 lastAction 快照递增，不在引擎里生成：
    // 引擎会把玩家提交的动作合法化改写（过牌→跟注、超额加注→夹到上限），
    // 只有改写完成后的文案才是玩家真正看到的结果。
    this._actionSeq = new Array(SEATS).fill(0);
    this._lastActionSnap = new Array(SEATS).fill('');
    // 超时标记按「座位 -> 该动作的序号」记录，而不是记一个易逝的当前座位号。
    // 原因：超时弃牌后往往紧接着摊牌、开下一手，下一次 waitAction 会把标记清掉，
    // 中间可能只隔几百毫秒。前端的反馈要驻留 3 秒，若标记比反馈先消失，
    // 前端就会在反馈还挂着的时候丢掉「这是超时」这个信息。
    // 绑定到序号后，只要前端看到的是这一次动作，就一定能看到它的超时归属。
    this._timeoutSeq = new Array(SEATS).fill(-1);
    this._pendingTimeoutSeat = -1;       // 已判超时、等引擎把动作落定的座位
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
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEATS) return { error: '座位不存在' };
    const s = this.seats[seatIndex];
    if (s.name && s.name !== name) return { error: '这个座位已经有人了' };
    if (s.name === name) return { error: '你已经坐在这里了' };

    const cur = this.seatOf(name);
    if (cur >= 0) {
      const r = this.stand(name, true);
      if (r && r.error) return r;
    }
    const u = this.ctx.getUser(name);
    if (!u) return { error: '账号不存在' };
    // 余额不足最低买入时按「全部身家」上桌：否则余额 < MIN_BUYIN 的账号会永远坐不下来
    const floor = Math.min(db.MIN_BUYIN, u.chips);
    const cap = Math.min(this.bb * 200, db.MAX_BUYIN);
    let amt = Math.round(Number(amount) || this.buyIn);
    amt = Math.max(floor, Math.min(amt, cap));
    if (amt <= 0 || u.chips < amt) return { error: '账号余额不足（可用 ' + u.chips + '）' };

    db.addChips(name, -amt);
    s.name = name;
    s.chips = amt;
    s.leaveAfterHand = false;
    s.pendingRebuy = 0;
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
    // 牌局进行中不能直接加进引擎（否则玩家能拿新钱在本手继续加注）。
    // 先记在 pendingRebuy 上，下一手开始前由 applyPendingRebuys() 并入引擎。
    // 这段时间座位的显示值由 liveChips() 补上，钱不会凭空消失。
    if (this.game) s.pendingRebuy = (s.pendingRebuy || 0) + amt;
    this.pushLog(name + ' 补给 ' + amt + ' 筹码' + (this.game ? '（下一手生效）' : ''), 'system');
    this.broadcast();
    return { ok: true, chips: s.chips };
  }

  /** 牌局进行中时，座位上的 chips 是「本手开始时」的旧值，必须取引擎里的实时值；
   *  还没并入引擎的补给（pendingRebuy）也要算进去，那是已经从账号扣掉的真钱。 */
  liveChips(i) {
    const s = this.seats[i];
    if (!this.game) return s.chips + (s.pendingRebuy || 0);
    const es = this.game.seats[i];
    if (!es) return s.chips + (s.pendingRebuy || 0);
    return es.chips + (this.game.settled ? 0 : es.totalContrib) + (s.pendingRebuy || 0);
  }

  /** 把牌局中补给的筹码并入引擎，只在下一手开始前调用 */
  applyPendingRebuys() {
    if (!this.game) return;
    this.seats.forEach((s, i) => {
      if (!s.name || !s.pendingRebuy) return;
      const es = this.game.seats[i];
      if (es) es.chips += s.pendingRebuy;
      s.pendingRebuy = 0;
    });
  }

  /** 把桌上筹码退回账号并清空座位 */
  refundSeat(i) {
    const s = this.seats[i];
    if (!s.name) return;
    const amt = this.liveChips(i);
    const who = s.name;
    if (amt > 0) db.addChips(s.name, amt);
    s.name = null; s.chips = 0; s.leaveAfterHand = false; s.pendingRebuy = 0;
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

    this.epoch++;                        // 新一局：让上一局还在收尾的 loop 不要碰这份状态
    const epoch = this.epoch;
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
    this.loop(epoch);
    return { ok: true };
  }

  stop(name) {
    if (name && this.host && name !== this.host) return { error: '只有房主可以结束牌局' };
    if (!this.game) {
      // loop 收尾时会先把 game 置空：这时状态也要跟着回到 waiting，否则房主点不动任何按钮
      this.status = 'waiting';
      return { error: '当前没有进行中的牌局' };
    }
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
      // 待入账的补给也要一起退回，否则玩家补给完遇上房主结束牌局，这笔钱就没了
      s.chips = (es ? es.chips : 0) + contrib + (s.pendingRebuy || 0);
      s.pendingRebuy = 0;
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
      // 这里不要清超时标记：标记已经和「那一次动作的序号」绑定了，
      // 它会随下一次动作产生新序号而自然失效，清反而会让前端在反馈还挂着时丢掉归属。
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
    // 标记这个座位的下一个动作是「超时自动处置」，供前端把它与主动动作区分开。
    // 只在超时这一条路径上打标记：finishPending 还会被 stand()/stop()/destroy() 调用，
    // 那些不是玩家动作，标记了会产生虚假的「超时」反馈。
    this._pendingTimeoutSeat = this.pending.index;
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

  async loop(epoch) {
    // epoch：区分先后两局。牌局结束有 6.5 秒的结算展示（onHandEnd 里的 sleep），
    // 玩家在这段时间里点「结束 → 开始」，旧 loop 还在睡；它醒来后看到的是**新一局**的
    // this.game，若不认 epoch 就会和新 loop 一起驱动同一个引擎：重复发帖、pending 被覆盖、
    // 玩家点了按钮却被丢弃，最后干等 30 秒判超时。
    try {
      while (epoch === this.epoch && this.status === 'playing' && this.game &&
             !this.game.finished && !this.game.aborted) {
        this.applyPendingRebuys();          // 上一手中的补给在这一手生效
        const ready = this.seats.filter(s => s.name && s.chips > 0);
        if (ready.length < 2) break;
        this.audit('第' + (this.game.handCount + 1) + '手前');
        await this.game.startHand();
        // 上面这一步可能睡了 6.5 秒。醒来时若已经换了新一局，this.game 是新引擎，
        // 下面的同步与收尾一行都不能做，否则就是和新 loop 抢同一个引擎。
        if (epoch !== this.epoch) return;
        this.audit('第' + this.game.handCount + '手后');
        // 中止时不把引擎的值覆盖回座位（stop() 已经做过退回结算了），但仍要处理待离座
        if (this.game && !this.game.aborted) this.syncChips();
        this.processLeaves();
      }
      if (epoch !== this.epoch) return;
      this.processLeaves();
    } catch (e) {
      console.error('[room ' + this.id + '] 牌局异常：', e);
      this.pushLog('牌局异常已终止：' + e.message, 'system');
    }
    // 只有「当前这一局」才有权收尾，否则会把新一局的引擎清成 null、状态重置回 waiting
    if (epoch !== this.epoch) return;
    this.status = 'waiting';
    this.game = null;
    this.pending = null;
    this.broadcast();
  }

  /** 房间要被销毁时调用：中止牌局、解除挂起的行动等待。
   *  不这么做的话 loop 还挂在 waitAction 的 Promise 上，房间删了牌局仍在空转，
   *  整个 Room 也会被闭包一直持有到那手牌自然结束。 */
  destroy() {
    this.status = 'waiting';
    this.finishPending({ type: 'fold' });
    if (this.game) this.game.abort();
  }

  /* ---------------- 视图 ---------------- */

  /** 探测哪些座位产生了新动作，并递增其序号。
   *
   *  必须在每次广播前**只调用一次**：stateFor 是按人生成视图的（9 人桌会调 9 次），
   *  把探测写在 stateFor 里会让同一个动作被计数多次，序号直接失真。
   *
   *  判定方式是对比引擎里的 lastAction 快照。为什么用引擎的值而不是玩家提交的值：
   *  引擎会把动作合法化改写（提交「过牌」但需要跟注时会变成「跟注」），
   *  只有改写后的结果才是玩家真正看到的，序号必须与它对齐。 */
  syncActionSeq() {
    const g = this.game;
    for (let i = 0; i < SEATS; i++) {
      const cur = (g && g.seats[i]) ? (g.seats[i].lastAction || '') : '';
      if (cur !== this._lastActionSnap[i]) {
        this._lastActionSnap[i] = cur;
        // 只有「产生了动作」才递增；清空（新一手开始时 lastAction 被重置为 ''）不算动作，
        // 否则每手牌开始都会给所有座位推一次空反馈。
        if (cur) {
          this._actionSeq[i]++;
          // 若这个座位刚被判过超时，把超时归属绑定到这一次的序号上
          if (this._pendingTimeoutSeat === i) {
            this._timeoutSeq[i] = this._actionSeq[i];
            this._pendingTimeoutSeat = -1;
          }
        }
      }
    }
  }

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
        // 动作序号：前端比较它的变化来判定「这是一次新动作」，进而触发 3 秒反馈。
        actionSeq: this._actionSeq[i],
        // 该动作是否由超时自动处置产生，用于把它与玩家主动做出的同类动作区分开。
        // 与序号绑定，因此只要前端看到的还是这一次动作，这个归属就一直成立。
        byTimeout: this._timeoutSeq[i] === this._actionSeq[i] && this._actionSeq[i] > 0,
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
      // 行动截止时间与行动者座位，对房间内所有人公开。
      // 以前 deadline 只写在 you.act 里，于是只有行动者本人算得出剩余时间，
      // 别人连「还剩多久」都不知道，只能干等。
      // 公开它是安全的：不含底牌等私密信息，且「谁在行动」本来就是公开的；
      // 藏着反而造成没有正当理由的信息不对称。
      // 无人待行动时为 null，避免前端拿着上一次的旧值继续倒数。
      actDeadline: this.pending ? this.pending.deadline : null,
      actSeat: this.pending ? this.pending.index : -1,
      actTimeout: ACTION_TIMEOUT,   // 让前端按同一时长算进度比例，不必自己写死 30000
      seats, you
    };
  }

  /** 同一 tick 内的多次 broadcast 合并成一次。
   *  一个下注回合会连续触发 onTurn / onUpdate / onDeal，每个都全量序列化
   *  （80 条日志 + 30 条聊天 + N 份座位视图），9 人桌一手牌就是 70 多次全量广播。
   *  合并后在下一个 setImmediate 统一发一次，客户端无感，CPU 省一大截。
   *
   *  已知限制（刻意接受，不是缺陷）：同一 tick 内连续产生的两个动作会被合并成一条状态，
   *  前端只能观测到最后一个，中间那个的动作反馈会丢。
   *  真实玩家的动作之间有网络往返，落不到同一 tick；会落到同一 tick 的是
   *  同步连续执行的小盲与大盲。因此盲注不作为「需要闪现反馈的动作」处理
   *  （引擎给盲注写的 lastAction 会被 syncActionSeq 计入序号，但两条盲注合并后
   *  只剩大盲一条，这是可接受的：盲注是规则强制的，玩家不需要被提醒）。
   *  若将来要让盲注也逐条可见，应当改成按动作排队推送，而不是回退这里的合并
   *  —— 那会让 9 人桌的广播量回到 70 多次。 */
  broadcast() {
    if (this._bcQueued) return;
    this._bcQueued = true;
    setImmediate(() => { this._bcQueued = false; this.flush(); });
  }

  flush() {
    // 必须在生成任何人的视图之前调用，且每次广播只调一次（stateFor 是按人调的）
    this.syncActionSeq();
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
