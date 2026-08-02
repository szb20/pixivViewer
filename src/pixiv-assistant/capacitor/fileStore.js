/**
 * FileStore — 文件操作 + 路径规则。
 *
 * 核心原则：
 * - 不对外暴露路径规则
 * - 上层只传 entity + state，内部决定文件在哪
 * - 平台差异（Android / Desktop / iOS）只影响这一层
 */
import { getFS } from './config.js';
import { CACHE_DIR } from '../core/constants.js';
import { safeFileName } from '../core/utils.js';

/** 本会话已确认存在的目录（directoryType:dir），避免每次保存都重复 mkdir */
const ensuredDirs = new Set();

/**
 * 确保目录存在（幂等）。
 * Capacitor Filesystem 在 Android 上对已存在的目录会报 OS-PLUG-FILE-0010
 * （即使传了 recursive: true），这里把「已存在」视为成功并缓存到会话集合，
 * 避免每次保存都重复 mkdir / 刷错误日志。
 * @param {{ plugin: import('@capacitor/filesystem').FilesystemPlugin }} FS
 * @param {string} dir
 * @param {string} dirType
 * @returns {Promise<boolean>}
 */
export async function ensureDirectory(FS, dir, dirType) {
  const key = `${dirType}:${dir}`;
  if (ensuredDirs.has(key)) return true;
  try {
    await FS.plugin.mkdir({ path: dir, directory: dirType, recursive: true });
    ensuredDirs.add(key);
    return true;
  } catch (err) {
    const message = err?.message || String(err);
    const alreadyExists = err?.code === 'OS-PLUG-FILE-0010' || /already exists/i.test(message);
    if (alreadyExists) {
      ensuredDirs.add(key);
      return true;
    }
    console.warn('[ensureDirectory] 无法创建目录，继续尝试写入:', dir, message);
    return false;
  }
}

export class FileStore {
  /**
   * 保存文件（从 base64 数据写入文件系统）。
   * @param {PixivEntity} entity
   * @param {string} data — base64 数据
   * @param {'cached'|'saved'} [state] — 不传则用 entity.state
   * @returns {Promise<boolean>}
   */
  async save(entity, data, state) {
    try {
      const FS = await getFS();
      if (!FS) { console.error('[FileStore.save] getFS 返回空 — Filesystem 不可用'); return false; }
      if (!data) { console.error('[FileStore.save] data 为空'); return false; }
      if (!entity?.fileName) { console.error('[FileStore.save] entity.fileName 为空', entity); return false; }
      const targetState = state || entity.state;
      const { dir, dirType } = this._resolveDir(targetState);
      await ensureDirectory(FS, dir, dirType);
      await FS.plugin.writeFile({ path: `${dir}/${entity.fileName}`, data, directory: dirType });
      return true;
    } catch (e) {
      console.error('[FileStore.save] writeFile 失败:', e?.message || e);
      return false;
    }
  }

  /**
   * 加载文件，返回 blob URL。
   * @param {PixivEntity} entity
   * @returns {Promise<{localUrl: string, data: string}|null>}
   */
  async load(entity) {
    try {
      const FS = await getFS();
      if (!FS || !entity.fileName) return null;
      const { dir, dirType } = this._resolveDir(entity.state);
      const raw = await FS.plugin.readFile({
        path: `${dir}/${entity.fileName}`, directory: dirType,
      }).catch(() => null);
      if (!raw) return null;

      const data = typeof raw === 'string' ? raw : raw.data || '';
      if (!data) return null;

      const ext = (entity.fileName || '').split('.').pop()?.toLowerCase() || 'jpg';
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mimeType = mimeMap[ext] || 'image/jpeg';
      const blob = new Blob([new Uint8Array(await this._base64ToBuf(data))], { type: mimeType });
      return { localUrl: URL.createObjectURL(blob), data };
    } catch {
      return null;
    }
  }

