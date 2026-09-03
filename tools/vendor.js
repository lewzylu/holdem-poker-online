/* vendor.js —— 把 poker/js 的核心文件同步到 vendor/ 与 public/js/
 *
 * 源目录 ../poker/js 是可选的：本仓库自带 vendor 副本，开箱即用。
 * 找不到源就跳过（exit 0），不会让 npm run vendor 变成失败步骤。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '..', 'poker', 'js');
const DST = path.join(ROOT, 'vendor');
const PUB = path.join(ROOT, 'public', 'js');

const REQUIRED = ['cards.js', 'engine.js'];
const OPTIONAL = ['ai.js'];        // 只有单机/AI 陪练才需要，联机局用不到

if (!fs.existsSync(SRC)) {
  console.log('[vendor] 未找到 ' + SRC + '，跳过（沿用 vendor/ 下的现有副本）');
  process.exit(0);
}

fs.mkdirSync(DST, { recursive: true });
let n = 0;
for (const f of REQUIRED.concat(OPTIONAL)) {
  const from = path.join(SRC, f);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(DST, f));
  console.log('[vendor] 已更新 vendor/' + f);
  n++;
}

// cards.js 前端也要用（渲染牌面），同步一份到 public/js/
const cards = path.join(DST, 'cards.js');
if (fs.existsSync(cards)) {
  fs.copyFileSync(cards, path.join(PUB, 'cards.js'));
  console.log('[vendor] 已更新 public/js/cards.js');
}

const missing = REQUIRED.filter(f => !fs.existsSync(path.join(DST, f)));
if (missing.length) {
  console.error('[vendor] 缺少核心文件：' + missing.join('、') + '，服务端将无法启动');
  process.exit(1);
}
console.log('[vendor] 完成，共同步 ' + n + ' 个文件');
