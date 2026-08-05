/**
 * metaBackup — 喜欢/已保存 元数据 + Cookie 的持久备份。
 *
 * 问题：IndexedDB 位于应用私有 WebView 数据，卸载即清空；而系统相册文件保留。
 * 方案：把「喜欢/已保存」元数据 + cookie 写成一个真正的 JSON 文件，
 *      通过原生 GallerySaver.writeMeta 存到「下载」集合（Download/TeyvatWhisper/），
 *      随系统存储一起存活；重装后若 IndexedDB 为空则从备份自动恢复。
 */
import { Capacitor } from '@capacitor/core';
import { getAllMeta, getMeta, putMeta, putMetaBatch } from './cacheDB.js';
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
    // 同时写一份相册副本（1×1 PNG 尾部藏 JSON）：
    // 卸载重装后 MediaStore Downloads 行对新 UID 不可见，而 Pictures 媒体行可见，
    // 相册副本是跨重装恢复的关键载体。
    try {
      const oldPngs = await S.listMetaPngs().then(r => r?.files, () => []);
      if (Array.isArray(oldPngs)) {
        for (const name of oldPngs) {
          await S.delete({ fileName: name }).catch(() => {});
        }
      }
      await S.save({ fileName: LEGACY_META_PNG, data: buildMetaPng(payload), mimeType: 'image/png' });
    } catch (e) {
      log.warn('[metaBackup] 写入相册备份失败:', e?.message || e);
    }
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

