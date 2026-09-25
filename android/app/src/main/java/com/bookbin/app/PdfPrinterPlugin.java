package com.bookbin.app;

import android.print.PdfPrintBridge;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.nio.file.Files;

/**
 * Turns an HTML page into PDF bytes: the Android side of the desktop's
 * webContents.printToPDF(), used for exporting an outgoing invoice (see the
 * BrowserWindow stand-in in mobile/shims/electron.js).
 *
 * The page is rendered in an off-screen WebView and printed with the system's
 * own print pipeline, so the PDF has real text, like the desktop's, rather
 * than a picture of the page.
 *
 * Margins are left to the page's CSS (@page), which the caller adds. Setting
 * them here does not work: the print pipeline scales them against the
 * resolution, and 0.4" came out as more than 3".
 */
@CapacitorPlugin(name = "PdfPrinter")
public class PdfPrinterPlugin extends Plugin {
    @PluginMethod
    public void print(PluginCall call) {
        String html = call.getString("html");
        if (html == null) {
            call.reject("No HTML to print.");
            return;
        }

        getActivity().runOnUiThread(() -> {
            WebView webView = new WebView(getContext());
            webView.getSettings().setJavaScriptEnabled(false);
            webView.setWebViewClient(new WebViewClient() {
                private boolean printed = false;

                @Override
                public void onPageFinished(WebView view, String url) {
                    if (printed) return;
                    printed = true;
                    printToPdf(call, view);
                }
            });
            webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        });
    }

    private void printToPdf(PluginCall call, WebView webView) {
        PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter("BookBin invoice");
        PrintAttributes attributes = new PrintAttributes.Builder()
            .setMediaSize(PrintAttributes.MediaSize.NA_LETTER)
            .setResolution(new PrintAttributes.Resolution("pdf", "pdf", 300, 300))
            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
            .build();
        File out = new File(getContext().getCacheDir(), "print-" + System.currentTimeMillis() + ".pdf");

        PdfPrintBridge.write(adapter, attributes, out, new PdfPrintBridge.Callback() {
            @Override
            public void onDone() {
                try {
                    JSObject result = new JSObject();
                    result.put("data", Base64.encodeToString(Files.readAllBytes(out.toPath()), Base64.NO_WRAP));
                    call.resolve(result);
                } catch (Exception e) {
                    call.reject("Could not read the PDF: " + e.getMessage());
                } finally {
                    cleanUp(out, webView);
                }
            }

            @Override
            public void onError(String message) {
                call.reject("Could not create the PDF: " + message);
                cleanUp(out, webView);
            }
        });
    }

    private void cleanUp(File out, WebView webView) {
        out.delete();
        getActivity().runOnUiThread(webView::destroy);
    }
}
