package com.pixivviewer.app;

import android.content.pm.ApplicationInfo;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.util.Collections;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 仅 debug 构建开启 WebView 远程调试（Chrome DevTools 可直查 DOM），release 不受影响
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        registerPlugin(GallerySaverPlugin.class);
        registerPlugin(StreamingDownloadPlugin.class);
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setScrollBarStyle(WebView.SCROLLBARS_INSIDE_OVERLAY);
            // Android 10+ 全面屏手势导航会抢占左右边缘窄条做「返回」，
            // 前端 useEdgeSwipe 的左缘拉抽屉手势在最边缘收不到 touch。
            // 在左边缘声明一条「系统手势豁免区」把这块让给应用（Gmail 等抽屉应用同款做法）。
            // 平台限制：每边豁免的竖向跨度最多 200dp，放垂直居中一段；
            // 宽度给 32dp，盖过前端 24px 的起手判定带。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                float density = getResources().getDisplayMetrics().density;
                int edgeW = (int) (32 * density);
                int blockH = (int) (200 * density);
                webView.addOnLayoutChangeListener((v, left, top, right, bottom,
                        oldLeft, oldTop, oldRight, oldBottom) -> {
                    int h = v.getHeight();
                    int topY = Math.max(0, (h - blockH) / 2);
                    Rect rect = new Rect(0, topY, edgeW, Math.min(h, topY + blockH));
                    webView.setSystemGestureExclusionRects(Collections.singletonList(rect));
                });
            }
        }
    }
}
