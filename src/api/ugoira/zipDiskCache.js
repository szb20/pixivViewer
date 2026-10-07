/**
 * Ugoira ZIP 磁盘缓存（Directory.Data 下的 {CACHE_DIR}/ugoira）。
 *
 * ZIP + meta.json 成对落盘，重启后可直读解帧，避免重复下载；
 * LRU 保留最近 ZIP_CACHE_MAX 个，超 40MB 的包不落盘（读取内存风险）。
 * 读写均按 2MB 分块，避免整包 base64 内存峰值。
 */
import { getFS } from '../../pixiv-assistant/capacitor/config.js';
import { CACHE_DIR } from '../../pixiv-assistant/core/constants.js';
import { getGallerySaver } from '../../utils/platform.js';
import { createLogger } from '../../utils/logger.js';
import { concatBytes, base64ToBytes, bytesToBase64 } from '../../utils/bytes.js';
import { createUnzipper } from './unzip.js';

const log = createLogger('ugoiraDiskCache');

const ZIP_CACHE_SUBDIR = `${CACHE_DIR}/ugoira`; // 位于 Directory.Data 下
const ZIP_CACHE_MAX = 12;                        // 磁盘最多保留几个动图
export const ZIP_CACHE_MAX_BYTES = 40 * 1024 * 1024; // 超过 40MB 的 ZIP 不落盘（读取内存风险）
const ZIP_CACHE_CHUNK = 2 * 1024 * 1024;         // 读写块大小 2MB，避免整包 base64 内存峰值

function zipCachePath(id) { return `${ZIP_CACHE_SUBDIR}/ugoira_${id}.zip`; }
function metaCachePath(id) { return `${ZIP_CACHE_SUBDIR}/ugoira_${id}.meta.json`; }

/** 确保 ZIP 缓存目录存在 */
async function ensureZipCacheDir(fs) {
  try {
    await fs.plugin.mkdir({ path: ZIP_CACHE_SUBDIR, directory: 'DATA', recursive: true });
  } catch { /* 已存在 */ }
}

/** 磁盘缓存 LRU：保留最近 ZIP_CACHE_MAX 个，删除最旧的 zip + meta */
async function trimZipCache(fs) {
  try {
    const { files } = await fs.plugin.readdir({ path: ZIP_CACHE_SUBDIR, directory: 'DATA' });
    const zips = (files || []).filter(f => String(f.name).endsWith('.zip'));
    if (zips.length <= ZIP_CACHE_MAX) return;
    const withTime = [];
    for (const f of zips) {
      try {
        const st = await fs.plugin.stat({ path: `${ZIP_CACHE_SUBDIR}/${f.name}`, directory: 'DATA' });
        withTime.push({ name: f.name, mtime: st?.mtime || 0 });
      } catch {
        withTime.push({ name: f.name, mtime: 0 });
      }
    }
    withTime.sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < withTime.length - ZIP_CACHE_MAX; i++) {
      const name = withTime[i].name;
      await fs.plugin.deleteFile({ path: `${ZIP_CACHE_SUBDIR}/${name}`, directory: 'DATA' }).catch(() => { });
      await fs.plugin.deleteFile({
        path: `${ZIP_CACHE_SUBDIR}/${name.replace(/\.zip$/, '.meta.json')}`,
        directory: 'DATA',
      }).catch(() => { });
    }
  } catch (e) {
    log.debug('[ugoira] 清理 ZIP 缓存失败:', e?.message || e);
  }
}

/**
 * 把已下载的 ZIP 分块写入磁盘缓存（appendFile 每次 ~2MB，避免整包 base64 内存峰值）。
 * 同时写入 meta.json（含帧顺序/延迟，离线也能直接读）。
 */
