/* vendor.js —— 把 poker/js 的核心文件复制到 poker-online/vendor/，便于独立部署（Docker / 云主机） */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'poker', 'js');
const DST = path.join(__dirname, '..', 'vendor');
const FILES = ['cards.js', 'engine.js'];

if (!fs.existsSync(SRC)) {
  console.log('[vendor] 未找到 ' + SRC + '，跳过（使用已有 vendor 副本）');
  process.exit(0);
}
fs.mkdirSync(DST, { recursive: true });
FILES.forEach(f => {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  console.log('[vendor] 已更新 ' + f);
});
