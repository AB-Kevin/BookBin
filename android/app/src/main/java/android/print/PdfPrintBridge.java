package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

import java.io.File;

/**
 * Drives a WebView's PrintDocumentAdapter straight into a PDF file, with no
 * print dialog. The adapter's layout and write callbacks have package-private
 * constructors, which is the only reason this class lives in android.print;
 * everything else is in com.bookbin.app.PdfPrinterPlugin.
 */
public class PdfPrintBridge {
    public interface Callback {
        void onDone();
        void onError(String message);
    }

    public static void write(PrintDocumentAdapter adapter, PrintAttributes attributes, File out, Callback callback) {
        adapter.onStart();
        adapter.onLayout(null, attributes, null, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                ParcelFileDescriptor fd;
                try {
                    fd = ParcelFileDescriptor.open(out,
                        ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE);
                } catch (Exception e) {
                    adapter.onFinish();
                    callback.onError(e.getMessage());
                    return;
                }
                adapter.onWrite(new PageRange[] { PageRange.ALL_PAGES }, fd, new CancellationSignal(),
                    new PrintDocumentAdapter.WriteResultCallback() {
                        @Override
                        public void onWriteFinished(PageRange[] pages) {
                            close(fd);
                            adapter.onFinish();
                            callback.onDone();
                        }

                        @Override
                        public void onWriteFailed(CharSequence error) {
                            close(fd);
                            adapter.onFinish();
                            callback.onError(String.valueOf(error));
                        }
                    });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                callback.onError(String.valueOf(error));
            }
        }, null);
    }

    private static void close(ParcelFileDescriptor fd) {
        try {
            fd.close();
        } catch (Exception ignored) {
            // Nothing useful to do; the PDF itself is already written or failed.
        }
    }
}
