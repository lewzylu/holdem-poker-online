/* build-static.js —— 生成纯静态前端（不含服务端），可部署到任意静态托管
 * 用法：node tools/build-static.js            输出到 dist/
 *      OUT_DIR=myapp node tools/build-static.js
 *      WS 地址通过页面上的「服务器设置」或 ?s=host:port 指定
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// 页面里引用的都是站内绝对路径（/js/xxx、/css/xxx），静态托管需要改成相对路径
const REWRITE = [
  [/\/css\/table\.css/g, 'css/table.css'],
  [/\/css\/app\.css/g, 'css/app.css'],
  [/\/js\/cards\.js/g, 'js/cards.js'],
  [/\/js\/(net|common|login|lobby|table)\.js/g, 'js/$1.js']
];

function buildInto(DIST) {
  fs.mkdirSync(DIST, { recursive: true });

  for (const p of ['index.html', 'lobby.html', 'table.html']) {
    let html = fs.readFileSync(path.join(PUBLIC, p), 'utf8');
    for (const [re, to] of REWRITE) html = html.replace(re, to);
    fs.writeFileSync(path.join(DIST, p), html);
  }

  const cp = (from, to) => {
    fs.mkdirSync(path.dirname(path.join(DIST, to)), { recursive: true });
    fs.copyFileSync(from, path.join(DIST, to));
  };
  // 全部资源都来自本仓库，不依赖任何外部目录
  cp(path.join(PUBLIC, 'js', 'cards.js'), 'js/cards.js');
  ['net.js', 'common.js', 'login.js', 'lobby.js', 'table.js'].forEach(f => {
    cp(path.join(PUBLIC, 'js', f), 'js/' + f);
  });
  cp(path.join(PUBLIC, 'css', 'table.css'), 'css/table.css');
  cp(path.join(PUBLIC, 'css', 'app.css'), 'css/app.css');
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
