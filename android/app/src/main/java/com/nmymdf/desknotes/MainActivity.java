package com.nmymdf.desknotes;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FolderOpenerPlugin.class); // must come before super.onCreate
        super.onCreate(savedInstanceState);
        clearCacheAfterUpdate();
    }

    // After installing a new version the WebView could keep showing the old
    // screens from its cache (the notes themselves are not in this cache).
    // Clear it once per install/update and reload.
    private void clearCacheAfterUpdate() {
        try {
            long installed = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
            SharedPreferences prefs = getSharedPreferences("desknotes", MODE_PRIVATE);
            if (prefs.getLong("lastUpdateTime", 0) == installed) return;
            prefs.edit().putLong("lastUpdateTime", installed).apply();
            WebView webView = getBridge().getWebView();
            webView.clearCache(true);
            webView.reload();
        } catch (Exception e) {
            // not critical
        }
    }
}