export async function saveZipToDisk(id, meta, chunks) {
  try {
    if (!Array.isArray(chunks) || chunks.length === 0) return false;
    const totalBytes = chunks.reduce((a, c) => a + (c?.byteLength || 0), 0);
    if (totalBytes > ZIP_CACHE_MAX_BYTES) return false;
    const fs = await getFS();
    if (!fs?.plugin) return false;
    await ensureZipCacheDir(fs);

    const zipPath = zipCachePath(id);
    await fs.plugin.deleteFile({ path: zipPath, directory: 'DATA' }).catch(() => { });

    const pieces = [];
    let acc = 0;
    const flush = async () => {
      if (!pieces.length) return;
      const buf = concatBytes(pieces);
      await fs.plugin.appendFile({ path: zipPath, data: bytesToBase64(buf), directory: 'DATA' });
      pieces.length = 0;
      acc = 0;
    };
    for (const c of chunks) {
      pieces.push(c);
      acc += c.byteLength;
      if (acc >= ZIP_CACHE_CHUNK) await flush();
    }
    await flush();

    await fs.plugin.writeFile({
      path: metaCachePath(id),
      data: JSON.stringify(meta),
      directory: 'DATA',
      encoding: 'utf8', // 不指定会被当成 base64 解码，JSON 会变成乱码
    });
    await trimZipCache(fs);
    log.info(`[ugoira] ZIP 已写入磁盘缓存: ${id} ${totalBytes} bytes`);
    return true;
  } catch (e) {
    log.debug('[ugoira] 保存 ZIP 缓存失败:', e?.message || e);
    return false;
  }
}

/** 删除指定动图的磁盘缓存 */
export async function deleteZipFromDisk(id) {
  try {
    const fs = await getFS();
    if (!fs?.plugin) return;
    await fs.plugin.deleteFile({ path: zipCachePath(id), directory: 'DATA' }).catch(() => { });
    await fs.plugin.deleteFile({ path: metaCachePath(id), directory: 'DATA' }).catch(() => { });
  } catch { /* ignore */ }
}

/**
 * 把原版无损 ZIP 从磁盘缓存复制到相册目录（Pictures/PixivViewer/，与保存的图片/动图同目录），
 * 作为卸载后仍保留的无损副本（尽力而为：缓存被 LRU 淘汰或读取失败就跳过）。
 */
export async function backupLosslessZip(sid) {
  try {
    const S = getGallerySaver();
    if (!S) return;
    const fs = await getFS();
    if (!fs?.plugin) return;
    const zipPath = zipCachePath(sid);
    const raw = await fs.plugin.readFile({ path: zipPath, directory: 'DATA' }).catch(() => null);
    if (!raw) return;
    const base64 = typeof raw === 'string' ? raw : raw.data || '';
    if (!base64) return;
    await S.saveDownload({
      fileName: `pixiv_${sid}_ugoira.zip`,
      data: base64,
      mimeType: 'application/zip',
    });
    log.info(`[ugoira] 已备份无损 ZIP: ${sid}`);
  } catch (e) {
    log.debug('[ugoira] 备份无损 ZIP 失败:', e?.message || e);
  }
}

/**
 * 从磁盘缓存读回帧：分块读 ZIP + 流式解压（readFileInChunks 空块即文件结束），
 * 不生成整包 base64，内存峰值 ≈ 单块 + 帧。
 */
export async function loadFramesFromDisk(id) {
  try {
    const fs = await getFS();
    if (!fs?.plugin) return null;

    const metaRaw = await fs.plugin
      .readFile({ path: metaCachePath(id), directory: 'DATA', encoding: 'utf8' })
      .catch(() => null);
    if (!metaRaw) return null;
    let meta;
    try {
      meta = JSON.parse(typeof metaRaw.data === 'string' ? metaRaw.data : metaRaw);
    } catch {
      return null;
    }
    if (!meta?.frames?.length) return null;

    const zipPath = zipCachePath(id);
    const unzipper = createUnzipper(meta);
    let failErr = null;
    await new Promise((resolve, reject) => {
      fs.plugin.readFileInChunks(
        { path: zipPath, directory: 'DATA', chunkSize: ZIP_CACHE_CHUNK },
        (chunkRead, err) => {
          if (err) { failErr = err; reject(err); return; }
          const data = chunkRead?.data;
          if (!data) { resolve(); return; } // 空块 = 文件结束
          try {
            unzipper.feed(base64ToBytes(typeof data === 'string' ? data : data.data || ''), false);
          } catch (e) {
            failErr = e;
            reject(e);
          }
        },
      );
    });
    if (failErr) throw failErr;
    unzipper.feed(new Uint8Array(0), true);
    const frames = unzipper.finish();
    log.info(`[ugoira] 磁盘缓存命中: ${id} ${frames.length} 帧`);
    return { frames, meta };
  } catch (e) {
    log.debug('[ugoira] 读取 ZIP 缓存失败:', e?.message || e);
    return null;
  }
}