  /**
   * 复制文件（从源状态目录到目标状态目录）。
   * @param {PixivEntity} entity
   * @param {'cached'|'saved'} fromState
   * @param {'cached'|'saved'} toState
   * @returns {Promise<boolean>}
   */
  async copy(entity, fromState, toState) {
    try {
      const FS = await getFS();
      if (!FS || !entity.fileName) return false;
      const { dir: srcDir, dirType: srcType } = this._resolveDir(fromState);
      const { dir: dstDir, dirType: dstType } = this._resolveDir(toState);

      const raw = await FS.plugin.readFile({
        path: `${srcDir}/${entity.fileName}`, directory: srcType,
      }).catch(() => null);
      if (!raw) return false;

      const data = typeof raw === 'string' ? raw : raw.data || '';
      await ensureDirectory(FS, dstDir, dstType);
      await FS.plugin.writeFile({ path: `${dstDir}/${entity.fileName}`, data, directory: dstType });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除文件。
   * @param {PixivEntity} entity
   * @param {'cached'|'saved'} [state] — 不传则用 entity.state
   * @returns {Promise<boolean>}
   */
  async delete(entity, state) {
    try {
      const FS = await getFS();
      if (!FS || !entity.fileName) return false;
      const targetState = state || entity.state;
      const { dir, dirType } = this._resolveDir(targetState);
      await FS.plugin.deleteFile({ path: `${dir}/${entity.fileName}`, directory: dirType }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 移动文件（copy + delete source）。
   * @param {PixivEntity} entity
   * @param {'cached'|'saved'} fromState
   * @param {'cached'|'saved'} toState
   * @returns {Promise<boolean>}
   */
  async move(entity, fromState, toState) {
    const copied = await this.copy(entity, fromState, toState);
    if (!copied) return false;
    await this.delete(entity, fromState);
    return true;
  }

  /**
   * 获取文件 base64 数据。
   * @param {PixivEntity} entity
   * @returns {Promise<string|null>}
   */
  async readData(entity) {
    try {
      const FS = await getFS();
      if (!FS || !entity.fileName) return null;
      const { dir, dirType } = this._resolveDir(entity.state);
      const raw = await FS.plugin.readFile({
        path: `${dir}/${entity.fileName}`, directory: dirType,
      }).catch(() => null);
      if (!raw) return null;
      return typeof raw === 'string' ? raw : raw.data || '';
    } catch {
      return null;
    }
  }

  /**
   * 检查文件是否存在。
   * @param {PixivEntity} entity
   * @returns {Promise<boolean>}
   */
  async exists(entity) {
    try {
      const FS = await getFS();
      if (!FS || !entity.fileName) return false;
      const { dir, dirType } = this._resolveDir(entity.state);
      const raw = await FS.plugin.readFile({
        path: `${dir}/${entity.fileName}`, directory: dirType,
      }).catch(() => null);
      return !!raw;
    } catch {
      return false;
    }
  }

  /**
   * 生成文件名。
   * 格式：pixiv_{illustId}_p{pageIndex}_[{author}]_[{title}].{ext}
   * 动图扩展名用 .gif。
   * @param {PixivEntity} entity
   * @returns {string}
   */
  buildFileName(entity) {
    const ext = entity.isGif ? 'gif' : 'jpg';
    const safeAuthor = safeFileName(entity.authorName || '');
    const safeTitle = safeFileName(entity.title || entity.illustId || '');
    const authorPart = safeAuthor ? `[${safeAuthor}]` : '[]';
    const titlePart = safeTitle ? `[${safeTitle}]` : '[]';
    return `pixiv_${entity.illustId}_p${entity.pageIndex}_${authorPart}_${titlePart}.${ext}`
      .replace(/_+/g, '_').slice(0, 200);
  }

  // ── 私有方法 ──

  /**
   * 解析路径规则。
   * cached → DATA/pixiv_cache
   * saved  → DOCUMENTS/TeyvatWhisper
   */
  _resolveDir(state) {
    if (state === 'saved') {
      return { dir: CACHE_DIR, dirType: 'DOCUMENTS' };
    }
    // cached 状态统一走 DOCUMENTS（统一存储后不再区分）
    return { dir: CACHE_DIR, dirType: 'DOCUMENTS' };
  }

  async _base64ToBuf(raw) {
    const data = typeof raw === 'string' ? raw : raw?.data || '';
    if (!data) return null;
    const resp = await fetch(`data:application/octet-stream;base64,${data}`);
    return await resp.arrayBuffer();
  }
}
