package com.pixivviewer.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentUris;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 保存图片到系统相册（MediaStore）。
 * Android 10+ 通过 MediaStore 写入无需任何存储权限，文件进入 Pictures/PixivViewer，
 * 系统相册立即可见。
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

    // 注意：MediaStore 实际存储的 RELATIVE_PATH 带尾斜杠（Pictures/PixivViewer/），
    // 查询必须用带斜杠的值，否则 read/exists/delete 全部匹配不到。
    private static final String RELATIVE_PATH = "Pictures/PixivViewer/";
    // 应用元数据备份（JSON）存到「下载」集合：任意 MIME 都接受，卸载后保留
    private static final String META_RELATIVE_PATH = "Download/PixivViewer/";
    // 通用 Files 集合：接受任意 MIME（无损 ZIP 副本用，与图片/动图同目录 Pictures/PixivViewer）
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
     * Android 10+ 无需权限；卸载后文件仍保留在 Download/PixivViewer/。
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
            // 精确匹配文件名 + 相对目录（应用自身只写一份固定名备份，同名冲突由写侧的
            // 覆盖式插入兜底；这里取匹配到的第一份）
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
     * 写入任意二进制文件到相册目录（Pictures/PixivViewer，与图片/动图同目录，卸载后保留）。
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

    /** 列出相册目录（Pictures/PixivViewer）内所有文件名，供启动时相册对账 */
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

    // ── 备份文件直读写（所有文件访问 + 默认路径）──
    // 自用侧载 APK 申请 MANAGE_EXTERNAL_STORAGE（「所有文件访问」，系统设置里手动开启），
    // 拿到后直接读写 Download/Prism/pixiv_meta.json：零选夹、纯 JSON、不污染相册，
    // 且重装后重开一次权限即可按默认路径找回备份（SAF 授权无法活过重装，路径授权也一样，
    // 但默认路径免去了「重选同一文件夹」的步骤）。

    private static final String BACKUP_DIR_NAME = "Prism";

    /** 是否已获得「所有文件访问」（API<30 退化为运行时写权限） */
    private boolean isAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            return Environment.isExternalStorageManager();
        }
        return getContext().checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED;
    }

    /** 默认备份文件：Download/Prism/<fileName> */
    private File directBackupFile(String fileName) {
        File dir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            BACKUP_DIR_NAME);
        return new File(dir, fileName);
    }

    /** 查询「所有文件访问」权限状态 */
    @PluginMethod
    public void hasAllFilesAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", isAllFilesAccess());
        call.resolve(ret);
    }

    /** 跳到本应用的「所有文件访问」系统设置页（用户手动开开关，回来后轮询刷新状态） */
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= 30) {
                intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.fromParts("package", getContext().getPackageName(), null));
            } else if (Build.VERSION.SDK_INT == 29) {
                intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            } else {
                // 更早版本走运行时权限，理论上到不了这里
                call.resolve(new JSObject().put("launched", false));
                return;
            }
            getActivity().startActivity(intent);
            call.resolve(new JSObject().put("launched", true));
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 查询当前备份位置：有「所有文件访问」→ 默认路径；否则 SAF 目录（可能未设置） */
    @PluginMethod
    public void getBackupFolder(PluginCall call) {
        JSObject ret = new JSObject();
        if (isAllFilesAccess()) {
            ret.put("uri", "direct");
            ret.put("name", "Download/" + BACKUP_DIR_NAME);
        } else {
            Uri uri = safTreeUri();
            if (uri != null) {
                ret.put("uri", uri.toString());
                ret.put("name", safDisplayName(uri));
            } else {
                ret.put("uri", "");
                ret.put("name", "");
            }
        }
        call.resolve(ret);
    }

    /** 把 JSON 备份写入备份位置：优先默认路径直写（所有文件访问），退回 SAF 目录 */
    @PluginMethod
    public void writeBackupFile(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data");
        if (fileName == null || data == null) {
            call.reject("fileName 与 data 不能为空");
            return;
        }
        // 路径一：所有文件访问 → 默认路径直写
        if (isAllFilesAccess()) {
            try {
                File f = directBackupFile(fileName);
                //noinspection ResultOfMethodCallIgnored
                f.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(f, false)) {
                    os.write(data.getBytes(StandardCharsets.UTF_8));
                }
                JSObject ret = new JSObject();
                ret.put("uri", f.getAbsolutePath());
                call.resolve(ret);
                return;
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
                return;
            }
        }
        // 路径二：SAF 目录（用户选定）
        Uri treeUri = safTreeUri();
        if (treeUri == null) {
            call.reject("未设置备份文件夹");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            try {
                DocumentsContract.deleteDocument(cr, safChildUri(treeUri, fileName));
            } catch (Exception ignored) {
                // 旧文件不存在，忽略
            }
            Uri created = DocumentsContract.createDocument(cr,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, safDocId(treeUri)),
                "application/json", fileName);
            if (created == null) {
                call.reject("创建备份文件失败");
                return;
            }
            try (OutputStream os = cr.openOutputStream(created, "w")) {
                if (os == null) {
                    call.reject("打开输出流失败");
                    return;
                }
                os.write(data.getBytes(StandardCharsets.UTF_8));
            }
            JSObject ret = new JSObject();
            ret.put("uri", created.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** 从备份位置读取 JSON 备份（无权限/无文件夹/无文件统一返回空字符串，不报错） */
    @PluginMethod
    public void readBackupFile(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        JSObject ret = new JSObject();
        try {
            InputStream is = null;
            if (isAllFilesAccess()) {
                File f = directBackupFile(fileName);
                if (f.isFile()) is = new FileInputStream(f);
            } else {
                Uri treeUri = safTreeUri();
                if (treeUri != null) {
                    is = getContext().getContentResolver()
                        .openInputStream(safChildUri(treeUri, fileName));
                }
            }
            if (is == null) {
                ret.put("data", "");
            } else {
                try {
                    ret.put("data", new String(readAll(is), StandardCharsets.UTF_8));
                } finally {
                    //noinspection ThrowFromFinallyBlock
                    is.close();
                }
            }
        } catch (Exception e) {
            ret.put("data", "");
        }
        call.resolve(ret);
    }

    // ── SAF 备份文件夹（Storage Access Framework，兜底路径）──
    // 未开「所有文件访问」时的备选：用户一次性选定目录，系统授予持久化读写授权。
    // 卸载重装后授权失效但文件仍在，重选同一目录即可恢复。

    private static final String SAF_PREFS = "prism_backup";
    private static final String SAF_KEY_URI = "tree_uri";
    private static final int REQ_PICK_FOLDER = 47110;
    private PluginCall pendingPickCall = null;

    private SharedPreferences safPrefs() {
        return getContext().getSharedPreferences(SAF_PREFS, Context.MODE_PRIVATE);
    }

    /** 已保存的目录树 uri（未设置返回 null） */
    private Uri safTreeUri() {
        String s = safPrefs().getString(SAF_KEY_URI, null);
        if (s == null || s.isEmpty()) return null;
        try {
            return Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    /** 目录树的文档 id（形如 "primary:Documents/Prism"） */
    private String safDocId(Uri treeUri) {
        return DocumentsContract.getTreeDocumentId(treeUri);
    }

    /** 目录树内某个文件的文档 uri */
    private Uri safChildUri(Uri treeUri, String fileName) {
        return DocumentsContract.buildDocumentUriUsingTree(treeUri, safDocId(treeUri) + "/" + fileName);
    }

    /** 目录显示名（取 doc id 最后一段，用于设置页展示） */
    private String safDisplayName(Uri treeUri) {
        String id = safDocId(treeUri);
        int slash = id.lastIndexOf('/');
        String name = slash >= 0 ? id.substring(slash + 1) : id;
        return name.isEmpty() ? id : name;
    }

    // ── 分块写入大文件（与 saveDownload 同目标，供 ugoira 无损 ZIP 副本等大文件） ──
    // 40MB ZIP 经 JS 桥传整份 base64 会产生 ~53MB 字符串峰值（WebView 上有 OOM 风险），
    // 分块后 JS 侧峰值 ≈ 单块。流程：startDownloadFile → appendDownloadChunk×N
    // → finishDownloadFile；失败走 abortDownloadFile 清理半写的记录。

    /** 分块会话：fileName → 打开中的输出流与其 MediaStore uri */
    private final java.util.Map<String, Uri> chunkedSessionUris = new java.util.HashMap<>();
    private final java.util.Map<String, OutputStream> chunkedSessionStreams = new java.util.HashMap<>();

    /** 关闭会话并返回其 uri（无会话返回 null）；publish=true 时清除 IS_PENDING 让文件对相册可见 */
    private Uri closeChunkedSession(String fileName, boolean publish) {
        Uri uri;
        OutputStream os;
        synchronized (chunkedSessionUris) {
            uri = chunkedSessionUris.remove(fileName);
            os = chunkedSessionStreams.remove(fileName);
        }
        if (os != null) {
            try {
                os.close();
            } catch (IOException ignored) {
            }
        }
        if (uri != null && publish) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(uri, values, null, null);
        }
        return uri;
    }

    /** 关闭会话并删除半写行（写失败路径用：abort 时已拿不到 uri，必须直接清） */
    private void closeAndDiscardChunkedSession(String fileName) {
        Uri uri = closeChunkedSession(fileName, false);
        if (uri != null) {
            try {
                getContext().getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
            }
        }
    }

    @PluginMethod
    public void startDownloadFile(PluginCall call) {
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        try {
            ContentResolver cr = getContext().getContentResolver();
            // 先删除同名旧文件（幂等，与 saveDownload 一致）；同名残留会话也一并关闭
            cr.delete(FILES_URI,
                MediaStore.MediaColumns.DISPLAY_NAME + " = ? AND "
                    + MediaStore.MediaColumns.RELATIVE_PATH + " = ?",
                new String[]{fileName, RELATIVE_PATH});
            closeChunkedSession(fileName, false);
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
            OutputStream os = cr.openOutputStream(uri);
            if (os == null) {
                call.reject("打开输出流失败");
                return;
            }
            synchronized (chunkedSessionUris) {
                chunkedSessionUris.put(fileName, uri);
                chunkedSessionStreams.put(fileName, os);
            }
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void appendDownloadChunk(PluginCall call) {
        String fileName = call.getString("fileName");
        String data = call.getString("data"); // 单块 base64
        if (fileName == null || data == null) {
            call.reject("fileName 与 data 不能为空");
            return;
        }
        OutputStream os;
        synchronized (chunkedSessionUris) {
            os = chunkedSessionStreams.get(fileName);
        }
        if (os == null) {
            call.reject("会话不存在，请先 startDownloadFile");
            return;
        }
        try {
            os.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve(new JSObject());
        } catch (Exception e) {
            // 写失败：关流并删除半写行（此时 abort 已拿不到 uri，必须在这里清）
            closeAndDiscardChunkedSession(fileName);
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void finishDownloadFile(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        synchronized (chunkedSessionUris) {
            if (!chunkedSessionUris.containsKey(fileName)) {
                call.reject("会话不存在");
                return;
            }
        }
        try {
            closeChunkedSession(fileName, true);
            call.resolve(new JSObject());
        } catch (Exception e) {
            // 必须捕获：publish 阶段抛异常（磁盘满/权限）会让 Bridge 直接崩溃整个应用
            call.reject(e.getMessage(), e);
        }
    }

    /** 放弃分块会话：关流并删除半写的记录（备份失败时调用） */
    @PluginMethod
    public void abortDownloadFile(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null) {
            call.reject("fileName 不能为空");
            return;
        }
        Uri uri;
        OutputStream os;
        synchronized (chunkedSessionUris) {
            uri = chunkedSessionUris.remove(fileName);
            os = chunkedSessionStreams.remove(fileName);
        }
        if (os != null) {
            try {
                os.close();
            } catch (IOException ignored) {
            }
        }
        if (uri != null) {
            try {
                getContext().getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) {
            }
        }
        call.resolve(new JSObject());
    }
}
