/**
 * 应用内返回处理器注册表 — 供系统返回手势/返回键驱动页面层级回退。
 * 后注册的先执行；处理器返回 true 表示已消费本次返回。
 */
let lastCall = 0;
const handlers = new Set();

export function registerBackHandler(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function runBackHandlers() {
  if (Date.now() - lastCall < 500) return true;
  lastCall = Date.now();
  for (const fn of [...handlers].reverse()) {
    if (fn()) return true;
  }
  return false;
}

export function clearBackHandlers() {
  handlers.clear();
}
