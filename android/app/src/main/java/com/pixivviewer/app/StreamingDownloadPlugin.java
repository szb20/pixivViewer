package com.pixivviewer.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 流式下载插件 — 原生 HttpURLConnection 下载，向 JS 上报真实字节进度。
 *
 * 为什么需要原生：WebView 里 fetch/XHR 跨域读 i.pixiv.re 被 CORS 拦截，
 * CapacitorHttp 又没有进度事件；原生 HTTP 不受 CORS 限制、能拿到字节进度。
 */
@CapacitorPlugin(name = "StreamingDownload")
public class StreamingDownloadPlugin extends Plugin {

    private void resolveOnMain(PluginCall call, JSObject ret) {
        try {
            getActivity().runOnUiThread(() -> call.resolve(ret));
        } catch (Exception e) {
            call.resolve(ret);
        }
    }

    private void rejectOnMain(PluginCall call, String msg) {
        try {
            getActivity().runOnUiThread(() -> call.reject(msg));
        } catch (Exception e) {
            call.reject(msg);
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String id = call.getString("id", url != null ? url : "");
        String referer = call.getString("referer", "https://www.pixiv.net/");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }

        Thread thread = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Referer", referer);
                conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36");
                conn.setRequestProperty("Accept", "image/*,*/*;q=0.8");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(120000);

                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    rejectOnMain(call, "HTTP " + code);
                    return;
                }

                long total = conn.getContentLengthLong();
                InputStream input = conn.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int read;
                long downloaded = 0;
                int lastPct = -1;
                long lastNotify = 0;
                while ((read = input.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    downloaded += read;
                    if (total > 0) {
                        int pct = (int) (downloaded * 100 / total);
                        if (pct != lastPct) {
                            long now = System.currentTimeMillis();
                            // 节流：最快每 50ms 通知一次，结束强制补 100
                            if (pct == 100 || now - lastNotify >= 50) {
                                lastNotify = now;
                                lastPct = pct;
                                int finalPct = pct;
                                try {
                                    getActivity().runOnUiThread(() -> {
                                        JSObject prog = new JSObject();
                                        prog.put("id", id);
                                        prog.put("progress", finalPct);
                                        notifyListeners("onProgress", prog);
                                    });
                                } catch (Exception ignored) {
                                    // 进度通知失败不影响下载主流程
                                }
                            }
                        }
                    }
                }
                input.close();

                byte[] bytes = out.toByteArray();
                String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                JSObject ret = new JSObject();
                ret.put("id", id);
                ret.put("data", base64);
                ret.put("size", downloaded);
                resolveOnMain(call, ret);
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : "download failed";
                rejectOnMain(call, msg);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
        thread.setDaemon(true);
        thread.start();
    }
}
