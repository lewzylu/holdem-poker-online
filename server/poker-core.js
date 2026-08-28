/* poker-core.js —— 加载牌型/规则核心
 * 优先用同仓库的 poker/js（开发时改完立即生效），部署时回退到 vendor/ 下的副本
 */
'use strict';
function load(name) {
  const tries = ['../../poker/js/' + name, '../vendor/' + name];
  for (const p of tries) {
    try { return require(p); }
    catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND' && !/Cannot find module/.test(e.message)) throw e;
    }
  }
  throw new Error('找不到 ' + name + '，请先执行：npm run vendor');
}
module.exports = { Cards: load('cards.js'), PokerEngine: load('engine.js') };
