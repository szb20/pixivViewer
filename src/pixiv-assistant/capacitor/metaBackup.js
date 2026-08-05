/**
 * metaBackup — 喜欢/已保存 元数据 + Cookie 的持久备份。
 *
 * 问题：IndexedDB 位于应用私有 WebView 数据，卸载即清空；而系统相册文件保留。
 * 方案：把「喜欢/已保存」元数据 + cookie 写成一个真正的 JSON 文件，
 *      通过原生 GallerySaver.writeMeta 存到「下载」集合（Download/TeyvatWhisper/），
 *      随系统存储一起存活；重装后若 IndexedDB 为空则从备份自动恢复。
 */
import { Capacitor } from '@capacitor/core';
import { getAllMeta, putMetaBatch } from './cacheDB.js';
import { getSettingsSync, saveSettings } from './config.js';
import { PixivEntity } from './entity.js';
import { parseCacheFileName } from '../core/utils.js';
import { createLogger } from '../../utils/logger.js';
import { hiddenWorks } from '../../utils/hiddenWorks.js';

const log = createLogger('metaBackup');

/** 新版备份文件名（Downloads 集合，卸载后保留，纯 JSON 可读） */
const META_FILE = 'pixiv_meta.json';
/** 备份格式版本 */
const BACKUP_VERSION = 4;
/** 旧版曾用 1×1 PNG 藏 JSON（Images 集合），用于迁移兼容 */
const LEGACY_META_PNG = 'pixiv_meta.png';

let _timer = null;

function plugin() {
  return Capacitor?.Plugins?.GallerySaver;
}

function isNative() {
  return typeof window !== 'undefined'
    && !!window.Capacitor?.isNativePlatform?.()
    && !!plugin();
}

/** 是否可用备份（原生 + GallerySaver 插件） */
export function isMetaBackupAvailable() {
  return isNative();
}

/** 写入备份文件：只保留 喜欢/已保存 的实体 + cookie 设置。 */
export async function writeMetaBackup(records, settings) {
  if (!isNative()) return;
  const items = (records || [])
    .filter(r => (r.likedAt || 0) > 0 || r.state === 'saved')
    .map(r => ({
      illustId: r.illustId,
      pageIndex: r.pageIndex ?? 0,
      type: r.type || 'image',
      state: r.state || 'cached',
      title: r.title || '',
      author: r.author || '',
      authorName: r.authorName || r.author || '',
      authorId: r.authorId || '',
      likedAt: r.likedAt || 0,
      fileName: r.fileName || '',
      cachedAt: r.cachedAt || 0,
      tags: r.tags || [],
    }));
  const payload = JSON.stringify({
    v: BACKUP_VERSION,
    savedAt: Date.now(),
    items,
    hidden: hiddenWorks.getList(),
    settings: {
      pixivCookie: (settings?.pixivCookie || '').trim(),
    },
  });
  try {
    const S = plugin();
    await S.writeMeta({ fileName: META_FILE, data: payload });
    // 清理旧版 PNG 备份（Images 集合），避免残留
    await S.delete({ fileName: LEGACY_META_PNG }).catch(() => {});
    await S.delete({ fileName: '_.pixiv_meta.png' }).catch(() => {});
    log.info('[metaBackup] 已备份', items.length, '条喜欢/已保存 → pixiv_meta.json');
  } catch (e) {
    log.warn('[metaBackup] 写入备份失败:', e?.message || e);
  }
}

/** 防抖调度备份：一次连续操作结束后写一次（默认 1.5s）。 */
export function scheduleMetaBackup() {
  if (!isNative()) return;
  clearTimeout(_timer);
  _timer = setTimeout(async () => {
    try {
      const records = await getAllMeta();
      await writeMetaBackup(records, getSettingsSync());
    } catch (e) {
      log.warn('[metaBackup] 备份调度失败:', e?.message || e);
    }
  }, 1500);
}

/**
 * 启动补写：IndexedDB 已有喜欢/已保存数据、但备份文件不存在时补一份。
 * 用于升级到本版本后，无需等下一次点赞/保存，立即把现有数据备份好。
 */
export async function ensureMetaBackup() {
  if (!isNative()) return;
  try {
    const r = await plugin().readMeta({ fileName: META_FILE }).catch(() => null);
    let needWrite = false;
    if (r?.data) {
      try {
        const parsed = JSON.parse(r.data);
        // 已有备份但版本过旧（如缺 tags）→ 补写升级
        needWrite = (parsed?.v || 0) < BACKUP_VERSION;
      } catch {
        needWrite = true;
      }
    } else {
      needWrite = true;
    }
    if (!needWrite) return; // 已有最新版 JSON 备份
    const records = await getAllMeta().catch(() => []);
    const hasData = (records || []).some(x => (x.likedAt || 0) > 0 || x.state === 'saved');
    if (hasData) {
      await writeMetaBackup(records, getSettingsSync());
      log.info('[metaBackup] 启动时已补写备份');
    }
  } catch (e) {
    log.warn('[metaBackup] 启动补写备份失败:', e?.message || e);
  }
}

