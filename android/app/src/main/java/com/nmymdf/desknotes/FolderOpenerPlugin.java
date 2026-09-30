package com.nmymdf.desknotes;

import android.content.ActivityNotFoundException;
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
 * file manager. File managers differ between phones, so a few ways are tried:
 * Samsung My Files, Android's Files app on the folder, then just the files app.
 */
@CapacitorPlugin(name = "FolderOpener")
public class FolderOpenerPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String rel = call.getString("path", "Documents/DeskNotes");
        Uri doc = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + rel);

        Intent samsung = new Intent("samsung.myfiles.intent.action.LAUNCH_MY_FILES");
        samsung.setPackage("com.sec.android.app.myfiles");
        samsung.putExtra("samsung.myfiles.intent.extra.START_PATH", "/storage/emulated/0/" + rel);

        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(doc, DocumentsContract.Document.MIME_TYPE_DIR);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        Intent browse = new Intent("android.provider.action.BROWSE");
        browse.setData(doc);

        Intent filesApp = Build.VERSION.SDK_INT >= 29
            ? Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_FILES)
            : null;

        Intent[] tries = { samsung, view, browse, filesApp };
        String[] names = { "samsung", "folder", "browse", "files" };
        for (int i = 0; i < tries.length; i++) {
            Intent it = tries[i];
            if (it == null) continue;
            try {
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(it);
                JSObject ret = new JSObject();
                ret.put("opened", names[i]);
                call.resolve(ret);
                return;
            } catch (ActivityNotFoundException | SecurityException e) {
                // try the next way
            }
        }
        call.reject("找不到可以開啟資料夾的檔案 App");
    }
}