/** 合并多份备份条目：按作品去重，likedAt 取任意一份的最大值，元数据取最全的一份 */
function mergeBackupItems(entries) {
  const byKey = new Map();
  for (const it of entries) {
    if (!it?.illustId) continue;
    const key = `pixiv:${it.illustId}:${it.pageIndex ?? 0}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...it });
      continue;
    }
    const merged = { ...prev };
    // 喜欢状态：只要任意一份备份标记过喜欢，就保留（0 永远不覆盖 >0）
    merged.likedAt = Math.max(prev.likedAt || 0, it.likedAt || 0);
    if ((it.cachedAt || 0) > (merged.cachedAt || 0)) merged.cachedAt = it.cachedAt;
    if (it.state === 'saved' && merged.state !== 'saved') merged.state = 'saved';
    for (const f of ['title', 'author', 'authorName', 'authorId', 'fileName', 'type']) {
      if (!merged[f] && it[f]) merged[f] = it[f];
    }
    if (Array.isArray(it.tags) && it.tags.length
      && !(Array.isArray(merged.tags) && merged.tags.length)) {
      merged.tags = it.tags;
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

/** 合并多份备份的 items / hidden / settings */
function mergeBackupMeta(list) {
  const out = { items: [], hidden: [], settings: {} };
  for (const item of list) {
    out.items = mergeBackupItems([...out.items, ...(Array.isArray(item?.items) ? item.items : [])]);
    const hidden = Array.isArray(item?.hidden) ? item.hidden : [];
    for (const h of hidden) {
      if (!out.hidden.includes(h)) out.hidden.push(h);
    }
    const cookie = item?.settings?.pixivCookie;
    if (cookie && !out.settings.pixivCookie) out.settings.pixivCookie = cookie;
  }
  return out;
}

/** 解析 v1/v3/v4 格式的 JSON 备份为统一结构（v1 旧格式字段是 entities） */
function parseBackupJSON(data) {
  const parsed = JSON.parse(data);
  if (Array.isArray(parsed?.items)) {
    return {
      items: parsed.items,
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
      settings: parsed?.settings || {},
    };
  }
  if (Array.isArray(parsed?.entities)) {
    return {
      items: parsed.entities.map(e => ({
        illustId: e.illustId,
        pageIndex: e.pageIndex ?? 0,
        type: e.type || 'image',
        state: e.state === 'saved' ? 'saved' : 'cached',
        title: e.title || '',
        author: e.author || '',
        authorName: e.authorName || e.author || '',
        authorId: e.authorId || '',
        likedAt: e.likedAt || 0,
        fileName: e.fileName || '',
        cachedAt: e.cachedAt || 0,
        tags: Array.isArray(e.tags) ? e.tags : [],
      })),
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
      settings: parsed?.settings || {},
    };
  }
  return { items: [], hidden: [], settings: {} };
}

/** 读取并合并全部备份（多份 JSON + 旧版 v1 + 旧版 PNG 兜底）。无备份/失败返回空。 */
export async function readMetaBackup() {
  if (!isNative()) return { items: [], hidden: [], settings: {} };
  const parsed = [];

  // 1. 枚举 Downloads 里全部 pixiv_meta*.json / pixivviewer-meta-backup.json 并逐份读取
  try {
    const names = await plugin().listMetaFiles().then(r => r?.files, () => []);
    const targets = Array.isArray(names) ? names : [];
    for (const name of targets) {
      try {
        const r = await plugin().readMeta({ fileName: name }).catch(() => null);
        if (r?.data) parsed.push(parseBackupJSON(r.data));
      } catch (e) {
        log.debug('[metaBackup] 解析备份失败:', name, e?.message || e);
      }
    }
  } catch (e) {
    log.debug('[metaBackup] 枚举备份失败:', e?.message || e);
  }

  // 2. 相册里的 PNG 备份（Pictures 集合，卸载重装后仍可见；枚举全部副本并合并）
  try {
    const names = await plugin().listMetaPngs().then(r => r?.files, () => []);
    const targets = Array.isArray(names) ? names : [];
    for (const name of targets) {
      try {
        const r = await plugin().read({ fileName: name }).catch(() => null);
        if (!r?.data) continue;
        const prefix = base64ToBytes(PNG_PREFIX_B64);
        const bytes = base64ToBytes(r.data);
        const text = new TextDecoder().decode(bytes.subarray(prefix.length));
        parsed.push(parseBackupJSON(text.trim()));
      } catch (e) {
        log.debug('[metaBackup] 解析相册备份失败:', name, e?.message || e);
      }
    }
  } catch (e) {
    log.debug('[metaBackup] 枚举相册备份失败:', e?.message || e);
  }

  return mergeBackupMeta(parsed);
}

/**
 * 重装后恢复：仅当 IndexedDB 完全为空时才从备份导入 喜欢/已保存 记录，
 * 并把备份里的 cookie 写回（当前为空时才覆盖）。幂等，可在启动时安全调用。
 */
export async function restoreMetaBackupIfNeeded() {
  if (!isNative()) return;
  try {
    const existing = await getAllMeta().catch(() => []);
    const { items, hidden, settings } = await readMetaBackup();
    const likedFromBackup = (items || []).filter(it => (it.likedAt || 0) > 0);
    const existingLikedCount = (existing || []).filter(r => (r.likedAt || 0) > 0).length;

    // 全新安装：库为空 → 全量导入；库已有 saved 但一条喜欢都没有、而备份里有喜欢
    // → 只合并喜欢标记（自愈：首次启动相册权限未就绪导致读不到备份的场景）。
    const freshInstall = !Array.isArray(existing) || existing.length === 0;
    const needLikeMerge = !freshInstall && existingLikedCount === 0 && likedFromBackup.length > 0;
    if (!freshInstall && !needLikeMerge) return; // 非全新安装且喜欢数据已存在，不覆盖
    if (freshInstall && items.length === 0 && !settings.pixivCookie) return;

    if (Array.isArray(hidden) && hidden.length > 0) {
      hiddenWorks.replace(hidden);
      log.info('[metaBackup] 已恢复', hidden.length, '条"不想看"隐藏');
    }

    if (needLikeMerge) {
      // 只合并喜欢标记：已有记录仅抬升 likedAt 并回填缺失元数据，缺失的建轻记录
      let mergedCount = 0;
      for (const it of likedFromBackup) {
        const id = PixivEntity.makeId(it.illustId, it.pageIndex ?? 0);
        const rec = await getMeta(id);
        if (rec) {
          if ((rec.likedAt || 0) >= (it.likedAt || 0)) continue;
          rec.likedAt = it.likedAt;
          if (!rec.title && it.title) rec.title = it.title;
          if (!rec.authorName && (it.authorName || it.author)) {
            rec.authorName = it.authorName || it.author;
            rec.author = it.author || it.authorName || '';
          }
          if (!rec.authorId && it.authorId) rec.authorId = it.authorId;
          await putMeta(rec);
          mergedCount++;
        } else {
          const light = new PixivEntity({
            id,
            illustId: it.illustId,
            pageIndex: it.pageIndex ?? 0,
            type: it.type === 'gif' ? 'gif' : 'image',
            state: it.state === 'saved' ? 'saved' : 'cached',
            title: it.title || '',
            author: it.author || it.authorName || '',
            authorName: it.authorName || it.author || '',
            authorId: it.authorId || '',
            likedAt: it.likedAt,
            fileName: it.fileName || '',
            cachedAt: it.cachedAt || Date.now(),
            tags: Array.isArray(it.tags) ? it.tags : [],
          });
          await putMeta(light.toRecord());
          mergedCount++;
        }
      }
      log.info('[metaBackup] 已合并喜欢标记', mergedCount, '条（备份', likedFromBackup.length, '条）');
    } else if (items.length > 0) {
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

/** 把 JSON 备份包裹进 1×1 PNG 尾部，作为相册集合里的跨重装备份副本 */
function buildMetaPng(payload) {
  const prefix = base64ToBytes(PNG_PREFIX_B64);
  const json = new TextEncoder().encode(payload);
  const out = new Uint8Array(prefix.length + json.length);
  out.set(prefix, 0);
  out.set(json, prefix.length);
  let bin = '';
  for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
  return btoa(bin);
}