/** 读取备份文件（新版 JSON → 旧版 PNG 兜底迁移）。无备份/失败返回空。 */
export async function readMetaBackup() {
  if (!isNative()) return { items: [], settings: {} };
  // 1. 新版：Downloads 里的纯 JSON
  try {
    const r = await plugin().readMeta({ fileName: META_FILE }).catch(() => null);
    if (r?.data) {
      const parsed = JSON.parse(r.data);
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
        settings: parsed?.settings || {},
      };
    }
  } catch (e) {
    log.debug('[metaBackup] 读取 JSON 备份失败:', e?.message || e);
  }
  // 2. 旧版：1×1 PNG 尾部藏的 JSON（迁移兼容）
  try {
    const r = await plugin().read({ fileName: LEGACY_META_PNG }).catch(() => null);
    if (r?.data) {
      const prefix = base64ToBytes(PNG_PREFIX_B64);
      const bytes = base64ToBytes(r.data);
      const text = new TextDecoder().decode(bytes.subarray(prefix.length));
      const parsed = JSON.parse(text.trim());
      return {
        items: Array.isArray(parsed?.items) ? parsed.items : [],
        hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
        settings: parsed?.settings || {},
      };
    }
  } catch (e) {
    log.debug('[metaBackup] 读取旧版 PNG 备份失败:', e?.message || e);
  }
  return { items: [], hidden: [], settings: {} };
}

/**
 * 重装后恢复：仅当 IndexedDB 完全为空时才从备份导入 喜欢/已保存 记录，
 * 并把备份里的 cookie 写回（当前为空时才覆盖）。幂等，可在启动时安全调用。
 */
export async function restoreMetaBackupIfNeeded() {
  if (!isNative()) return;
  try {
    const existing = await getAllMeta().catch(() => []);
    if (Array.isArray(existing) && existing.length > 0) return; // 非全新安装，不覆盖

    const { items, hidden, settings } = await readMetaBackup();
    if (items.length === 0 && !settings.pixivCookie) return;

    if (Array.isArray(hidden) && hidden.length > 0) {
      hiddenWorks.replace(hidden);
      log.info('[metaBackup] 已恢复', hidden.length, '条"不想看"隐藏');
    }

    if (items.length > 0) {
      const records = items.map(it => {
        const entity = new PixivEntity({
          id: PixivEntity.makeId(it.illustId, it.pageIndex ?? 0),
          illustId: it.illustId,
          pageIndex: it.pageIndex ?? 0,
          type: it.type === 'gif' ? 'gif' : 'image',
          state: it.state === 'saved' ? 'saved' : 'cached',
          title: it.title || '',
          author: it.author || '',
          authorName: it.authorName || it.author || '',
          authorId: it.authorId || '',
          likedAt: it.likedAt || 0,
          fileName: it.fileName || '',
          cachedAt: it.cachedAt || 0,
          tags: Array.isArray(it.tags) ? it.tags : [],
        });
        return entity.toRecord();
      });
      await putMetaBatch(records);
      log.info('[metaBackup] 已从备份恢复', records.length, '条喜欢/已保存');
    }

    if (settings.pixivCookie) {
      const cur = getSettingsSync();
      if (!cur.pixivCookie) {
        await saveSettings({ ...cur, pixivCookie: settings.pixivCookie });
        log.info('[metaBackup] 已恢复 Cookie');
      }
    }
  } catch (e) {
    log.warn('[metaBackup] 恢复失败:', e?.message || e);
  }
}

/**
 * 相册对账（每次启动调用）：扫描 Pictures/TeyvatWhisper 目录，
 * 为「有文件但没有元数据」的保存图补建最小实体（只填 已保存/下载 字段，
 * 标题/作者/tags 留空，后续由浏览时回填补全）。
 * 幂等：已有元数据的文件跳过；纯数字帧文件跳过。
 */
export async function reconcileGallery() {
  if (!isNative()) return;
  try {
    const r = await plugin().listFiles().catch(() => null);
    const names = Array.isArray(r?.files) ? r.files : [];
    if (names.length === 0) return;

    const existing = await getAllMeta().catch(() => []);
    const existingKeys = new Set((existing || []).map(rec => rec.cacheKey));
    const now = Date.now();
    const toAdd = [];

    for (const name of names) {
      // 跳过纯数字帧文件（0.jpg / 1.jpg …）与无关文件
      if (!name || /^\d+\.(jpe?g|png|gif|webp)$/i.test(name)) continue;
      const parsed = parseCacheFileName(name);
      if (!parsed) continue;
      const id = PixivEntity.makeId(parsed.illustId, parsed.pageIndex);
      if (existingKeys.has(id)) continue;
      const type = parsed.isGif ? 'gif' : 'image';
      toAdd.push({
        cacheKey: id,
        illustId: parsed.illustId,
        pageIndex: parsed.pageIndex,
        type,
        state: 'saved',
        fileName: name,
        likedAt: 0,
        cachedAt: now,
      });
      existingKeys.add(id);
    }

    if (toAdd.length > 0) {
      await putMetaBatch(toAdd);
      log.info('[metaBackup] 相册对账：新增', toAdd.length, '条已保存元数据');
      scheduleMetaBackup();
    }
  } catch (e) {
    log.warn('[metaBackup] 相册对账失败:', e?.message || e);
  }
}

/* ── 旧版 PNG 兜底解析（迁移兼容用） ── */
const PNG_PREFIX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
