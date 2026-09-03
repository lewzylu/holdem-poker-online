# 德州扑克 · 联机版

真人联机、账号体系、资产持久化。**服务端权威**：牌局在服务器里跑，底牌只发给本人，客户端改不了任何东西。

## 最快开始（局域网，零配置）

```bash
cd poker-online
npm install          # 只有一个依赖：ws
npm start            # 默认 3000 端口
```

启动后会打印本机和内网 IP：

```
本机访问：  http://localhost:3000
同网访问：  http://192.168.1.20:3000      ← 把这个发给朋友
```

朋友连同一个 WiFi，浏览器打开这个地址 → 注册账号 → 进大厅 → 创建/加入房间（8 位房间号）→ 坐下买入 → 房主点「开始牌局」。

## 玩法流程

1. **注册/登录**：昵称 + 密码（scrypt 加盐哈希），注册送 5000 筹码，登录状态 30 天免登
2. **大厅**：看到所有房间，点房间号加入，或者自己开一个（可选盲注级别和默认买入）
3. **入座**：点空位 → 填买入额 → 筹码从账号扣到桌上；点自己 → 站起结算回账号
4. **牌局**：四轮下注、边池、摊牌全自动；每人 30 秒操作时间，超时自动弃牌/过牌
5. **补给/离座**：随时补给，牌局中离座会先帮你弃牌、本手结束后把剩余筹码退回账号

## 账号与资产

- 账号数据存在 `data/users.json`（scrypt 哈希 + 随机 token 会话），重启不丢
- 写盘是**先写临时文件再 rename**，写一半崩溃不会损坏账号库
- 登录状态 30 天有效，过期自动失效；会话数量有上限并会清理
- 测试账号**默认不创建**。需要时用 `POKER_SEED=1 npm start` 播种 `test1`/`test2`，
  口令取 `POKER_SEED_PW`，未设置则随机生成并只在启动时打印一次。
  不要在公网环境留下固定弱口令账号。
- 资产分两处：**账号余额**（不在桌上）和**桌上筹码**（买入后冻结在座位上）
- 恒等式：所有人的 `账号余额 + 桌上筹码 + 底池` 始终等于注册赠送总额 —— 端到端测试每次都会校验这条

## 架构

```
poker-online/
  server/
    server.js      HTTP 静态服务 + WebSocket 长连接 + 消息路由
    room.js        房间：座位/买入/开局，驱动 PokerEngine，生成每人独立的视图
    db.js          账号、密码哈希、会话、资产（JSON 持久化）
    poker-core.js  加载牌型与规则核心（从 vendor/ 加载，本地有 ../poker/js 时优先用）
  vendor/          规则核心副本：cards.js / engine.js（ai.js 可选），随仓库自带
  public/          前端三页：登录 / 大厅 / 牌桌
    js/cards.js    牌面渲染与牌型评估（vendor/cards.js 的前端副本）
    css/table.css  牌桌基础样式（布局 / 牌面 / 座位 / 操作条）
    css/app.css    补充样式与响应式，覆盖 table.css
  tools/
    e2e.js         端到端：机器人自动打牌，校验资产守恒
    edge.js        边界：中途离座、掉线重连、补给、超时弃牌
    nav-test.js    页面跳转回归（需 jsdom）
    layout-test.js 座位角度与极端屏幕比例（需 jsdom）
    build-static.js  生成纯静态前端（dist/）
    vendor.js      从 ../poker/js 同步核心逻辑到 vendor/ 与 public/js/
```

`vendor/` 里的副本随仓库提供，克隆下来 `npm install && npm start` 就能跑，
**不依赖任何仓库外部目录**（早期版本会去找兄弟目录 `../poker/`，现在已经不需要）。

**关键设计**：`vendor/engine.js` 是纯逻辑、不碰 DOM 的规则引擎，通过 hooks 与外界交互。联机时把 `requestAction` 换成「等这个玩家的 WebSocket 消息」就完成了升格——规则代码一行没改。联机局没有 AI 座位，所以 `ai.js` 是可选依赖，缺失不影响启动。

