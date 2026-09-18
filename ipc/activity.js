const INACTIVITY_LIMIT_SECONDS = 2 * 60 * 60; // 2 hours
const WARNING_LEAD_SECONDS = 60; // show the countdown banner in the last minute

// Auto-closes the app after a period with no input inside the BookBin window
// specifically — not just anywhere on the machine — so leaving it open in
// the background while using other apps doesn't keep the shared write lock
// held indefinitely. The renderer pings 'activity:ping' on real mouse/
// keyboard input (see renderer/app.js); clicking the countdown banner's
// "Keep Open" button counts too, since it's just another click the same
// listener sees, so no separate override channel is needed.
module.exports = function registerActivityMonitor(ipcMain, getMainWindow, onAutoClose) {
  let lastActivityAt = Date.now();
  let warning = false;

  ipcMain.on('activity:ping', () => {
    lastActivityAt = Date.now();
  });

  setInterval(() => {
    const idleSeconds = (Date.now() - lastActivityAt) / 1000;
    const remaining = INACTIVITY_LIMIT_SECONDS - idleSeconds;
    const win = getMainWindow();

    if (remaining <= 0) {
      onAutoClose();
      return;
    }

    if (remaining <= WARNING_LEAD_SECONDS) {
      warning = true;
      if (win && !win.isDestroyed()) {
        win.webContents.send('activity:countdown', { remainingSeconds: Math.ceil(remaining) });
      }
    } else if (warning) {
      warning = false;
      if (win && !win.isDestroyed()) {
        win.webContents.send('activity:countdown', { remainingSeconds: null });
      }
    }
  }, 1000);
};
