// 客户端半侧 bundle 外壳：由 scripts/build.mjs 包装成 lib/client.js。
// 必须是「普通副作用脚本」——加载时调用 window.__ModuleLoader__.load，
// 不能含顶层 ESM import/export（react 由 factory 的 require 取得）。
import { makeFactory } from './app.js';

window.__ModuleLoader__.load({
  id: 'dsh-efficiency',
  factory: makeFactory(),
});
