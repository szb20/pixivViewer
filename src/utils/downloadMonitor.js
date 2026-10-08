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
import { createLogger } from './logger.js';

const log = createLogger('downloadMonitor');

const listeners = new Set();
const jobs = new Map();
// 徽标显示的是「队列里还有多少个任务」＝ jobs.size。
// 曾经有个 queueTotal（由下载方上报「本批共几个文件」），但从来没有任何调用方上报过，
// 于是它恒为 0、只让角标的语义在「文件数」和「任务数」之间含糊着 —— 已删除。
let snapshot = { jobs: [] };

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
  // 必须 emit：snapshot 只在 emit 里重建，不 emit 的话这些恢复出来的失败任务
  // 在 UI 上等于不存在（角标 0、弹窗「暂无下载任务」），一直要等别的动作触发一次 emit 才冒出来
  emit();
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
  snapshot = { jobs: jobs.size ? [...jobs.values()] : [] };
  for (const fn of [...listeners]) fn();
}

/**
 * 登记失败任务的重试信息（内部实现）。
 * 单例方法 recordFailure(key, meta) 与 start() 返回的句柄共用同一份逻辑，
 * 避免调用方误把 mon.recordFailure(...) 用在句柄上（句柄历史上没有这个方法）。
 */
function recordFailureFor(key, retryMeta = {}) {
  const j = jobs.get(key);
  if (!j) {
    // 任务已被移除（如 retry 先删除、保存链路却没能用 start 重建）：
    // 这次失败不会体现在任何 UI 上，留个排查线索
    log.debug('recordFailure 找不到任务:', key);
    return;
  }
  j.retry = { ...(j.retry || {}), ...retryMeta, key, illustId: retryMeta.illustId || j.illustId, page: retryMeta.page ?? j.page, title: retryMeta.title || j.title, kind: retryMeta.kind || j.kind };
  persistFailed();
  emit();
}

export const downloadMonitor = {
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
      // 句柄自带 recordFailure（已绑定 key）：调用方拿到 mon = start(...) 后
      // 直接 mon.recordFailure(meta) 即可，不要再去外面取单例
      recordFailure(retryMeta = {}) {
        recordFailureFor(key, retryMeta);
      },
      /**
       * @param {number|null} pct   0-100；null 表示只有字节数、算不出百分比
       * @param {{loaded?: number, total?: number}} [bytes] 真实字节数（可选）。
       *        只有原生/桌面流式通道会给；CapacitorHttp 降级与 web 的 fetch 拿不到，
       *        那时 UI 只显示状态文案，不显示大小和速度 —— 宁可不说，不给假数。
       */
      setProgress(pct, bytes) {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        const value = Number(pct);
        if (Number.isFinite(value)) {
          // 进度只增不减：模拟进度/真实进度/写相册阶段混用时不回退
          if (j.progress == null || value >= j.progress) j.progress = value;
        }
        if (bytes && typeof bytes.loaded === 'number') {
          const now = Date.now();
          const dt = now - (j._lastAt || 0);
          const dBytes = bytes.loaded - (j._lastLoaded || 0);
          if (dt > 0 && dBytes >= 0) {
            const inst = (dBytes * 1000) / dt;
            // 指数平滑：瞬时速度抖动太大，直接显示会一直跳
            j.speed = j.speed == null ? inst : j.speed * 0.65 + inst * 0.35;
          }
          j._lastAt = now;
          j._lastLoaded = bytes.loaded;
          j.loaded = bytes.loaded;
          if (bytes.total > 0) j.total = bytes.total;
        }
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
        if (!j) {
          log.debug('finish 找不到任务:', key, ok ? '(done)' : '(error)');
          return;
        }
        j.status = ok ? 'done' : 'error';
        j.error = ok ? '' : error;
        // 完成/失败后速度没有意义，留着会让列表显示一个不断变小的“速度”
        if (ok) { j.progress = 100; j.speed = null; }
        emit();
        if (!ok) {
          // 失败：任务常驻内存不自动移除；跨会话保留需先由 recordFailure 登记重试信息，
          // persistFailed 只持久化带 retry 的任务（无重试信息本就无法重建）
          persistFailed();
          return; // 失败任务常驻，不自动移除
        }
        // 成功：保留一小段时间便于查看，之后自动移除
        setTimeout(() => {
          if (jobs.get(key)?.status === 'done') {
            jobs.delete(key);
            emit();
          }
        }, 8000);
      },
    };
  },

  /**
   * 保存失败时登记完整重试信息（供下载管理弹窗一键重试）。
   * 建议在 finish(false) 前调用；重试时会用这份信息重新走 saveItem。
   * 注意：拿到 start() 句柄的调用方应直接用句柄上的 recordFailure（已绑定 key）。
   * @param {string} key — 与 start() 一致的 key
   * @param {object} retryMeta — { illustId, page, title, kind, originalUrl, mediumUrl, thumbnailUrl, ... }
   */
  recordFailure(key, retryMeta = {}) {
    recordFailureFor(key, retryMeta);
  },

  /**
   * 清除**已完成**任务（按钮文案就是「清除已完成」，别偷偷清别的）。
   *
   * 失败任务刻意不动：它们是唯一的重试入口，而且是一份持久化的待办清单
   * （restart 后还在）。以前这里把 error 一并删掉并重写持久化列表，
   * 用户点一个写着「清除已完成」的按钮，等待重试的失败记录就全没了。
   * 单个失败记录用 dismiss(key) 移除，批量重试走 retry()。
   */
  clearDone() {
    for (const [k, j] of jobs) {
      if (j.status === 'done') jobs.delete(k);
    }
    emit();
  },

  /**
   * 移除单个任务（成功或失败均可）。
   * 重试成功时用它收尾 —— 别用 clearDone 之外的方式批量删失败记录。
   */
  dismiss(key) {
    if (!jobs.has(key)) return;
    jobs.delete(key);
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
    // 返回外部保存的 promise：调用方需要 await 它才能保证「全部重试」真串行
    return onRetry?.(meta);
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getSnapshot() {
    return snapshot;
  },
};