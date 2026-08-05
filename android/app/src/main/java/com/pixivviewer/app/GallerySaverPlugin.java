package com.pixivviewer.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 保存图片到系统相册（MediaStore）。
 * Android 10+ 通过 MediaStore 写入无需任何存储权限，文件进入 Pictures/TeyvatWhisper，
 * 系统相册立即可见（与旧版 TeyvatWhisper 应用行为一致）。
 */
@CapacitorPlugin(
    name = "GallerySaver",
    permissions = {
        @Permission(strings = {Manifest.permission.WRITE_EXTERNAL_STORAGE}, alias = "storage"),
        @Permission(strings = {
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_EXTERNAL_STORAGE
        }, alias = "read")
    }
)
public class GallerySaverPlugin extends Plugin {

    // 注意：MediaStore 实际存储的 RELATIVE_PATH 带尾斜杠（Pictures/TeyvatWhisper/），
    // 查询必须用带斜杠的值，否则 read/exists/delete 全部匹配不到。
    private static final String RELATIVE_PATH = "Pictures/TeyvatWhisper/";
    // 应用元数据备份（JSON）存到「下载」集合：任意 MIME 都接受，卸载后保留
    private static final String META_RELATIVE_PATH = "Download/TeyvatWhisper/";
    // 通用 Files 集合：接受任意 MIME（无损 ZIP 副本用，与图片/动图同目录 Pictures/TeyvatWhisper）
    private static final Uri FILES_URI = MediaStore.Files.getContentUri("external");

    /**
     * 确保存储权限。
     * Android 10+（API 29+）MediaStore 免权限，直接放行；
     * Android ≤10 需要 WRITE_EXTERNAL_STORAGE（弹出系统权限申请）。
     */
    @PluginMethod
    public void ensurePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("storage", call, "storagePermissionCallback");
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        boolean granted = getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    /**
     * 确保读取相册的权限。
     * Android 13+（API 33+）需要 READ_MEDIA_IMAGES；更早版本需要 READ_EXTERNAL_STORAGE。
     */
    @PluginMethod
    public void ensureReadPermission(PluginCall call) {
        String perm = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? Manifest.permission.READ_MEDIA_IMAGES
            : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (getContext().checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("read", call, "readPermissionCallback");
    }

    @PermissionCallback
    private void readPermissionCallback(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? getContext().checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
            : getContext().checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    /** 保存一张图片（base64 → MediaStore.Images） */
    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "image/jpeg");
        if (data == null || fileName == null) {
            call.reject("data 与 fileName 不能为空");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
            values.put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_PATH);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);

