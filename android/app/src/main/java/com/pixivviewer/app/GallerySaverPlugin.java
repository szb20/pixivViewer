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

    private static final String RELATIVE_PATH = "Pictures/TeyvatWhisper";

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
}
