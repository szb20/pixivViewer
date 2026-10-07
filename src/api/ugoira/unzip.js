/**
 * Ugoira ZIP 解帧（fflate）。
 *
 * 流式解压器（网络流 / 磁盘分块读共用）+ 整包解帧（dev 代理 / prod 回退路径）。
 * 整包解帧原由 JSZip 承担，fflate 整包喂入即可覆盖，少一个重依赖。
 */
import { Unzip } from 'fflate';

/**
 * 创建 fflate 流式解压器（网络流 / 磁盘分块读共用）。
 * feed(chunk, final) 逐块喂入；finish() 在喂完后按 meta.frames 顺序组装帧。
 */
export function createUnzipper(meta, onFrameProgress) {
  const mime = meta.mime_type || 'image/jpeg';
  const entryUrls = new Map();
  const entryOrder = [];
  const partsByName = new Map();
  let failErr = null;

  const unzip = new Unzip();
  unzip.onfile = (file) => {
    if (!file?.name || file.name.endsWith('/')) return;
    const parts = [];
    partsByName.set(file.name, parts);
    file.ondata = (err, data, final) => {
      if (err) { failErr = err; return; }
      parts.push(data);
      if (final) {
        partsByName.delete(file.name);
        entryUrls.set(file.name, URL.createObjectURL(new Blob(parts, { type: mime })));
        entryOrder.push(file.name);
        onFrameProgress?.(entryOrder.length, Math.max(1, meta.frames.length));
      }
    };
    file.start();
  };

  return {
    feed(chunk, final) {
      if (failErr) return;
      try {
        unzip.push(chunk, final);
      } catch (e) {
        failErr = e;
      }
    },
    finish() {
      if (failErr) throw failErr;
      // 按 meta.frames 顺序组装（优先文件名匹配，失败按压缩包顺序兜底）
      const frames = meta.frames.map((f, i) => {
        const fileName = String(f.file || '').toLowerCase();
        let frameUrl = fileName ? entryUrls.get(fileName) : null;
        if (!frameUrl && fileName) {
          const match = entryOrder.find(n => n.toLowerCase().endsWith(fileName));
          frameUrl = match ? entryUrls.get(match) : null;
        }
        if (!frameUrl) {
          frameUrl = entryUrls.get(entryOrder[Math.min(i, entryOrder.length - 1)]);
        }
        if (!frameUrl) throw new Error(`ZIP 缺少帧文件 ${f.file || i}`);
        return { path: frameUrl, delay: f.delay || 100 };
      });
      return frames;
    },
    /** 失败回收：已解出的帧 blob 全部释放（feed 中途出错/停滞超时时调用） */
    abandon() {
      for (const url of entryUrls.values()) {
        try { URL.revokeObjectURL(url); } catch { /* 忽略 */ }
      }
      entryUrls.clear();
      entryOrder.length = 0;
    },
  };
}

/**
 * 整包解帧（dev 代理 / prod 回退路径）：ZIP 字节一次性喂入，
 * 进度 55→85 与流式路径的解帧区间对齐；异常时回收已解出的帧 blob。
 * @param {Uint8Array|ArrayBuffer} zipBytes
 */
export function extractFramesFromBuffer(zipBytes, meta, onProgress) {
  return new Promise((resolve, reject) => {
    onProgress?.(55);
    const unzipper = createUnzipper(meta, (done, total) => {
      onProgress?.(55 + Math.round((done / total) * 30));
    });
    try {
      unzipper.feed(zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes), true);
      resolve(unzipper.finish());
    } catch (e) {
      unzipper.abandon();
      reject(e);
    }
  });
}
