// Attachment handling shared by incoming and outgoing invoices.
//
// The two had identical copies of this logic, differing only in which folder
// they wrote to. It is one module now, and it moved to Supabase Storage at the
// same time, so an attachment added on one machine opens on another -- which
// local files in a synced folder never managed once the database went online.
//
// Legacy absolute paths are still opened from disk. A bare filename, which
// used to mean "in the workspace folder", can no longer be located: that
// folder is gone, so such a row names a file that was never uploaded.

const path = require('path');
const { shell } = require('electron');
const storage = require('../db/storage');

module.exports = function createAttachments(kind) {
  // Tidying up an old file must never be the reason a save fails, so this is
  // best-effort. A legacy file on someone's disk is deliberately left alone:
  // it is not ours to delete, and it is no longer referenced either way.
  async function remove(storedPath) {
    if (!storedPath) return;
    if (storage.isStoragePath(storedPath)) await storage.removeFile(storedPath);
  }

  /**
   * Works out what this save's attachment_path/attachment_name should be:
   * a newly chosen file replaces (and cleans up) any old one, a remove
   * request clears it, and otherwise the existing attachment carries over.
   */
  async function resolve(current, data) {
    const currentPath = current && current.attachment_path;

    if (data.remove_attachment) {
      await remove(currentPath);
      return { attachment_path: null, attachment_name: null };
    }

    if (data.attachment_source_path) {
      // Upload before removing the old one: if the upload fails, the invoice
      // keeps the attachment it had rather than losing both.
      const objectPath = await storage.uploadFile(kind, data.attachment_source_path);
      await remove(currentPath);
      return {
        attachment_path: objectPath,
        attachment_name: path.basename(data.attachment_source_path),
      };
    }

    return {
      attachment_path: currentPath || null,
      attachment_name: (current && current.attachment_name) || null,
    };
  }

  /** Stores bytes already in memory (the generated invoice PDF). */
  async function storeGenerated(current, buffer, displayName) {
    const objectPath = await storage.uploadBuffer(kind, buffer, '.pdf');
    await remove(current && current.attachment_path);
    return { attachment_path: objectPath, attachment_name: `${displayName || 'invoice'}.pdf` };
  }

  /** Opens an attachment in whatever the OS uses for that file type. */
  async function open(storedPath) {
    if (!storedPath) return { ok: false };
    if (!storage.isStoragePath(storedPath) && !path.isAbsolute(storedPath)) {
      return { ok: false, error: 'This attachment was never uploaded and cannot be opened.' };
    }
    const absPath = storage.isStoragePath(storedPath)
      ? await storage.ensureLocalCopy(storedPath)
      : storedPath;
    const err = await shell.openPath(absPath);
    return { ok: !err, error: err || null };
  }

  return { resolve, remove, storeGenerated, open };
};
