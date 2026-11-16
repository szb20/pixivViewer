package com.pixivviewer.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * 微博图床防盗链拦截 —— sinaimg.cn 校验 Referer 必须是微博域（空 Referer 也 403），
 * WebView 直链发出的 Referer 是 https://localhost，一律被拒。
 *
 * 在 shouldInterceptRequest 里认领 *.sinaimg.cn 的图片请求，用原生 HTTP 带
 * Referer: https://m.weibo.cn/ 重新拉取后把流交还 WebView（该方法跑在 IO 线程，
 * 阻塞拉取是官方预期的用法）。其余请求原样走 Capacitor 的默认处理。
 *
 * 失败时返回 null 交回默认链路（与不拦截时行为一致，最多就是那张图 403）。
 */
public class WeiboWebViewClient extends BridgeWebViewClient {

    private static final String IMG_REFERER = "https://m.weibo.cn/";
    private static final String USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

    public WeiboWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(android.webkit.WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        if (url != null && url.contains(".sinaimg.cn/")) {
            WebResourceResponse res = fetchWithReferer(url);
            if (res != null) return res;
        }
        return super.shouldInterceptRequest(view, request);
    }

    /** 带 Referer 的原生拉取；任何异常返回 null（回落默认链路） */
    private WebResourceResponse fetchWithReferer(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", USER_AGENT);
            conn.setRequestProperty("Referer", IMG_REFERER);
            conn.setRequestProperty("Accept", "image/webp,image/apng,image/*,*/*;q=0.8");

            int code = conn.getResponseCode();
            if (code != 200) return null;

            String contentType = conn.getContentType();
            if (contentType == null) contentType = "image/jpeg";
            String encoding = conn.getContentEncoding();
            InputStream body = conn.getInputStream();

            WebResourceResponse res = new WebResourceResponse(contentType, encoding, body);
            Map<String, String> respHeaders = new HashMap<>();
            respHeaders.put("Cache-Control", "public, max-age=86400");
            res.setResponseHeaders(respHeaders);
            return res;
        } catch (Exception e) {
            return null;
        } finally {
            // conn 不主动 disconnect：流还在被 WebView 消费，disconnect 会掐断它。
        }
    }
}