**防作弊**：服务端给每个玩家单独生成视图（`stateFor`），底牌字段只在「本人」或「摊牌」时才填充，前端拿不到别人的牌，也无权修改筹码。

## 公网部署

> 沙箱/静态托管只能放**前端页面**，联机还需要一个能跑 Node 进程的**服务端**。

前端静态页已部署（可直接分享）：打开后在登录页点「⚙ 服务器设置」填上你的服务端地址即可，例如 `1.2.3.4:3000` 或 `wss://xxx.onrender.com`。也支持直接用 URL 参数：`https://<静态页>/?s=1.2.3.4:3000`。
注意：静态页是 https 时，服务端必须是 `wss://`（浏览器会拦截混合内容）。

服务端三种上公网的方式：

| 方式 | 怎么做 |
| --- | --- |
| **Docker（推荐）** | `npm run vendor && docker build -t poker . && docker run -d -p 3000:3000 -v poker-data:/app/data poker` |
| **Render.com** | 仓库里已带 `render.yaml`，在 Render 里 New → Blueprint，选这个仓库即可（含 1GB 数据盘） |
| **任意云主机** | 装 Node 18+，`npm install && npm start`，用 nginx 反代并把 `/ws` 升级为 WebSocket |

服务端默认监听 `0.0.0.0:3000`，可用 `PORT` / `HOST` 环境变量覆盖；`GET /healthz` 是健康检查。

其他环境变量：

| 变量 | 作用 |
| --- | --- |
| `POKER_DATA` | 账号库路径，默认 `data/users.json` |
| `POKER_SEED=1` | 播种 `test1`/`test2` 测试账号（默认关闭） |
| `POKER_SEED_PW` | 测试账号口令，未设则随机生成并打印一次 |
| `ALLOW_ORIGIN` | 允许的页面来源（逗号分隔的 host）。留空不校验，方便局域网/反代；公网部署建议配上 |
| `DEBUG_CHIPS=1` | 打印每手牌前后引擎与座位的筹码合计，排查漂移用 |

镜像以非 root 用户运行，数据目录 `/app/data` 已在构建时授权。

## 自测

```bash
npm start                    # 另开一个终端
npm test                     # 4 人自动打 8 手，校验资产守恒
npm run test:edge            # 中途离座 / 掉线重连 / 补给 / 超时弃牌
npm run test:nav             # 页面跳转回归：专防登录态竞态导致的无限跳转
npm run test:layout          # 座位角度与极端屏幕比例
node tools/e2e.js 9 20       # 9 人满桌压测
```

`nav-test` / `layout-test` 需要 jsdom（`npm install` 会装上）；
`render-check.js` / `visual-check.js` 需要真实 Chromium（agent-browser CLI），不在 npm 依赖里。

`nav-test.js` 用 jsdom 加载真实页面并拦截 `location.href` 赋值（记录而不真的导航），
从而能断言「这个页面该不该跳、跳几次、跳去哪」。

### 已修的登录态竞态（改这块务必重跑 nav-test）

曾在 `index.html` ↔ `lobby.html` 之间无限跳转，两个原因叠加：

1. **`lobby.js` 在页面加载时同步判断 `Net.isAuthed`** —— 那时 WebSocket 还在握手，`user` 必然是 `null`，
   于是无条件跳回登录页；登录页续期成功又跳回大厅。
   修法：绝不同步判断，只在服务端明确回复 `me`（无 user）或 `needLogin` 时才跳。
2. **`net.js` 里 `me` 请求比 `resume` 认证发得还早** —— `onopen` 先 `emit('conn','online')`，
   页面立刻发 `me`，而服务端此时还没把这条连接关联到用户，回 `user:null`，页面据此判定未登录。
   修法：有 token 时先等 `auth` 回来，再 `goOnline()`。

配套还修了：牌桌页刷新后 `me` 不带房间会被误判「不在房间」（服务端改为反查用户实际所在房间）；
牌局进行中点「返回大厅」会被反复拽回牌桌（用 `sessionStorage` 标记主动返回）。

## 牌桌布局与移动端

