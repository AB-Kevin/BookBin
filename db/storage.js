// Invoice attachments and the company logo, stored in Supabase.
//
// Two shapes of value can appear in an attachment_path or company_logo_path
// column, and telling them apart is what lets old rows keep working:
//
//   "incoming/6f3a....pdf"   a storage object -- contains a slash
//   "6f3a....pdf"            a legacy local file in the workspace folder
//   "C:\\...\\logo.png"      a legacy absolute path, older still
//
// Only the first is produced now. The others are read, never written, so a
// database migrated before the files were uploaded still opens its
// attachments from disk rather than failing.
//
// Every uploaded object gets a fresh UUID name. That is not decoration: files
// are cached locally after download, and a name that is never reused means a
// cached copy can never be stale.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getSupabase } = require('./supabase');

const BUCKET = 'bookbin';

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** True when the stored value names a storage object rather than a local file. */
function isStoragePath(value) {
  return typeof value === 'string' && value.includes('/') && !path.isAbsolute(value);
}

function contentTypeFor(fileName) {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function cacheDir() {
  return path.join(app.getPath('userData'), 'file-cache');
}

function bucket() {
  return getSupabase().storage.from(BUCKET);
}

function fail(error, what) {
  const message = (error && error.message) || String(error);
  if (/fetch failed|network|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    throw new Error('Cannot reach the server. Check your internet connection.');
  }
  throw new Error(`Could not ${what}: ${message}`);
}

/**
 * Uploads a local file and returns its object path.
 * `folder` is 'incoming', 'outgoing' or 'logo'.
 */
async function uploadFile(folder, sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  const objectPath = `${folder}/${crypto.randomUUID()}${ext}`;
  const body = fs.readFileSync(sourcePath);
  const { error } = await bucket().upload(objectPath, body, {
    contentType: contentTypeFor(sourcePath),
    upsert: false,
  });
  if (error) fail(error, 'upload that file');
  return objectPath;
}

/** Uploads bytes already in memory (the generated invoice PDF). */
async function uploadBuffer(folder, buffer, extension) {
  const objectPath = `${folder}/${crypto.randomUUID()}${extension}`;
  const { error } = await bucket().upload(objectPath, buffer, {
    contentType: contentTypeFor(objectPath),
    upsert: false,
  });
  if (error) fail(error, 'upload that file');
  return objectPath;
}

/**
 * Deletes an object. Does nothing for legacy local paths -- those are removed
 * by the caller, which knows which workspace folder they live in.
 *
 * A failure here is logged, not thrown: an orphaned object costs a few
 * kilobytes, while refusing to save an invoice because its old attachment
 * could not be tidied up costs the user their work.
 */
async function removeFile(objectPath) {
  if (!isStoragePath(objectPath)) return;
  const { error } = await bucket().remove([objectPath]);
  if (error) console.error('BookBin: could not remove stored file —', error.message);
}

/**
 * Downloads an object to a local cache and returns the absolute path, so the
 * OS can open it and the PDF template can reference it with a file:// URL.
 * Cached names are the object's UUID, which is never reused, so a file that
 * is already present is always the right one.
 */
async function ensureLocalCopy(objectPath) {
  const localPath = path.join(cacheDir(), objectPath.replace(/\//g, '_'));
  if (fs.existsSync(localPath)) return localPath;

  const { data, error } = await bucket().download(objectPath);
  if (error) fail(error, 'open that file');

  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
  return localPath;
}

module.exports = {
  BUCKET,
  isStoragePath,
  uploadFile,
  uploadBuffer,
  removeFile,
  ensureLocalCopy,
};
