/**
 * downloadMonitor — 全局下载进度监视器（单例，框架无关）。
 *
 * 静态图/动图保存时通过 downloadMonitor.start() 登记任务并上报进度；
 * UI 用 useSyncExternalStore 订阅（见 components/DownloadMonitor.jsx）。
 *
 * 失败任务：finish(false) 后不会自动消失；会带完整重试信息（recordFailure）持久化到
 * localStorage（pixiv_viewer_app.downloadFailed 子键），重启后仍可在弹窗里看到并重试。
 * 进行中/已完成任务只存在于内存，会话结束即消失（保留 8s 供查看）。
 *
 * job 结构：
 *   { key, illustId, page, title, kind: 'image'|'gif',
 *     status: 'downloading'|'writing'|'done'|'error',
 *     progress: number|null, message: string, error: string,
 *     retry?: { illustId, page, title, kind, type, ... } // 失败重试重建信息 }
 */
import { appStorage } from './appStorage.js';

const listeners = new Set();
const jobs = new Map();
// queueTotal：本次下载队列的文件总数（多图批量时=全部页数），由下载方在开始时上报；
// 徽标据此显示"队列里还有多少文件"，而非当前正在下载的个数
let queueTotal = 0;
let snapshot = { jobs: [], queueTotal: 0 };

const FAILED_KEY = 'downloadFailed';

/** 从 localStorage 恢复上次会话的失败任务（带重试信息），作为常驻 job 注入 */
function hydrateFailedJobs() {
  const failed = appStorage.get(FAILED_KEY, null);
  if (!Array.isArray(failed) || !failed.length) return;
  for (const meta of failed) {
    if (!meta?.key || !meta.illustId) continue;
    const job = {
      key: meta.key,
      illustId: meta.illustId,
      page: meta.page ?? 0,
      title: meta.title || meta.illustId,
      kind: meta.kind || 'image',
      status: 'error',
      progress: null,
      message: '下载失败',
      error: meta.error || '下载失败',
      retry: meta, // 完整重建信息：重试时原样转交
    };
    jobs.set(meta.key, job);
  }
  persistFailed();
}
hydrateFailedJobs();

/** 把 all error jobs 的重试信息写入 localStorage（失败任务跨会话保留） */
function persistFailed() {
  const failed = [];
  for (const j of jobs.values()) {
    if (j.status === 'error' && j.retry) failed.push(j.retry);
  }
  appStorage.set(FAILED_KEY, failed.length ? failed : []);
}

function emit() {
  snapshot = { jobs: jobs.size ? [...jobs.values()] : [], queueTotal };
  for (const fn of [...listeners]) fn();
}

export const downloadMonitor = {
  /** 上报本次下载队列的文件总数（徽标显示用） */
  setQueueTotal(n) {
    queueTotal = Math.max(0, Number(n) || 0);
    emit();
  },

  /** 登记一个下载任务，返回进度句柄 */
  start(key, meta) {
    const existing = jobs.get(key);
    // 失败重试重新开始时：清除旧 error 状态（含持久化），回到 downloading
    if (existing?.status === 'error') {
      jobs.delete(key);
      persistFailed();
    }
    jobs.set(key, {
      key,
      illustId: meta.illustId || '',
      page: meta.page ?? 0,
      title: meta.title || '',
      kind: meta.kind || 'image',
      status: 'downloading',
      progress: null,
      message: meta.message || '',
      error: '',
      retry: undefined,
    });
    emit();
    return {
      setProgress(pct) {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        const value = Number(pct);
        if (!Number.isFinite(value)) return;
        // 进度只增不减：模拟进度/真实进度/写相册阶段混用时不回退
        if (j.progress != null && value < j.progress) return;
        j.progress = value;
        emit();
      },
      setStatus(status, message = '') {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        j.status = status;
        if (message) j.message = message;
        emit();
      },
      finish(ok, error = '') {
        const j = jobs.get(key);
        if (!j) return;
        j.status = ok ? 'done' : 'error';
        j.error = ok ? '' : error;
        if (ok) j.progress = 100;
        emit();
        if (!ok) {
          // 失败：不带重试信息（未登记 recordFailure）也要持久化，避免丢记录
          persistFailed();
          return; // 失败任务常驻，不自动移除
        }
        // 成功：保留一小段时间便于查看，之后自动移除
        setTimeout(() => {
          if (jobs.get(key)?.status === 'done') {
            jobs.delete(key);
            if (jobs.size === 0) queueTotal = 0;
            emit();
          }
        }, 8000);
      },
    };
  },

  /**
   * 保存失败时登记完整重试信息（供下载管理弹窗一键重试）。
   * 建议在 finish(false) 前调用；重试时会用这份信息重新走 saveItem。
   * @param {string} key — 与 start() 一致的 key
   * @param {object} retryMeta — { illustId, page, title, kind, originalUrl, mediumUrl, thumbnailUrl, ... }
   */
  recordFailure(key, retryMeta = {}) {
    const j = jobs.get(key);
    if (!j) return;
    j.retry = { ...(j.retry || {}), ...retryMeta, key, illustId: retryMeta.illustId || j.illustId, page: retryMeta.page ?? j.page, title: retryMeta.title || j.title, kind: retryMeta.kind || j.kind };
    persistFailed();
    emit();
  },

  /** 立即清除所有已完成/失败任务（含持久化的失败列表） */
  clearFinished() {
    for (const [k, j] of jobs) {
      if (j.status === 'done' || j.status === 'error') jobs.delete(k);
    }
    if (jobs.size === 0) queueTotal = 0;
    persistFailed();
    emit();
  },

  /** 重试失败任务：重置状态、触发外部传入的 onRetry 回调（重新走保存链路） */
  retry(key, onRetry) {
    const j = jobs.get(key);
    if (!j || j.status !== 'error') return;
    const meta = j.retry;
    if (!meta) { // 无重试信息：至少给个再次失败断言
      j.error = '缺少重试信息';
      emit();
      return;
    }
    // 先重置回 downloading 再调用外部保存（下载成功由 start/finish 接管状态）
    jobs.delete(key);
    persistFailed();
    emit();
    onRetry?.(meta);
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getSnapshot() {
    return snapshot;
  },
};