**自己永远固定坐在左下角**（椭圆 135° 方向），其余玩家从下家开始顺时针环绕。
牌局中座位不会因为别人进出而换位，看牌位置固定，手机上能形成肌肉记忆。
自己的两张底牌**横向并排**且比别人大一号（`.card.my`），座位有淡金底色且 z-index 最高，不会被邻座遮住。

牌桌顶部信息（阶段 / 底池 / 房间号+盲注）合成一行胶囊，公共牌只渲染已发出的牌（不留灰色占位）。

座位尺寸是**算出来的**，不是写死的：`table.js` 的 `seatWidth()` 会遍历椭圆上每一对相邻座位，
按「矩形不重叠 = 水平分离 或 垂直分离」反推出最大可用宽度，写进 CSS 变量 `--seat-w`，
卡片、头像、字号全部按它取比例。所以：

- 2–6 人局：座位大、牌清晰
- 7–9 人满桌：自动切换 `.crowded` —— 隐藏昵称、牌与头像**并排**（座位高度从 ~1.4 倍宽度压到 ~0.6 倍），反而能在同样间距里显示更大的牌
- 手机横屏：椭圆按实测宽高比自动压扁（越扁纵向半径越小），侧栏收成抽屉（顶栏「记录」按钮召唤）

已用真实 Chromium 量过 3 人和 9 人 × 7 种视口（1440×900 / 1280×720 / 1180×820 / 844×390 / 667×375 / 640×320 / 390×844）：
无横纵向滚动条、座位不溢出不重叠、操作条完整可见、按钮触摸目标够大。

```bash
node tools/layout-test.js     # jsdom：座位角度与极端比例（无需浏览器）
node tools/visual-check.js    # 真实 Chromium 量几何（需 agent-browser，会先手动进一局）
node tools/render-check.js    # 真实 Chromium：底牌是否横排、日志行有没有飘位、公共牌占位
```

### 踩过的坑

- `.layout` 用 grid 但没给 `grid-template-rows`，行高取 auto 时**不会拉伸填满容器**，
  牌桌的 `height:100%` 会塌成只剩边框的高度（横屏手机上牌桌只有 16px）。必须显式写 `minmax(0,1fr)`。
- 末尾的 `@media (max-width:1000px)` 里如果有 `height:auto`，会覆盖掉前面所有高度声明，
  导致矮屏规则失效。改成 `@media (max-width:1000px) and (min-height:601px)`。
- **日志行的 class 不能直接用日志类型名**。发牌日志的 kind 是 `board`，而公共牌容器也叫
  `.board`（带 `position:absolute; left:50%; top:42%`），于是「河牌：♦A ♣A …」这行日志会
  脱离文档流、飘到页面正中间。日志统一改用 `ln-<kind>` 前缀，并在 `.log div` 上加了
  `position:static !important` 兜底。
- **两张底牌必须包进 `.hole`**。`.seat` 本身是纵向 flex，直接塞两张 `.card` 会变成上下堆叠。
- 算座位间距时，`.felt` 的 `getBoundingClientRect()` 是 **border-box**（含 12px 木边框），
  而座位是相对 **padding box** 的百分比定位的，直接用会把可用间距高估约 7%，邻座会互相压住。
  要先减掉 `borderLeftWidth/RightWidth`。
- 算相邻座位间距时必须用**实际排布角度**（从 `MY_ANGLE` 递减），从 0 开始算会偏大、算出来还是会重叠。

## 想改点什么

- 行动超时：`server/room.js` 顶部 `ACTION_TIMEOUT`（默认 30 秒）
- 结算展示时长：同文件 `RESULT_SHOW_MS`（默认 6.5 秒）
- 盲注/买入上限：`server/db.js` 的 `MIN_BUYIN / MAX_BUYIN`，以及 `room.sit()` 里的 `bb * 200` 封顶
- 注册赠送：`server/db.js` 的 `START_CHIPS`
- 规则与 AI：改 `vendor/` 下对应文件（若本地有 `../poker/js/` 源码，改完执行 `npm run vendor` 同步）
