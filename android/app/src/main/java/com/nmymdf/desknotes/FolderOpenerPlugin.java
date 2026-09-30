package com.nmymdf.desknotes;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens a folder of the phone's shared storage (e.g. Documents/DeskNotes) in a
 * file manager. File managers differ between phones, so a few ways are tried
 * in order; the one that started is reported back (shown to the user).
 */
@CapacitorPlugin(name = "FolderOpener")
public class FolderOpenerPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String rel = call.getString("path", "Documents/DeskNotes");
        String way = call.getString("way", "");
        Uri doc = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + rel);
        Activity activity = getActivity();

        // 1. Android's own "open this folder" (Files app / DocumentsUI).
        Intent folder = new Intent(Intent.ACTION_VIEW);
        folder.setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR);
        folder.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        // 2. Samsung My Files, started at the folder.
        Intent samsung = new Intent("samsung.myfiles.intent.action.LAUNCH_MY_FILES");
        samsung.putExtra("samsung.myfiles.intent.extra.START_PATH", "/storage/emulated/0/" + rel);

        // 3. The folder address, letting the phone ask which app to use.
        Intent chooser = Intent.createChooser(new Intent(Intent.ACTION_VIEW).setDataAndType(doc, "resource/folder"), "打開資料夾");

        // 4. At least the files app.
        Intent filesApp = Build.VERSION.SDK_INT >= 29
            ? Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_FILES)
            : null;

        Intent[] tries = { folder, samsung, chooser, filesApp };
        String[] names = { "folder", "samsung", "chooser", "files" };
        StringBuilder failed = new StringBuilder();
        for (int i = 0; i < tries.length; i++) {
            Intent it = tries[i];
            if (it == null || (!way.isEmpty() && !way.equals(names[i]))) continue;
            try {
                activity.startActivity(it);
                JSObject ret = new JSObject();
                ret.put("opened", names[i]);
                ret.put("failed", failed.toString());
                call.resolve(ret);
                return;
            } catch (Exception e) {
                failed.append(names[i]).append(": ").append(e.getClass().getSimpleName()).append("; ");
            }
        }
        call.reject("找不到可以開啟資料夾的檔案 App（" + failed + "）");
    }
}
