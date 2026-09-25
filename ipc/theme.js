const { nativeTheme } = require('electron');

// The renderer owns the light/dark choice (it's a per-computer preference,
// kept in localStorage). This only mirrors it onto the native side so the
// Windows title bar, menus and scrollbars match the page instead of following
// the OS setting on their own.
module.exports = function registerTheme(ipcMain) {
  ipcMain.handle('theme:set', (event, mode) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    nativeTheme.themeSource = mode;
  });
};
