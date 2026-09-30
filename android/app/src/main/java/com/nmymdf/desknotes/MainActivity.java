package com.nmymdf.desknotes;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FolderOpenerPlugin.class); // must come before super.onCreate
        super.onCreate(savedInstanceState);
    }
}
