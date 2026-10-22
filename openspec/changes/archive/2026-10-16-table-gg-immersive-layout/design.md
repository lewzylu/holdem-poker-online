## Context

现状：`.layout` 为两列 grid（主区 + 320px 侧栏），action-bar 是主区 flex 底部的横条（吃 ~120px 高度）。1440×900 下 table-fit ≈ 1084×692 → tscale 0.903（宽度受限）。矮屏（高 ≤600）已有"主区横向 + 操作条右侧竖条"分支，本变更把右下浮层推广到全尺寸。

## Goals / Non-Goals

- Goals：tscale 宽屏 ≥ 1.17（+30%）；操作条右下且触摸目标不变；本人手牌 1.2x 且余量安全
- Non-Goals：竖屏旋转方案不动；矮屏现有 flex 分支保留（浮层仅宽屏启用，小屏空间吃不起）；牌面雪碧图与五槽布局不动

## Detailed Design

### 1. 布局骨架（app.css）

- `.layout` 改单列；`.side` 改 `position:absolute; right:12px; top:64px; width:300px; max-height:calc(100% - 76px)`，半透明面板底（`rgba` 化现有 panel 背景 + backdrop blur 若可用），z-index 高于画布
- 复用现有 `btn-panel` 开关与 `.side.open` 逻辑：桌面默认 `.open`（HTML 初始类），小屏保持抽屉行为（不默认开）
- 侧栏内容精简：移除座位表（与桌面完全重复），保留牌局记录 + 聊天
- table-fit 从此占满 `.table-wrap`，fitCanvas 无需改动（它量的是 fit 元素实际尺寸）

### 2. 操作条右下浮层（app.css + 少量 table.html）

- 宽屏媒体查询内：`.action-bar` 改 `position:absolute; right:12px; bottom:12px; width:clamp(150px, 14vw, 190px); display:flex; flex-direction:column`，竖排布局直接复用矮屏竖条的既有规则（按钮两列、滑杆全宽、计时在顶）——矮屏分支的规则体与本分支合并，只留一个断点差
- 真空区验证：宽屏 tscale≈1.17 下操作条左沿 ≈ 视口(1408) - 190 - 12 → 逻辑 x≈1030、顶沿 ≈ 视口高(828) - 条高(~320) → 逻辑 y≈434；槽位 3 卡区右沿 x=1120 但 y≤408 —— 须 visual-check 加断言"操作条不压任何座位卡"，几何以实测为准
- 遮挡兜底：若实测与槽位 3 相交，优先压缩条高（滑杆/快捷注额合并一行）而非位移

### 3. 本人手牌 1.2x（table.css + table.js）

- table.js `renderSeats`：mine 座位的 hole 牌加 `big` class（`UI.cardHTML(c, 'small big')`），牌背不变
- table.css：`.card.small.big { width:58px; height:80px; border-radius:6px }`、`.card.small.big .rank { font-size:37px }`、two-char 30px；`.seat.mine` 的 `--hole-peek` 提到 26px（牌高 80，压卡顶比例保持观感一致；.info 的 padding-top 用同一变量自动让位）
- 几何账：底边 0-1/0-2 余量 = 30px - (80-26-(67-22)) = 30 - 9 = 21px ≥ 15 ✓（spec 余量线）；侧边/顶边不动
- 等大断言三处改写：table.css"等大"注释 → "对手等大 × 1.2"；layout-test 的尺寸 class 统一断言 → 归一化剥离 big 后仍统一，另加"big 仅出现于本人座位"；visual-check "本人与对手等大" → "本人 ≈ 对手 × 1.2（±0.5px）"

### 4. tscale 验收

- visual-check 现有断言"--tscale = min(fitW/1200, fitH/600)"自动适配新 fit，无需改；新增宽屏档的最低值断言：1440×900 档 tscale ≥ 1.10（回归守卫，防止侧栏悄悄回到占位布局）

## Risks / Trade-offs

- **悬浮侧栏遮右上座位**：半透明 + 可收起兜底；9 座满员时玩家可自行收起。记录到 spec（默认展开是用户决策）
- **操作条与槽位 3 的临界关系**：以 visual-check 实测断言守，若冲突压缩条高
- **layout-test 余量收紧**（30→21px）：仍在安全线内；若未来要更大的牌，唯一出路是加高桌面，与本变更解耦
- **竖屏**：竖屏走旋转引导 + 旧单列布局，侧栏为抽屉——本变更全部规则包在横屏媒体查询内，不外溢

## 实现偏差记录

1. **本人手牌 peek 定 23 而非 26**：26 时 .info 内容区剩 30px，放不下两行文字（32.2px），文字顶进牌区 2.1px（visual-check 实测抓到）；23 时余 0.8px。设计稿预判的"余量 30→21px"是误算——底边 0-1/0-2 的间隙是**水平**向（大牌只加高不加宽），实测余量 30px 未变，大牌的 9px 额外探出进入槽位 0 上方约 290px 的空区，防重叠无虞。
2. **侧栏占右上半（55%）而非全高**：全高版把右下操作条整个盖住（z-index 30 > 25，截图走查抓到）；两个浮层垂直分区、互不重叠。
3. **跨视口档的 open 状态重置**（计划外补充）：桌面开侧栏后缩窗到矮屏，抽屉保持打开与"矮屏默认收起"相悖——resize 跨档时重置为该档默认（宽屏按 localStorage、矮屏收起），同档内手动开关不受影响。
4. **render-check 的等大断言**：design 只列了 table.css/layout-test/visual-check 三处，实施时发现 render-check 也有同款断言（第 4 条），一并改写为 1.2x。
