/**
 * 桌面端文件系统适配器 —— 实现与 @capacitor/filesystem 相同的 plugin 接口，
 * 底层经 window.desktop.fs 桥落到 Electron 主进程的 Node fs。
 *
 * 这样 FileStore / gif.js 的 ZIP 分块缓存等所有调用 FS.plugin.xxx 的代码
 * 在桌面端无需任何改动（平台差异只在这一层，见 fileStore.js 的设计原则）。
 *
 * 目录映射（directory 参数，对齐 Capacitor Filesystem）：
 * - 'DATA' / 'DOCUMENTS' / 'LIBRARY' → app 数据目录 userData/PixivViewer（缓存/帧）
 * - 'CACHE'                          → 临时缓存目录
 * - 'EXTERNAL' / 'EXTERNAL_STORAGE'  → 用户「图片」目录（导出物，卸载保留）
 */
import { desktop } from './platform.js';

/** Capacitor 目录名 → 桌面桥逻辑目录 */
const DIR_MAP = {
    DATA: 'data',
    DOCUMENTS: 'data',
    LIBRARY: 'data',
    CACHE: 'cache',
    EXTERNAL: 'pictures',
    EXTERNAL_STORAGE: 'pictures',
};

function resolveDir(directory) {
    return DIR_MAP[directory] || 'data';
}

/** 把 Capacitor 风格的 { path, directory } 归一为传给主进程的 { dir, relPath } */
function target({ path = '', directory = 'DATA' } = {}) {
    return { dir: resolveDir(directory), relPath: path };
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export function createDesktopFilesystem() {
    const fs = desktop.fs;

    return {
        async mkdir({ path, directory, recursive = true } = {}) {
            await fs.mkdir({ ...target({ path, directory }), recursive });
        },

        async writeFile({ path, directory, data, encoding } = {}) {
            const { dir, relPath } = target({ path, directory });
            if (encoding === 'utf8' || typeof data === 'string' && !looksBase64(data)) {
                // utf8 文本（如 meta.json）
                await fs.writeText({ dir, relPath, text: String(data) });
            } else {
                await fs.writeFile({ dir, relPath, base64: data });
            }
        },

        async appendFile({ path, directory, data } = {}) {
            const { dir, relPath } = target({ path, directory });
            await fs.appendFile({ dir, relPath, base64: data });
        },

        /** 返回 { data: base64 }（二进制）或字符串（utf8），对齐 Capacitor readFile */
        async readFile({ path, directory, encoding } = {}) {
            const { dir, relPath } = target({ path, directory });
            if (encoding === 'utf8') {
                const text = await fs.readText({ dir, relPath });
                return { data: text };
            }
            const base64 = await fs.readFile({ dir, relPath });
            return { data: base64 };
        },

        async deleteFile({ path, directory } = {}) {
            await fs.deleteFile(target({ path, directory }));
        },

        async readdir({ path, directory } = {}) {
            const files = await fs.readdir(target({ path, directory }));
            // 对齐 Capacitor：files 为 [{ name, type, size, mtime }]
            return { files };
        },

        async stat({ path, directory } = {}) {
            const st = await fs.stat(target({ path, directory }));
            // 对齐 Capacitor stat：{ type, size, mtime, ctime, uri }
            return { type: st.isDirectory ? 'directory' : 'file', size: st.size, mtime: st.mtime, ctime: st.ctime, uri: '' };
        },

        /**
         * 分块读取（gif.js ZIP 流式解压用）。回调 (chunk, err)，空块表示结束。
         * 主进程一次性读入并按 chunkSize 切片回传（ZIP 已限 40MB，可接受）。
         */
        async readFileInChunks({ path, directory, chunkSize = 2 * 1024 * 1024 } = {}, onChunk) {
            try {
                const { dir, relPath } = target({ path, directory });
                const base64 = await fs.readFile({ dir, relPath });
                const bytes = b64ToBytes(base64);
                for (let off = 0; off < bytes.length; off += chunkSize) {
                    const slice = bytes.subarray(off, off + chunkSize);
                    onChunk?.({ data: bytesToB64(slice) }, null);
                }
                onChunk?.({ data: '' }, null); // 空块 = 文件结束
            } catch (err) {
                onChunk?.(null, err);
            }
        },
    };
}

/** 粗判字符串是否为 base64（utf8 文本如 JSON 含空格/标点/中文，不会全落在 base64 字符集） */
function looksBase64(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(s);
}