/**
 * Pixiv API 请求基础设施 — 统一 HTTP 传输、Cookie 注入、CSRF token、错误分类。
 * 与具体业务端点无关；端点分组模块只依赖这里暴露的方法。
 */

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_HEADERS = {
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
    'Referer': 'https://www.pixiv.net/',
};

// CSRF token 缓存：从页面 HTML 的 api.token 提取，10 分钟内复用（跨 api 实例共享）
let csrfTokenCache = { token: '', ts: 0 };
const CSRF_TTL = 10 * 60 * 1000;

/** 需要重取 CSRF token 的 HTTP 状态码（token 可能失效） */
export function isCsrfRetryable(err) {
    return /HTTP\s+(400|401|403|405|422)/.test(err?.message || '');
}

export function createApiClient(transport) {
    /**
     * 统一 HTTP 请求。
     * @param {string} pathname — API 路径，如 '/ajax/search/artworks/...'
     * @param {Object} [opts]
     * @param {Object} [opts.headers] — 额外请求头
     * @param {number} [opts.timeout] — 超时（ms）
     * @param {boolean} [opts.skipCookie] — 跳过自动注入 Cookie
     * @returns {Promise<Object>} 解析后的 JSON
     */
    async function apiFetch(pathname, opts = {}) {
        const { headers: extraHeaders = {}, timeout, skipCookie, method = 'GET', body, raw = false } = opts;
        const headers = { ...DEFAULT_HEADERS, 'User-Agent': DESKTOP_UA };

        // 自动注入 Cookie（除非显式跳过）
        if (!skipCookie) {
            const cookie = await transport.getCookie();
            if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;
        }

        Object.assign(headers, extraHeaders);

        return transport.fetch(pathname, { headers, timeout, method, body, raw });
    }

    /** 确保有 Cookie，否则返回错误对象 */
    async function ensureCookie() {
        const cookie = await transport.getCookie();
        if (!cookie) {
            return { error: 'no_cookie', message: '请先在设置中填写 Pixiv Cookie (PHPSESSID)' };
        }
        return { cookie };
    }

    /** 获取 Pixiv CSRF token：GET 任意页面 HTML，提取 api.token，带 10 分钟缓存 */
    async function getCsrfToken() {
        const now = Date.now();
        if (csrfTokenCache.token && now - csrfTokenCache.ts < CSRF_TTL) return csrfTokenCache.token;
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) throw new Error(cookieCheck.message || 'no_cookie');
        const html = await apiFetch('/', {
            headers: { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` },
            raw: true,
            timeout: 20000,
        });
        const text = typeof html === 'string' ? html : String(html || '');
        const unescaped = text.replace(/\\"/g, '"');
        const m = unescaped.match(/"token"\s*:\s*"([a-f0-9]+)"/);
        if (!m) throw new Error('csrf_token_missing');
        csrfTokenCache = { token: m[1], ts: Date.now() };
        return m[1];
    }

    /** 清空 CSRF token 缓存（请求被拒时强制下次重取） */
    function invalidateCsrfToken() {
        csrfTokenCache = { token: '', ts: 0 };
    }

    /** 分类错误信息，返回中文友好提示 */
    function classifyError(err, context = '') {
        if (!err) return '未知错误';
        const msg = err.message || String(err);
        // 网络错误
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_NETWORK') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('网络错误') || msg.includes('timeout') || msg.includes('Timeout') || msg.includes('TIMEOUT') || msg.includes('abort') || msg.includes('Abort')) {
            return `网络连接失败${context ? `（${context}）` : ''}，请检查网络或代理设置`;
        }
        // HTTP 状态码错误
        const httpMatch = msg.match(/HTTP\s+(\d+)/);
        if (httpMatch) {
            const code = parseInt(httpMatch[1]);
            if (code === 403) return 'Pixiv 拒绝访问，Cookie 可能已过期或需要更新';
            if (code === 404) return `作品未找到${context ? `（${context}）` : ''}，可能已被删除或下架`;
            if (code === 429) return '请求过于频繁，请稍后再试';
            if (code >= 500) return 'Pixiv 服务器暂时不可用，请稍后重试';
            return `请求失败（HTTP ${code}）${context ? `（${context}）` : ''}`;
        }
        // 应用层错误
        if (msg.includes('no_cookie') || msg.includes('Cookie')) return '请先在设置中填写 Pixiv Cookie (PHPSESSID)';
        if (msg.includes('auth_failed')) return 'Cookie 格式无效，请重新设置';
        if (msg.includes('not_ugoira')) return '该作品不是动图';
        if (msg.includes('no_zip_url')) return '无法获取动图数据';
        return msg;
    }

    return {
        apiFetch,
        ensureCookie,
        getCsrfToken,
        invalidateCsrfToken,
        classifyError,
    };
}