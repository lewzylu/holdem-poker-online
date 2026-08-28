/* build-static.js —— 生成纯静态前端（不含服务端），可部署到任意静态托管
 * 用法：node tools/build-static.js            输出到 dist/
 *      OUT_DIR=myapp node tools/build-static.js
 *      WS 地址通过页面上的「服务器设置」或 ?s=host:port 指定
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const POKER = path.join(ROOT, '..', 'poker');

function buildInto(DIST) {
  fs.mkdirSync(DIST, { recursive: true });

  // 页面：把 /shared/xxx 的引用改成本地相对路径
  ['index.html', 'lobby.html', 'table.html'].forEach(p => {
    let html = fs.readFileSync(path.join(PUBLIC, p), 'utf8');
    html = html
      .replace(/\/shared\/js\/cards\.js/g, 'js/cards.js')
      .replace(/\/shared\/css\/style\.css/g, 'css/table.css');
    fs.writeFileSync(path.join(DIST, p), html);
  });

  const cp = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(DIST, to)), { recursive: true });
    fs.copyFileSync(from, path.join(DIST, to));
  };
  // 共享代码：牌面渲染 + 牌桌样式
  cp(path.join(POKER, 'js', 'cards.js'), 'js/cards.js');
  cp(path.join(POKER, 'css', 'style.css'), 'css/table.css');
  cp(path.join(PUBLIC, 'css', 'app.css'), 'css/app.css');
  ['net.js', 'common.js', 'login.js', 'lobby.js', 'table.js'].forEach(f => {
    cp(path.join(PUBLIC, 'js', f), 'js/' + f);
  });
}

// Windows 上旧的构建产物偶尔会被其它进程锁住（EPERM），自动换目录而不是直接失败
const names = [process.env.OUT_DIR || 'dist', 'dist2', 'dist-' + Date.now()];
let DIST = null, lastErr = null, cleaned = [];
for (const name of names) {
  const dir = path.join(ROOT, name);
  try {
    buildInto(dir);
    DIST = dir;
    break;
  } catch (e) {
    lastErr = e;
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    console.log('  ! ' + name + ' 被占用，换下一个目录');
    cleaned.push(dir);
  }
}
if (!DIST) throw lastErr;

// 清理失败过程中留下的空目录
for (const dir of cleaned) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
  } catch (e) { /* 清不掉就算了 */ }
}

console.log('静态前端已生成：' + path.relative(ROOT, DIST) + '/');
console.log('  ' + fs.readdirSync(DIST).join('  '));
console.log('\n页面上的「⚙ 服务器设置」里填写 WebSocket 服务端地址即可连接。');
