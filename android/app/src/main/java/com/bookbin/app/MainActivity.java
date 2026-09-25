package com.bookbin.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BookBin's own plugins, which live in this project rather than in an
        // npm package, so Capacitor does not find them by itself.
        registerPlugin(PdfPrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
