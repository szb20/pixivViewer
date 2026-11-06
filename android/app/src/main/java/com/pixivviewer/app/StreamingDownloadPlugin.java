package com.pixivviewer.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.Arrays;

/**
 * 流式下载插件 — 原生 HttpURLConnection 下载，绕开 WebView 对 i.pixiv.re 的
 * CORS 限制（fetch/XHR 跨域读不到字节），且能按字节汇报真实进度。
 *
 * 数据以拉模式分块过桥：startStream 打开连接 → JS 循环 readChunk（每块 ≤512KB
 * base64）→ EOF / 失败后 closeStream。整份 base64 过桥在 WebView 有 OOM 风险
 * （同 GallerySaverPlugin 分块写入的教训：40MB 文件经桥传整包会产生 ~53MB 字符串
 * 峰值），拉模式还天然保证顺序与背压，进度由 JS 按累计字节自行计算。
 */
@CapacitorPlugin(name = "StreamingDownload")
public class StreamingDownloadPlugin extends Plugin {

    /** 单块大小（字节）：512KB → 过桥 base64 峰值约 700KB */
    private static final int CHUNK_BYTES = 512 * 1024;

    /** 下载会话：id → 打开中的连接与输入流 */
    private final Map<String, HttpURLConnection> sessionConns = new HashMap<>();
    private final Map<String, InputStream> sessionStreams = new HashMap<>();

    private void resolveOnMain(PluginCall call, JSObject ret) {
        try {
            getActivity().runOnUiThread(() -> call.resolve(ret));
        } catch (Exception e) {
            call.resolve(ret);
        }
    }

    /** 带错误码 reject（code 供 JS 侧等值判断，如 bad_request / http_404 / no_session） */
    private void rejectOnMain(PluginCall call, String msg, String code) {
        try {
            getActivity().runOnUiThread(() -> call.reject(msg, code));
        } catch (Exception e) {
            call.reject(msg, code);
        }
    }

    /** 打开下载连接，返回 Content-Length；之后 JS 反复 readChunk 拉取分块 */
    @PluginMethod
    public void startStream(PluginCall call) {
        String url = call.getString("url");
        String id = call.getString("id", url != null ? url : "");
        String referer = call.getString("referer", "https://www.pixiv.net/");
        if (url == null || url.isEmpty()) {
            call.reject("url required", "bad_request");
            return;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("GET");
            // 空串 = 不发送 Referer（非 Pixiv 图床不校验，白送 pixiv.net 的假 Referer 反而奇怪）
            if (referer != null && !referer.isEmpty()) {
                conn.setRequestProperty("Referer", referer);
            }
            conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36");
            conn.setRequestProperty("Accept", "image/*,*/*;q=0.8");
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(120000);

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                conn.disconnect();
                rejectOnMain(call, "HTTP " + code, "http_" + code);
                return;
            }
            long total = conn.getContentLengthLong();
            InputStream in = conn.getInputStream();
            closeQuietly(id); // 同 id 残留会话（理论不会发生，兜底）
            synchronized (sessionConns) {
                sessionConns.put(id, conn);
                sessionStreams.put(id, in);
            }
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("total", total);
            resolveOnMain(call, ret);
        } catch (Exception e) {
            if (conn != null) conn.disconnect();
            String msg = e.getMessage() != null ? e.getMessage() : "startStream failed";
            rejectOnMain(call, msg, "start_failed");
        }
    }

    /** 读取下一块（≤ size 字节，返回 base64）；读到 EOF 返回 eof=true 并自动清理会话 */
    @PluginMethod
    public void readChunk(PluginCall call) {
        String id = call.getString("id");
        int size = call.getInt("size", CHUNK_BYTES);
        if (id == null || id.isEmpty()) {
            call.reject("id required", "bad_request");
            return;
        }
        InputStream in;
        synchronized (sessionConns) {
            in = sessionStreams.get(id);
        }
        if (in == null) {
            call.reject("会话不存在，请先 startStream", "no_session");
            return;
        }
        try {
            byte[] buf = new byte[size];
            int read = 0;
            while (read < buf.length) {
                int n = in.read(buf, read, buf.length - read);
                if (n == -1) break;
                read += n;
            }
            JSObject ret = new JSObject();
            if (read == 0) {
                // EOF：自动清理会话（JS 收到 eof 后不再 readChunk；closeStream 幂等）
                closeQuietly(id);
                ret.put("eof", true);
                ret.put("data", "");
                resolveOnMain(call, ret);
                return;
            }
            ret.put("eof", false);
            ret.put("data", Base64.encodeToString(
                read == buf.length ? buf : Arrays.copyOf(buf, read), Base64.NO_WRAP));
            resolveOnMain(call, ret);
        } catch (Exception e) {
            closeQuietly(id);
            String msg = e.getMessage() != null ? e.getMessage() : "readChunk failed";
            rejectOnMain(call, msg, "read_failed");
        }
    }

    /** 关闭会话（EOF 后 / 失败 / 中止时调用；幂等） */
    @PluginMethod
    public void closeStream(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("id required", "bad_request");
            return;
        }
        closeQuietly(id);
        call.resolve(new JSObject());
    }

    private void closeQuietly(String id) {
        HttpURLConnection conn;
        InputStream in;
        synchronized (sessionConns) {
            conn = sessionConns.remove(id);
            in = sessionStreams.remove(id);
        }
        try {
            if (in != null) in.close();
        } catch (Exception ignored) {
        }
        if (conn != null) conn.disconnect();
    }
}
