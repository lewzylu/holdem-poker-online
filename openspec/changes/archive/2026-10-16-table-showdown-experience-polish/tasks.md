- [x] 1. 获胜横幅结构与样式
  - [x] 1.1 `table.html` 在 `.table-canvas` 下加 `#win-banner` 浮层容器（与 #seats 平级，不随座位重建）
  - [x] 1.2 `table.css` 加 `.win-banner` 样式：桌面中央、board 上方、pointer-events:none、入场/退场动画；`.mine` 金色高亮态
  - [x] 1.3 `table.js` render() 中依据 `state.result` 渲染横幅内容：赢家列表 + 金额；摊牌匹配 `revealed[].hand.name`；`reason==='fold'` 显示「无人摊牌 · 其余人弃牌」；多赢家并列

- [x] 2. 展示期提示文案
  - [x] 2.1 `renderActions` 的 `currentIdx<0` 分支：`state.result` 存在时显示「下一手即将开始…」，消除与「摊牌」阶段标签的矛盾

- [x] 3. 最后 5 秒紧迫提示
  - [x] 3.1 `startTimer()` tick 内实现整秒滴答：跨入 ≤5s 的秒跳变时 `playTick()`，同秒只响一次（记录上次响的秒数）
  - [x] 3.2 `playTick()`：约 30ms 短音，音量低于轮到提示音；走既有 `audio()`（静音/无 AudioContext 自动退化）
  - [x] 3.3 `.timer` 与 `.seat-sec` 的 `t-urgent` 态加 CSS 脉冲动画；act 消失时随既有清除路径停止
  - [x] 3.4 确认滴答只挂本人倒计时（`startTimer` 只在 you.act 时启动，天然满足；验证对手座位不响）

- [x] 4. 桌心底池筹码堆
  - [x] 4.1 `table.css` 加 `.pot-stack`：absolute 浮层挂 `.table-top` pot 旁，复用 `.chip-fly` 金色视觉；按金额分 0/3/5/7 枚与配色
  - [x] 4.2 `table.js` render() 中按 `t.pot` 重建筹码堆 DOM；pot=0 时消失

- [x] 5. 赢家筹码数字弹跳
  - [x] 5.1 render() 保存上一帧各座位筹码快照；结算帧（result 存在）对 `won>0` 座位在 innerHTML 重建后对 `.chips` 用 Web Animations API 触发一次性 scale 弹跳

- [x] 6. 筹码金额缩写
  - [x] 6.1 `common.js` 的 `UI.fmt`：`n>=10000` 输出 `x.xK`（去尾零）；否则维持千分位
  - [x] 6.2 侧栏「座位」明细表改用精确格式（不走 UI.fmt），保留审计语义
  - [x] 6.3 检查下注滑杆、prompt「需跟注」等精确值路径不受缩写影响

- [x] 7. 对手下注轻音效
  - [x] 7.1 `trackActions()` 登记新动作时：座位非本人且 `lastAction` 匹配 `/跟注|加注/` 时 `playBetSound()`（clink 一声，音量 ≈ 归池声 2/3）
  - [x] 7.2 盲注（「小盲/大盲」文案）与过牌/弃牌天然不匹配正则；自己的动作不响

- [x] 8. 测试与回归
  - [x] 8.1 `ux-test.js` 新增 H 组：私房打「弃牌收池 + 摊牌」两手，断言横幅出现/内容/牌型/无人摊牌标注、展示期 prompt、新手开始横幅消失、我赢高亮
  - [x] 8.2 H 组紧迫提示：第二手 B 挂 26s 制造 <5s 窗口，轮询座位倒计时出现 urgent 脉冲类、全程无 JS 错误（jsdom 无音频，声音静默退化由 D 组覆盖）
  - [x] 8.3 `visual-check.js` 加横幅与筹码堆几何断言：不压顶边席位、不遮公共牌与底牌
  - [x] 8.4 全套回归：e2e / edge / nav / layout / ux(A–H) / visual-check 全绿
  - [x] 8.5 真实浏览器对局试听与截图：横幅、筹码堆、滴答节奏、下注声密度过审
