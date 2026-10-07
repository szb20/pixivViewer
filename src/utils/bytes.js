/**
 * 通用字节工具 — 分块 base64 编解码与 Uint8Array 拼接。
 *
 * 全部按块处理（0x8000），避免一次性生成整份巨型二进制字符串撑爆 WebView 堆
 * （Android WebView 的字符串上限远低于桌面浏览器）。
 */

/** 拼接多个 Uint8Array */
export function concatBytes(parts) {
  const total = parts.reduce((a, c) => a + (c?.byteLength || 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (!p?.byteLength) continue;
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** 分块 base64 → 字节（避免一次性生成整份巨型二进制字符串） */
export function base64ToBytes(base64) {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLen = ((base64.length / 4) * 3) - pad;
  const bytes = new Uint8Array(byteLen);
  let pos = 0;
  for (let i = 0; i < base64.length; i += 0x8000) {
    const chunk = atob(base64.slice(i, i + 0x8000));
    for (let j = 0; j < chunk.length; j++) bytes[pos++] = chunk.charCodeAt(j);
  }
  return bytes;
}

/** 分块字节 → base64 */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