            Uri uri = getContext().getContentResolver().insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("MediaStore 插入失败");
                return;
            }
            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                if (os == null) {
                    call.reject("打开输出流失败");
                    return;
                }
                os.write(bytes);
            }
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 从系统相册按文件名读取图片（返回 base64） */
    @PluginMethod
    public void read(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            String selection = MediaStore.Images.Media.DISPLAY_NAME + " = ? AND "
                + MediaStore.Images.Media.RELATIVE_PATH + " = ?";
            String[] args = new String[]{fileName, RELATIVE_PATH};
            try (Cursor c = cr.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Images.Media._ID},
                    selection, args, MediaStore.Images.Media.DATE_MODIFIED + " DESC")) {
                if (c == null || !c.moveToFirst()) {
                    call.reject("未找到: " + fileName);
                    return;
                }
                long id = c.getLong(0);
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                try (InputStream is = cr.openInputStream(uri)) {
                    if (is == null) {
                        call.reject("打开文件失败: " + fileName);
                        return;
                    }
                    byte[] bytes = readAll(is);
                    JSObject ret = new JSObject();
                    ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    call.resolve(ret);
                }
            }
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 查询相册中是否存在同名文件（只查 MediaStore 索引，不读文件内容） */
    @PluginMethod
    public void exists(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            String selection = MediaStore.Images.Media.DISPLAY_NAME + " = ? AND "
                + MediaStore.Images.Media.RELATIVE_PATH + " = ?";
            String[] args = new String[]{fileName, RELATIVE_PATH};
            try (Cursor c = cr.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Images.Media._ID, MediaStore.Images.Media.SIZE},
                    selection, args, null)) {
                boolean exists = c != null && c.moveToFirst();
                JSObject ret = new JSObject();
                ret.put("exists", exists);
                if (exists) {
                    ret.put("size", c.getLong(1));
                }
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    private byte[] readAll(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    /** 按文件名删除相册副本（幂等，找不到也不报错） */
    @PluginMethod
    public void delete(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            int deleted = getContext().getContentResolver().delete(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                MediaStore.Images.Media.DISPLAY_NAME + " = ? AND "
                    + MediaStore.Images.Media.RELATIVE_PATH + " = ?",
                new String[]{fileName, RELATIVE_PATH});
            JSObject ret = new JSObject();
            ret.put("deleted", deleted);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /**
     * 写入应用元数据备份（JSON 字符串 → MediaStore Downloads）。
     * Android 10+ 无需权限；卸载后文件仍保留在 Download/TeyvatWhisper/。
     */
    @PluginMethod
    public void writeMeta(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data");
        if (fileName == null || data == null) {
            call.reject("fileName 与 data 不能为空");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            // 先删除所有旧备份（含历史遗留的 "pixiv_meta (N).json" 副本），
            // 避免 MediaStore 残留多行 / 同名物理文件导致自动加 (N) 后缀
            cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                MediaStore.Downloads.DISPLAY_NAME + " LIKE ? AND "
                    + MediaStore.Downloads.RELATIVE_PATH + " = ?",
                new String[]{"pixiv_meta%.json", META_RELATIVE_PATH});
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            values.put(MediaStore.Downloads.RELATIVE_PATH, META_RELATIVE_PATH);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("MediaStore 插入失败");
                return;
            }
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) {
                    call.reject("打开输出流失败");
                    return;
                }
                os.write(data.getBytes(StandardCharsets.UTF_8));
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            cr.update(uri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 读取应用元数据备份（返回 JSON 字符串；无备份返回空字符串） */
    @PluginMethod
    public void readMeta(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            // 用 LIKE 匹配（可能因历史遗留物理文件/同名冲突被 MediaStore 写成 "pixiv_meta (N).json"），
            // 按修改时间倒序取最新一份，保证恢复时读到最近备份
            String selection = MediaStore.Downloads.DISPLAY_NAME + " = ? AND "
                + MediaStore.Downloads.RELATIVE_PATH + " = ?";
            String[] args = new String[]{fileName, META_RELATIVE_PATH};
            try (Cursor c = cr.query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID},
                    selection, args, null)) {
                JSObject ret = new JSObject();
                if (c == null || !c.moveToFirst()) {
                    ret.put("data", "");
                    call.resolve(ret);
                    return;
                }
                long id = c.getLong(0);
                Uri uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                try (InputStream is = cr.openInputStream(uri)) {
                    if (is == null) {
                        ret.put("data", "");
                        call.resolve(ret);
                        return;
                    }
                    byte[] bytes = readAll(is);
                    ret.put("data", new String(bytes, StandardCharsets.UTF_8));
                    call.resolve(ret);
                }
            }
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** List all metadata backup file names (including historical copies), for merge-on-read restore */
    @PluginMethod
    public void listMetaFiles(PluginCall call) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            JSArray files = new JSArray();
            String selection = MediaStore.Downloads.RELATIVE_PATH + " = ?";
            String[] args = new String[]{META_RELATIVE_PATH};
            try (Cursor c = cr.query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads.DISPLAY_NAME},
                    selection, args,
                    MediaStore.Downloads.DATE_MODIFIED + " DESC")) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String name = c.getString(0);
                        if (name == null || name.isEmpty()) continue;
                        if (name.startsWith("pixiv_meta") || name.startsWith("pixivviewer-meta-backup")) {
                            files.put(name);
                        }
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** List metadata backup PNG names in the gallery collection (survives reinstall) */
    @PluginMethod
    public void listMetaPngs(PluginCall call) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            JSArray files = new JSArray();
            String selection = MediaStore.Images.Media.RELATIVE_PATH + " = ?";
            String[] args = new String[]{RELATIVE_PATH};
            try (Cursor c = cr.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Images.Media.DISPLAY_NAME},
                    selection, args,
                    MediaStore.Images.Media.DATE_MODIFIED + " DESC")) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String name = c.getString(0);
                        if (name != null && name.startsWith("pixiv_meta") && name.endsWith(".png")) {
                            files.put(name);
                        }
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 删除应用元数据备份（幂等，找不到也不报错） */
    @PluginMethod
    public void deleteMeta(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            int deleted = getContext().getContentResolver().delete(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                MediaStore.Downloads.DISPLAY_NAME + " = ? AND "
                    + MediaStore.Downloads.RELATIVE_PATH + " = ?",
                new String[]{fileName, META_RELATIVE_PATH});
            JSObject ret = new JSObject();
            ret.put("deleted", deleted);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /**
     * 写入任意二进制文件到相册目录（Pictures/TeyvatWhisper，与图片/动图同目录，卸载后保留）。
     * 用于 ugoira 原版无损 ZIP 的持久副本。图片集合拒绝非 image/* MIME，故走通用 Files 集合。
     */
    @PluginMethod
    public void saveDownload(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data"); // base64
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (fileName == null || data == null) {
            call.reject("fileName 与 data 不能为空");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            ContentResolver cr = getContext().getContentResolver();
            // 先删除同名旧文件（幂等）
            cr.delete(FILES_URI,
                MediaStore.MediaColumns.DISPLAY_NAME + " = ? AND "
                    + MediaStore.MediaColumns.RELATIVE_PATH + " = ?",
                new String[]{fileName, RELATIVE_PATH});
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(FILES_URI, values);
            if (uri == null) {
                call.reject("MediaStore 插入失败");
                return;
            }
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) {
                    call.reject("打开输出流失败");
                    return;
                }
                os.write(bytes);
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, values, null, null);

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 列出相册目录（Pictures/TeyvatWhisper）内所有文件名，供启动时相册对账 */
    @PluginMethod
    public void listFiles(PluginCall call) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            JSArray files = new JSArray();
            try (Cursor c = cr.query(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Images.Media.DISPLAY_NAME},
                    MediaStore.Images.Media.RELATIVE_PATH + " = ?",
                    new String[]{RELATIVE_PATH},
                    null)) {
                if (c != null) {
                    while (c.moveToNext()) {
                        String name = c.getString(0);
                        if (name != null && !name.isEmpty()) files.put(name);
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
