/**
 * 应用内返回处理器注册表 — 供系统返回手势/返回键驱动页面层级回退。
 * 后注册的先执行；处理器返回 true 表示已消费本次返回。
 */
const handlers = new Set();

export function registerBackHandler(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function runBackHandlers() {
  // 后注册先执行（LIFO），让最近打开的（灯箱/弹窗）优先消费返回事件
  for (const fn of [...handlers].reverse()) {
    if (fn()) return true;
  }
  return false;
}

export function clearBackHandlers() {
  handlers.clear();
}
