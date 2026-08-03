/**
 * 轻量日志工具 — 统一控制台输出与生产过滤。
 *
 * 设计：
 * - 开发环境（vite dev）输出全部级别；
 * - 生产构建默认只保留 warn / error，避免调试日志刷屏；
 * - createLogger(tag) 生成带命名空间前缀的 logger，便于按模块定位。
 */

const IS_DEV = import.meta.env.DEV;
const MIN_LEVEL = IS_DEV ? 'debug' : 'warn';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level, tag, args) {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;
  const fn = console[level] || console.log;
  if (tag) {
    fn(`[${tag}]`, ...args);
  } else {
    fn(...args);
  }
}

/** 创建一个带命名空间的 logger */
export function createLogger(tag) {
  return {
    debug: (...args) => write('debug', tag, args),
    info: (...args) => write('info', tag, args),
    warn: (...args) => write('warn', tag, args),
    error: (...args) => write('error', tag, args),
  };
}

/** 全局 logger（无命名空间） */
export const logger = createLogger('');
