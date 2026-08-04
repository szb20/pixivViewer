/**
 * downloadMonitor — 全局下载进度监视器（单例，框架无关）。
 *
 * 静态图/动图保存时通过 downloadMonitor.start() 登记任务并上报进度；
 * UI 用 useSyncExternalStore 订阅（见 components/DownloadMonitor.jsx）。
 *
 * job 结构：
 *   { key, illustId, page, title, kind: 'image'|'gif',
 *     status: 'downloading'|'writing'|'done'|'error',
 *     progress: number|null, message: string, error: string }
 */

const listeners = new Set();
const jobs = new Map();
let snapshot = [];

function emit() {
  snapshot = jobs.size ? [...jobs.values()] : [];
  for (const fn of [...listeners]) fn();
}

export const downloadMonitor = {
  /** 登记一个下载任务，返回进度句柄 */
  start(key, meta) {
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
    });
    emit();
    return {
      setProgress(pct) {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        j.progress = pct;
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
        // 完成后保留一小段时间便于查看，之后自动移除
        setTimeout(() => {
          if (jobs.get(key)?.status === 'done' || jobs.get(key)?.status === 'error') {
            jobs.delete(key);
            emit();
          }
        }, 8000);
      },
    };
  },

  /** 立即清除所有已完成/失败任务 */
  clearFinished() {
    for (const [k, j] of jobs) {
      if (j.status === 'done' || j.status === 'error') jobs.delete(k);
    }
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getSnapshot() {
    return snapshot;
  },
};
