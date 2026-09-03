/* poker-core.js —— 加载牌型/规则核心
 *
 * 只认两个来源，按优先级：
 *   1. <repo>/vendor/        本仓库自带的核心逻辑副本，开箱即用（Docker / 云主机部署就靠它）
 *   2. ../poker/js/          本地开发时的单机版源码（存在才用，方便改完立即生效）
 *
 * 注意 engine.js 里的 ai.js 是可选依赖（联机局用不到），加载失败不会连累整个引擎。
 */
'use strict';
const path = require('path');

function load(name) {
  const tries = [
    path.join(__dirname, '..', 'vendor', name),
    path.join(__dirname, '..', '..', 'poker', 'js', name)
  ];
  let last = null;
  for (const p of tries) {
    try { return require(p); }
    catch (e) {
      last = e;
      // 只吞「模块不存在」，语法错误等真问题必须抛出来
      if (e.code !== 'MODULE_NOT_FOUND' && !/Cannot find module/.test(e.message)) throw e;
    }
  }
  throw new Error('找不到 ' + name + '（vendor/ 下缺文件）。请执行：npm run vendor；' +
    '最后一次错误：' + (last && last.message));
}

module.exports = { Cards: load('cards.js'), PokerEngine: load('engine.js') };
