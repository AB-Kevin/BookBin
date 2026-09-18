const os = require('os');
const crypto = require('crypto');
const {
  readLock, writeLock, releaseLock, isLockStale,
  readRequest, writeRequest, clearRequest,
} = require('../lock');

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // refresh our own lock while we hold it
const RECHECK_INTERVAL_MS = 5 * 60 * 1000; // how often we check whether it's freed up
const REQUEST_POLL_INTERVAL_MS = 10 * 1000; // holder: how often to check for an incoming request
const REQUEST_WAIT_POLL_INTERVAL_MS = 5 * 1000; // requester: how often to check for a response
const REQUEST_GRANT_WINDOW_MS = 5 * 60 * 1000; // holder's countdown before it auto-releases
const REQUEST_WAIT_TIMEOUT_MS = REQUEST_GRANT_WINDOW_MS + 30 * 1000; // requester's safety margin over that

// Claims (or waits for) the shared workspace's write lock, and layers a
// "request access" handshake on top of it: the read-only side can ask, the
// holder gets a banner with a 5-minute reply window (Retain/Release), and an
// unanswered request auto-releases. Not a true distributed lock — two people
// launching BookBin at almost exactly the same moment could both briefly
// believe they hold it, since there's no shared arbiter, only a file that
// syncs asynchronously — but it closes the far more common case of "someone
// already has this open" and self-heals if a holder crashes or sleeps (see
// STALE_MS in ../lock.js).
module.exports = function registerLock(ipcMain, workspaceDir, getMainWindow) {
  const instanceId = crypto.randomUUID();
  const hostname = os.hostname();

  let readOnly = false;
  let lockedByHost = null;
  let lockedAt = null;
  let myLockedAt = null;

  let heartbeatTimer = null;
  let recheckTimer = null;
  let requestPollTimer = null; // holder: watches for an incoming request
  let incomingRequestTimer = null; // holder: countdown on a request currently shown

  let activeIncomingRequest = null; // { requestId, requestedByHost, deadlineAt }
  let myPendingRequestId = null; // requester: the request we're waiting on
  let myRequestTimeoutTimer = null;

  function stopTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
    if (requestPollTimer) { clearInterval(requestPollTimer); requestPollTimer = null; }
    if (incomingRequestTimer) { clearInterval(incomingRequestTimer); incomingRequestTimer = null; }
  }

  function broadcast() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('lock:status', { readOnly, lockedByHost, lockedAt });
    }
  }

  function claim() {
    myLockedAt = new Date().toISOString();
    writeLock(workspaceDir, { instanceId, hostname, lockedAt: myLockedAt, heartbeatAt: new Date().toISOString() });
    readOnly = false;
    lockedByHost = null;
    lockedAt = null;
    stopTimers();
    heartbeatTimer = setInterval(() => {
      writeLock(workspaceDir, { instanceId, hostname, lockedAt: myLockedAt, heartbeatAt: new Date().toISOString() });
    }, HEARTBEAT_INTERVAL_MS);
    requestPollTimer = setInterval(checkForIncomingRequest, REQUEST_POLL_INTERVAL_MS);
    broadcast();
  }

  function attempt() {
    const current = readLock(workspaceDir);
    if (!current || current.instanceId === instanceId || isLockStale(current)) {
      claim();
    } else {
      readOnly = true;
      lockedByHost = current.hostname;
      lockedAt = current.lockedAt;
      stopTimers();
      recheckTimer = setInterval(attempt, RECHECK_INTERVAL_MS);
      broadcast();
    }
  }

  // --- Holder side: watch for, and respond to, an incoming access request --

  function checkForIncomingRequest() {
    if (readOnly) return;
    const request = readRequest(workspaceDir);
    if (!request || request.status !== 'pending') return;
    if (activeIncomingRequest && activeIncomingRequest.requestId === request.requestId) return;

    activeIncomingRequest = {
      requestId: request.requestId,
      requestedByHost: request.requestedByHost,
      deadlineAt: Date.now() + REQUEST_GRANT_WINDOW_MS,
    };
    if (incomingRequestTimer) clearInterval(incomingRequestTimer);
    incomingRequestTimer = setInterval(() => {
      const remaining = Math.ceil((activeIncomingRequest.deadlineAt - Date.now()) / 1000);
      if (remaining <= 0) {
        respondToRequest('release'); // unanswered -> auto-release
        return;
      }
      broadcastIncomingRequest(remaining);
    }, 1000);
    broadcastIncomingRequest(Math.ceil(REQUEST_GRANT_WINDOW_MS / 1000));
  }

  function broadcastIncomingRequest(remainingSeconds) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (!activeIncomingRequest) {
      win.webContents.send('lock:incomingRequest', null);
      return;
    }
    win.webContents.send('lock:incomingRequest', {
      requestId: activeIncomingRequest.requestId,
      requestedByHost: activeIncomingRequest.requestedByHost,
      remainingSeconds,
    });
  }

  // action is 'retain' (keep editing, tell the requester no) or 'release'
  // (give up the lock now, whether clicked or from the countdown running out).
  function respondToRequest(action) {
    if (!activeIncomingRequest) return;
    const { requestId, requestedByHost } = activeIncomingRequest;
    if (incomingRequestTimer) { clearInterval(incomingRequestTimer); incomingRequestTimer = null; }
    activeIncomingRequest = null;
    broadcastIncomingRequest();

    if (action === 'release') {
      clearRequest(workspaceDir);
      stopTimers();
      releaseLock(workspaceDir, instanceId);
      // Deliberately don't re-attempt immediately — that would race the
      // requester's own fast poll for the very lock we just freed for them.
      // We just step back to waiting like anyone else, on the normal cadence.
      readOnly = true;
      lockedByHost = null;
      lockedAt = null;
      recheckTimer = setInterval(attempt, RECHECK_INTERVAL_MS);
      broadcast();
    } else {
      writeRequest(workspaceDir, { requestId, requestedByHost, status: 'declined' });
    }
  }

  // --- Requester side: ask for access, then poll fast for a response -------

  function requestAccess() {
    if (!readOnly) return { ok: false, reason: 'not-read-only' };

    const requestId = crypto.randomUUID();
    writeRequest(workspaceDir, {
      requestId,
      requestedByHost: hostname,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    myPendingRequestId = requestId;

    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = setInterval(checkMyRequest, REQUEST_WAIT_POLL_INTERVAL_MS);

    if (myRequestTimeoutTimer) clearTimeout(myRequestTimeoutTimer);
    myRequestTimeoutTimer = setTimeout(() => {
      if (myPendingRequestId !== requestId) return; // already resolved
      myPendingRequestId = null;
      sendRequestResult(requestId, 'timed-out');
      if (recheckTimer) clearInterval(recheckTimer);
      recheckTimer = setInterval(attempt, RECHECK_INTERVAL_MS);
    }, REQUEST_WAIT_TIMEOUT_MS);

    return { ok: true, requestId };
  }

  function checkMyRequest() {
    // The lock may have simply freed up on its own (holder quit, went
    // stale, etc.) — that counts as "granted" regardless of the request.
    const current = readLock(workspaceDir);
    if (!current || current.instanceId === instanceId || isLockStale(current)) {
      if (myRequestTimeoutTimer) { clearTimeout(myRequestTimeoutTimer); myRequestTimeoutTimer = null; }
      const requestId = myPendingRequestId;
      myPendingRequestId = null;
      clearRequest(workspaceDir);
      claim();
      sendRequestResult(requestId, 'granted');
      return;
    }

    const request = readRequest(workspaceDir);
    if (request && request.requestId === myPendingRequestId && request.status === 'declined') {
      if (myRequestTimeoutTimer) { clearTimeout(myRequestTimeoutTimer); myRequestTimeoutTimer = null; }
      const requestId = myPendingRequestId;
      myPendingRequestId = null;
      clearRequest(workspaceDir);
      sendRequestResult(requestId, 'declined');
      if (recheckTimer) clearInterval(recheckTimer);
      recheckTimer = setInterval(attempt, RECHECK_INTERVAL_MS);
    }
  }

  function sendRequestResult(requestId, result) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('lock:requestResult', { requestId, result });
    }
  }

  attempt();

  ipcMain.handle('lock:getStatus', () => ({ readOnly, lockedByHost, lockedAt }));
  ipcMain.handle('lock:requestAccess', () => requestAccess());
  ipcMain.handle('lock:respondToRequest', (_e, action) => {
    respondToRequest(action);
    return { ok: true };
  });

  return {
    isReadOnly: () => readOnly,
    releaseIfHeld: () => {
      stopTimers();
      if (!readOnly) releaseLock(workspaceDir, instanceId);
    },
  };
};
