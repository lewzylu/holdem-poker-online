- [x] 1. 侧栏悬浮化（app.css / lobby 无关，仅牌桌页）
  - [x] 1.1 `.layout` 单列；`.side` 绝对定位右侧（宽 300、半透明面板、z-index 高于画布），桌面默认展开、btn-panel 可收起；小屏保持抽屉行为
  - [x] 1.2 侧栏内容精简：移除座位表（与桌面重复），保留牌局记录 + 聊天；侧栏标题与滚动区适配新高度
  - [x] 1.3 桌面断点下侧栏收起状态可切换（复用 .side.open 逻辑），open 状态存 localStorage

- [x] 2. 操作条右下浮层（app.css）
  - [x] 2.1 宽屏媒体查询：`.action-bar` 绝对定位 table-wrap 右下（clamp(150px,14vw,190px) 竖条），复用矮屏竖条的排布规则（计时在顶、滑杆全宽、按钮两列）
  - [x] 2.2 矮屏分支保留现状（浮层仅宽屏）；确认两分支规则不互相污染
  - [x] 2.3 visual-check 新增断言：操作条不压任何座位卡/底牌；触摸目标断言保持通过

- [x] 3. 本人手牌 1.2x（table.js / table.css）
  - [x] 3.1 renderSeats：mine 座位 hole 牌输出 `small big` class；对手不变
  - [x] 3.2 `.card.small.big` 尺寸 58×80、rank 37px（two-char 30px）、`.seat.mine --hole-peek: 26px`
  - [x] 3.3 几何验证：底边 0-1/0-2 余量 ≥ 15 逻辑像素（layout-test 实测），不足则收 peek

- [x] 4. 断言改写
  - [x] 4.1 table.css "等大"注释改写为"对手等大 × 1.2（GG 式）"，注明破坏原因与决策
  - [x] 4.2 layout-test：尺寸统一断言归一化剥离 big；新增"big 仅出现于本人座位"
  - [x] 4.3 visual-check："本人与对手等大"改为"本人 ≈ 对手 × 1.2（±0.5px）"
  - [x] 4.4 visual-check：新增 1440×900 档 tscale ≥ 1.10 回归守卫

- [x] 5. 回归与验收
  - [x] 5.1 全套：e2e / edge / nav / layout / ux(A–I) / visual-check / render-check
  - [x] 5.2 真实浏览器截图验收：桌面宽屏（牌桌全幅 + 右下操作条 + 侧栏悬浮 + 大手牌）、手机横屏、竖屏；侧栏收起/展开各一张
  - [x] 5.3 满桌防重叠目检（私房拉 9 人或练习房满员时段）
