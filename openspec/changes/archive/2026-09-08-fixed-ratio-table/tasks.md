## 1. 搭建固定画布骨架

- [x] 1.1 在 `public/table.html` 的 `.table-wrap` 内新增 `.table-fit` > `.table-canvas` 两层容器，把 `.felt` 及其全部子节点（`.table-top` / `.board` / `.seats` / `.waiting`）移入 `.table-canvas`；验证：`node tools/render-check.js` 通过，页面结构无节点丢失
- [x] 1.2 在 `public/css/table.css` 中定义 `.table-fit`（填充父容器、`overflow: hidden`、flex 居中）与 `.table-canvas`（`width: 1200px; height: 600px; transform: scale(var(--tscale, 1)); transform-origin: center`）；验证：桌面视口下牌桌可见且不溢出
- [x] 1.3 在 `public/js/table.js` 中新增画布常量组（`CANVAS_W = 1200`、`CANVAS_H = 600`、`ELLIPSE_RX = 460`、`ELLIPSE_RY = 215`）并加注释说明「修改这里必须重跑 layout-test」；验证：常量被后续函数引用，无未使用告警
- [x] 1.4 在 `public/js/table.js` 中实现 `fitCanvas()`：读 `.table-fit` 实测尺寸，算 `min(fitW/1200, fitH/600)` 写入 `.table-canvas` 的 `--tscale`；验证：手动缩放窗口时牌桌等比缩放并居中，无拉伸

## 2. 接管缩放更新时机

- [x] 2.1 绑定 `resize` 与 `orientationchange` 事件调用 `fitCanvas()`，用 `requestAnimationFrame` 合并同帧多次触发；验证：连续拖动窗口边缘时牌桌平滑跟随，无抖动
- [x] 2.2 在首帧渲染与侧栏抽屉开合（`#btn-panel` 切换）后各补一次 `fitCanvas()`；验证：刷新页面首屏即正确缩放，开合抽屉后牌桌重新居中

## 3. 座位改为固定画布坐标

- [x] 3.1 删除 `public/js/table.js` 中的 `ellipseGeo()` 与 `seatWidth()` 函数及 `--seat-w` 的写入；验证：全仓搜索 `seatWidth`、`ellipseGeo` 零命中（`layout-test.js` 除外，第 6 组处理）
- [x] 3.2 改写 `renderSeats()` 的定位逻辑：沿用 `MY_ANGLE = 0.75π` 起等分，用固定 `ELLIPSE_RX/RY` 换算成相对 `.seats` 的 `left/top` 百分比；验证：2/6/9 人下座位沿椭圆均匀分布，本人固定在左下
- [x] 3.3 统一座位内部 DOM 结构为「底牌行 + 头像/昵称/筹码行」，本人与对手共用同一模板，差异仅保留牌面朝向与 `.seat.mine` 的高亮类；验证：DOM 检查确认两类座位的子节点结构一致
- [x] 3.4 保留 `.crowded`（入座 ≥7 人）类的切换逻辑不变；验证：入座 7 人时 `#seats` 带上 `crowded` 类，6 人时不带

## 4. 清理派生尺寸与统一牌面

- [x] 4.1 在 `public/css/table.css` 中把座位、头像、昵称、筹码、下注标签的尺寸改为固定像素（底牌 48×67、头像 34、昵称 13px、筹码 13px）；验证：桌面视口下观感与改动前基线接近
- [x] 4.2 删除 `public/css/app.css` 中全部 `calc(var(--seat-w) * k)` 规则，以及 `.card.my` 与 `.seat:not(.mine) .card.small` 的差异化尺寸规则；验证：全仓搜索 `--seat-w` 零命中
- [x] 4.3 删除 `public/css/app.css` 中针对牌桌几何的响应式断点（`.felt` 边框宽度、`.table-top` 位移、`.board` 间距、对手座位在手机上的压缩等），保留操作条与侧栏的响应式规则；验证：`.action-bar` 与 `.side` 的断点规则仍在，牌桌相关的已移除
- [x] 4.4 确认公共牌与座位底牌尺寸的关系在画布内固定，且本人底牌与对手牌背尺寸完全相同；验证：浏览器中量取两者矩形，宽高严格相等

## 5. 竖屏旋转引导

- [x] 5.1 在 `public/table.html` 的 `.table-wrap` 内新增 `.rotate-hint` 节点（默认隐藏）；验证：横屏下该节点不可见
- [x] 5.2 在 `public/css/app.css` 中用 `@media (orientation: portrait)` 显示 `.rotate-hint` 并隐藏 `.table-fit` 内容；验证：竖屏视口下显示旋转提示，横屏恢复牌桌
- [x] 5.3 删除 `public/css/app.css` 中原有的 `@media (max-width: 640px) and (orientation: portrait)` 竖屏版式规则组；验证：全仓搜索该断点零命中
- [x] 5.4 确认竖屏引导显示期间行动倒计时与 WebSocket 交互不受影响（无 JS 分支依赖方向）；验证：竖屏下轮到本人行动时超时仍会触发自动处置

## 6. 测试改造

- [x] 6.1 重写 `tools/layout-test.js`：删除全部基于 `--seat-w` 与实测间距的断言，改为①任意两座位逻辑矩形不重叠、②座位矩形完整落在 1200×600 内、③本人底牌与对手牌背逻辑尺寸相等，覆盖 2/6/9 人；验证：`node tools/layout-test.js` 全部通过
- [x] 6.2 改造 `tools/visual-check.js` 探针：增读 `--tscale`，输出逻辑坐标（实测 ÷ scale），断言改为「画布不溢出 `.table-fit`、无滚动条、留白对称」；验证：脚本在 7 种横屏视口 × 2 种人数下全部通过
- [x] 6.3 跑通既有回归脚本 `tools/render-check.js` 与 `tools/nav-test.js`，确认无因 DOM 结构调整而失败；验证：两脚本均退出码 0
      - 说明：`render-check.js` 中「我的牌比别人大」这条断言与新规格「所有底牌统一尺寸」直接矛盾，已改为「等大」

## 7. 文档与收尾

- [x] 7.1 改写 `README.md` 中「座位尺寸是算出来的」一节，替换为固定 2:1 画布 + 等比缩放 + 操作条不缩 + 竖屏引导的说明；验证：README 中不再出现 `--seat-w` 与 `seatWidth()` 的描述
- [x] 7.2 端到端手动验证：在桌面宽屏、桌面窄高、手机横屏三种视口下各跑一手牌，确认牌大小一致、比例不变、操作条可点、动作反馈随画布缩放且不遮挡底牌；验证：三种视口均符合预期，无控制台报错
      - 已把这次人工验证固化成可复跑的 `tools/e2e-visual.js`（三横屏视口 + 竖屏引导 + 跨视口比例恒定 + 控制台报错）
      - 验证中发现并修复了一处本次改造引入的遮挡回归：椭圆固定后 12 点方向座位常驻画布 y≈36~161，
        原先 `top:7%` 的信息条被牌背压住。信息条移到 `top:28%`、公共牌移到 `top:52%`，
        并在 `visual-check.js` 增加「信息条/公共牌不被座位遮挡」断言防止复发
