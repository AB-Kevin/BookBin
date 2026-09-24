// Cross-device "someone else has this open" lock for the shared workspace
// database. Stored as a plain JSON file next to bookbin.db so it travels
// through the same OneDrive-style folder sync as the database itself — no
// separate transport needed. A lock is treated as abandoned once its holder
// stops refreshing it (see STALE_MS), which is what lets another device
// recover automatically if the holder crashes, sleeps, or is force-quit
// without a clean release.
const fs = require('fs');
const path = require('path');

// Deliberately generous. A lock only looks stale because its holder stopped
// refreshing it, but on a cloud-synced workspace it can also look stale
// because the holder's heartbeat simply hasn't synced over yet — the provider
// is paused, catching up on a large upload, or the machine slept. Claiming a
// lock that is actually still held means two devices writing the same
// database, so the window is sized for sync lag rather than for fast
// recovery; a genuinely crashed holder just takes longer to time out.
const STALE_MS = 15 * 60 * 1000;

function lockFilePath(workspaceDir) {
  return path.join(workspaceDir, 'bookbin.lock');
}

function readLock(workspaceDir) {
  try {
    return JSON.parse(fs.readFileSync(lockFilePath(workspaceDir), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeLock(workspaceDir, lock) {
  fs.writeFileSync(lockFilePath(workspaceDir), JSON.stringify(lock, null, 2), 'utf8');
}

// Only removes the file if it's still ours — guards against a race where our
// lock already went stale and someone else claimed it before we got here.
function releaseLock(workspaceDir, instanceId) {
  const current = readLock(workspaceDir);
  if (current && current.instanceId === instanceId) {
    fs.rmSync(lockFilePath(workspaceDir), { force: true });
  }
}

function isLockStale(lock) {
  if (!lock || !lock.heartbeatAt) return true;
  return Date.now() - new Date(lock.heartbeatAt).getTime() > STALE_MS;
}

// A "request access" handshake between the read-only side and the current
// holder, using a second small file for the same reason the lock itself
// does — it's the only channel two devices sharing a synced folder have.
// The requester writes {status: 'pending'}; the holder either deletes the
// file (releasing) or rewrites it with {status: 'declined'} (retaining),
// and the requester is the one who deletes a 'declined' file once it's seen
// it, so a stale response never blocks the next request from being written.
function requestFilePath(workspaceDir) {
  return path.join(workspaceDir, 'bookbin.request.json');
}

function readRequest(workspaceDir) {
  try {
    return JSON.parse(fs.readFileSync(requestFilePath(workspaceDir), 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeRequest(workspaceDir, request) {
  fs.writeFileSync(requestFilePath(workspaceDir), JSON.stringify(request, null, 2), 'utf8');
}

function clearRequest(workspaceDir) {
  fs.rmSync(requestFilePath(workspaceDir), { force: true });
}

module.exports = {
  lockFilePath, readLock, writeLock, releaseLock, isLockStale, STALE_MS,
  requestFilePath, readRequest, writeRequest, clearRequest,
};
