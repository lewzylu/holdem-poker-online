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
// 一手结束后保留「摊牌态」（公共牌 + 各家底牌 + 牌型）的时长，之后才进入下一手。
// 摊牌需要看清每个人的牌与最终牌型，停留久一些；其余人弃牌收池没什么可看的，短一些。
const RESULT_SHOW_SHOWDOWN_MS = 9000;
const RESULT_SHOW_FOLD_MS = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 机器人（托管座位）：随机出手的练习对手，不接 WebSocket，由房间自己驱动 */
const BOT_THINK_MIN = 700;      // 「思考」时长下限（毫秒）
const BOT_THINK_MAX = 2400;     // 上限：随机取值，避免三个人节奏一致像脚本
const BOT_REBUY_BB = 4;         // 身后不足 4 个大盲就自动补码

/** 机器人随机出手。legal 是引擎给的合法动作集合（engine.legalActions）。
 *  策略刻意做得很浅：练习房要的是「牌局一直有动静」，不是会算牌的对手。
 *  可过牌 → 以过牌为主、间或加注 1/3 底池；被下注 → 跟注/加注/弃牌按概率随机，偶尔全下。
 *  返回值还会被引擎 sanitize 校正，所以不用纠结边界（加注额不够会被夹成最小加注）。 */
function pickBotAction(legal) {
  if (!legal) return { type: 'fold' };
  const r = Math.random();
  const canRaise = !!legal.canRaise;
  if (legal.canCheck) {
    if (canRaise && r < 0.4) return { type: 'raise', total: thirdPotTotal(legal) };
    return { type: 'check' };
  }
  if (canRaise && r < 0.25) return { type: 'raise', total: thirdPotTotal(legal) };
  if (r < 0.5) return { type: 'fold' };
  if (r < 0.53) return { type: 'allin' };   // 全下留小概率：牌局要有波动，但不能每手都推
  return { type: 'call' };
}

/** 「加注 1/3 底池」对应的目标下注额：本轮最高注 + 底池的 1/3，再夹进合法区间。
 *  底池很小时 1/3 池可能低于最小加注，交给夹取逻辑兜成最小加注即可。 */
