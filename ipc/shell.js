const { shell } = require('electron');

// Only http(s) links are handed to the OS. Notes fields are free text a user
// types themselves, but this still guards against a link using some other
// registered protocol handler on the machine.
module.exports = function registerShell(ipcMain) {
  ipcMain.handle('shell:openExternal', (event, url) => {
    if (typeof url !== 'string') return;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    return shell.openExternal(parsed.href);
  });
};