function thirdPotTotal(legal) {
  const total = (legal.roundBet || 0) + Math.round((legal.pot || 0) / 3);
  const min = legal.minTotal || 0, max = legal.maxTotalBet || 0;
  if (min && total < min) return min;
  if (max && total > max) return max;
  return total;
}

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
      this.seats.push({ index: i, name: null, chips: 0, bot: false, leaveAfterHand: false, pendingRebuy: 0 });
    }
    this.members = new Set();            // 房间内所有人（含旁观）
    this.status = 'waiting';             // waiting | playing
    this.game = null;
    this.pending = null;
    this.lastResult = null;
    // 结算结果的单调递增序号：前端靠它判定「这是一次新的结算」。
    // 不能用 handCount 代替 —— 重开一局后手数从 1 重新数，会和上一局的第 1 手撞车，
    // 前端会误判成「已经播过」而漏掉结算动画。
    this._resultSeq = 0;
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
      // 机器人没有连接，但它在场且会出手，按在线算：否则房间会显示「0/3 人在线」
      members: [...this.members].map(n => ({ name: n, online: this.isBot(n) || this.ctx.online(n) }))
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

  /* ---------------- 机器人座位 ----------------
   * 机器人是「房间自己驱动」的座位：没有 WebSocket 连接，轮到它时由 botDecide()
   * 在一段随机延时后替它提交动作。其余流程（下注、摊牌、结算、广播）与真人完全一致。 */
  isBot(name) {
    return this.seats.some(s => s.bot && s.name === name);
  }

  /** 机器人入座。走正常 sit()（同样从账号扣买入、同样占位），额外打上 bot 标记。
   *  标记之后只影响两件事：决策由谁给（botDecide 而非玩家消息），以及掉线判定。 */
  addBot(name, seatIndex, amount) {
    const r = this.sit(name, seatIndex, amount);
    if (r.error) return r;
    this.seats[seatIndex].bot = true;
    return r;
  }

  /** 机器人补码：身后筹码不够打了就补到买入额，牌局因此永远不会因为机器人破产而停。
   *  牌局进行中不能直接加进引擎（否则等于拿新钱在本手加注），记进 pendingRebuy，
   *  由 applyPendingRebuys() 在下一手开始前并入 —— 与真人 rebuy 同一套规则。 */
  botRebuy() {
    const floor = this.bb * BOT_REBUY_BB;
    let refilled = false;
    this.seats.forEach((s, i) => {
      if (!s.name || !s.bot || s.chips >= floor) return;
      const need = this.buyIn - s.chips;
      if (need <= 0) return;
      // 机器人账号见底时自动充值：练习房要能一直跑，不能因为账号没钱就停摆
      if (!db.addChips(s.name, -need) && db.addChips(s.name, db.BOT_BANKROLL)) db.addChips(s.name, -need);
      s.chips += need;
      if (this.game) s.pendingRebuy = (s.pendingRebuy || 0) + need;
      this.pushLog(s.name + ' 自动补给 ' + need + ' 筹码' + (this.game ? '（下一手生效）' : ''), 'system');
      refilled = true;
    });
    if (refilled) this.broadcast();
    return refilled;
  }

  /** 一手结算后立刻给输光的机器人补码，直接写进引擎（本手已结算，不影响本手下注）。
   *  必须赶在引擎判定「桌上剩不到 2 人有筹码 ⇒ 整局结束」之前：engine.finishHand 是在
   *  onHandEnd 返回**之后**才做这个判定。不补的话，只要两个机器人同时输光，
   *  整局就被判结束，牌桌要等守护 5 秒重开 —— 玩家看到的是牌局莫名断一下、手数归零。 */
  botRefillNow() {
    const g = this.game;
    if (!g) return;
    let refilled = false;
    this.seats.forEach((s, i) => {
      if (!s.name || !s.bot) return;
      const es = g.seats[i];
      if (!es || es.chips > 0) return;
      const need = this.buyIn - es.chips;
      if (need <= 0) return;
      // 机器人账号见底时自动充值：练习房要能一直跑，不能因为账号没钱就停摆
      if (!db.addChips(s.name, -need) && db.addChips(s.name, db.BOT_BANKROLL)) db.addChips(s.name, -need);
      es.chips += need;
      s.chips = es.chips;
      this.pushLog(s.name + ' 筹码见底，自动补给 ' + need, 'system');
      refilled = true;
    });
    if (refilled) this.broadcast();
  }

  /** 机器人出手：从合法动作里随机挑一个提交。动作仍会经过引擎 sanitize，
   *  所以「该加注却没筹码」这类边界不需要在这里处理。 */
  botDecide() {
    if (!this.pending) return;
    const s = this.seats[this.pending.index];
    if (!s || !s.bot) return;
    this.finishPending(pickBotAction(this.pending.legal));
  }

  /** 牌局进行中时，座位上的 chips 是「本手开始时」的旧值，必须取引擎里的实时值；
   *  还没并入引擎的补给（pendingRebuy）也要算进去，那是已经从账号扣掉的真钱。
   *  这个值含「已进底池的 totalContrib」，是玩家在这张桌上的**总身家**，
   *  用于退桌结算/审计（钱不能凭空消失）—— 不要用它做座位显示。 */
  liveChips(i) {
    const s = this.seats[i];
    if (!this.game) return s.chips + (s.pendingRebuy || 0);
    const es = this.game.seats[i];
    if (!es) return s.chips + (s.pendingRebuy || 0);
    return es.chips + (this.game.settled ? 0 : es.totalContrib) + (s.pendingRebuy || 0);
  }

  /** 座位显示用的「身后剩余筹码」：只算还在手里、没进池的那部分，会随下注实时减少。
   *  与 liveChips 的唯一区别是**不加 totalContrib** —— 加了的话
   *  身后 + 已下注 = 本手开始时的总额，座位数字就永远停在开局值不动了
   *  （这正是「剩余筹码显示成开场筹码」的根因）。已下注的部分由座位的 .bet 单独显示。 */
  displayChips(i) {
    const s = this.seats[i];
    if (!this.game) return s.chips + (s.pendingRebuy || 0);
    const es = this.game.seats[i];
    if (!es) return s.chips + (s.pendingRebuy || 0);
    return es.chips + (s.pendingRebuy || 0);
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
      // 超时定时器照常挂着：万一 botDecide 没跑起来，牌局也不会被永久卡住
      self.pending.timer = setTimeout(() => self.timeoutAction(), ACTION_TIMEOUT);
      const s = self.seats[p.index];
      if (s && s.bot) {
        // 机器人不给 30 秒思考，短随机延时后自动出手。延时随机是为了避免
        // 三个机器人每手都在同一拍上出手，看起来像脚本在同步跑。
        const delay = BOT_THINK_MIN + Math.floor(Math.random() * (BOT_THINK_MAX - BOT_THINK_MIN));
        self.pending.botTimer = setTimeout(() => self.botDecide(), delay);
      }
      self.broadcast();
    });
  }

  finishPending(action) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    clearTimeout(this.pending.botTimer);
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
    this.botRefillNow();     // 赶在引擎判定「整局结束」之前把输光的机器人补上
    this.seats.forEach((s, i) => {
      if (!s.name || !this.game) return;
      const es = this.game.seats[i];
      if (es && es.inHand) db.recordHand(s.name, es.won);
    });
    result.seq = ++this._resultSeq;
    this.lastResult = result;
    this.processLeaves();
    this.broadcast();
    // 摊牌停留久一点（看清各家牌），弃牌收池快一点
    await sleep(result && result.reason === 'showdown' ? RESULT_SHOW_SHOWDOWN_MS : RESULT_SHOW_FOLD_MS);
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
        this.botRebuy();                    // 机器人筹码见底先补上（补的也走 pendingRebuy）
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
        bot: !!s.bot,                 // 托管座位：前端据此标注 AI，玩家一眼能分清谁是人
        chips: this.displayChips(i),  // 座位显示「身后剩余」，随下注实时减少（不含已进池部分）
        bet: es ? es.bet : 0,
        // 本座位当前还需跟多少才能跟上本轮最高注（0 = 已跟平/可过牌）。
        // 只在牌局进行中有意义，让前端能标出「谁还欠注、欠多少」。
        toCall: (es && es.inHand && !es.folded && !es.allIn && g && g.phase !== 'idle')
          ? Math.max(0, (g.roundBet || 0) - es.bet) : 0,
        folded: es ? es.folded : false,
        allIn: es ? es.allIn : false,
        inHand: es ? es.inHand : false,
        lastAction: es ? es.lastAction : '',
        // 动作序号：前端比较它的变化来判定「这是一次新动作」，进而触发 3 秒反馈。
        actionSeq: this._actionSeq[i],
        // 该动作是否由超时自动处置产生，用于把它与玩家主动做出的同类动作区分开。
        // 与序号绑定，因此只要前端看到的还是这一次动作，这个归属就一直成立。
        byTimeout: this._timeoutSeq[i] === this._actionSeq[i] && this._actionSeq[i] > 0,
        connected: s.name ? (!!s.bot || this.ctx.online(s.name)) : false,
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
      you.tableChips = this.displayChips(mySeat);   // 身后剩余，与座位显示一致
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
