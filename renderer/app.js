// Tiny hash router. Hash shape: #/<section>[/<param>], e.g.
//   #/dashboard
//   #/items
//   #/incoming-invoices/new
//   #/incoming-invoices/5

const NAV_ITEMS = [
  { path: 'dashboard', label: 'Dashboard', icon: '🏠' },
  { path: 'items', label: 'Items', icon: '📦' },
  { path: 'vendors', label: 'Vendors', icon: '🏭' },
  { path: 'customers', label: 'Customers', icon: '👥' },
  { path: 'incoming-invoices', label: 'Incoming Invoices', icon: '📥' },
  { path: 'outgoing-invoices', label: 'Outgoing Invoices', icon: '📤' },
  { path: 'purchase-orders', label: 'Purchase Orders', icon: '📝' },
  { path: 'settings', label: 'Settings', icon: '⚙️' },
];

const SIDEBAR_COLLAPSED_KEY = 'bookbin.sidebarCollapsed';

function buildNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV_ITEMS.map(
    (item) => `<a class="nav-link" href="#/${item.path}" data-section="${item.path}" title="${item.label}">
      <span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span>
    </a>`
  ).join('');
  // Routed through navigate() (not the native hash link) so a dirty form's
  // save-prompt guard applies to sidebar clicks too, not just in-screen buttons.
  nav.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.Helpers.navigate(`/${link.dataset.section}`);
    });
  });
}

function setSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  sidebar.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (err) {
    // localStorage unavailable (e.g. private mode) — just skip persisting.
  }
}

function initSidebarToggle() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch (err) {
    // ignore
  }
  setSidebarCollapsed(collapsed);

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    setSidebarCollapsed(!document.getElementById('sidebar').classList.contains('collapsed'));
  });
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const section = parts[0] || 'dashboard';
  const rest = parts.slice(1);
  // `param` (rest[0]) is kept for every existing screen's #/section/param
  // shape; `rest` is the full remaining path for screens nested deeper than
  // that, like purchase-orders/:id/lines/:lineId.
  return { section, param: rest[0] || null, rest };
}

function screenFor(section) {
  const map = {
    dashboard: window.Screens.dashboard,
    items: window.Screens.items,
    vendors: window.Screens.vendors,
    customers: window.Screens.customers,
    'incoming-invoices': window.Screens.incomingInvoices,
    'outgoing-invoices': window.Screens.outgoingInvoices,
    'purchase-orders': window.Screens.purchaseOrders,
    settings: window.Screens.settings,
  };
  return map[section] || window.Screens.dashboard;
}

async function render() {
  if (!currentProfile) return;
  const { section, param, rest } = parseHash();
  window.Helpers.qsa('.nav-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === section);
  });

  const container = document.getElementById('content');
  container.innerHTML = '<p class="loading">Loading…</p>';
  try {
    await screenFor(section)(container, param, rest);
  } catch (err) {
    console.error(err);
    container.innerHTML = `<p class="error">Something went wrong: ${window.Helpers.escapeHtml(err.message)}</p>`;
  }
}

// --- Update checking -------------------------------------------------------
// ipc/updates.js owns autoUpdater and does all the talking to GitHub; this
// just mirrors the status it pushes over "updates:status" into the sidebar
// footer widget.
let currentProfile = null;
let appStarted = false;

let updateStatus = { state: 'idle' };
let appVersion = '';

// "not-available" is shown only briefly: after the startup auto-check
// confirms there's nothing new, sitting on "Up to date" forever would be a
// permanent, slightly odd fixture in the sidebar — it reverts back to the
// plain "Check for updates" link on its own instead. Every other status
// (available/downloading/downloaded/error) is left as-is, since those need a
// person to actually do something about them.
const NOT_AVAILABLE_DISPLAY_MS = 4000;
let notAvailableResetTimer = null;

function setUpdateStatus(status) {
  if (notAvailableResetTimer) {
    clearTimeout(notAvailableResetTimer);
    notAvailableResetTimer = null;
  }
  updateStatus = status;
  renderUpdateWidget();
  if (status.state === 'not-available') {
    notAvailableResetTimer = setTimeout(() => {
      notAvailableResetTimer = null;
      updateStatus = { state: 'idle' };
      renderUpdateWidget();
    }, NOT_AVAILABLE_DISPLAY_MS);
  }
}

async function checkForUpdates() {
  setUpdateStatus({ state: 'checking' });
  await window.api.updates.check();
}

async function downloadUpdate() {
  setUpdateStatus({ ...updateStatus, state: 'downloading', percent: 0 });
  await window.api.updates.download();
}

function restartToInstall() {
  window.api.updates.quitAndInstall();
}

// Mac builds can't silently install (see ipc/updates.js's IS_MAC comment), so
// an available update there just opens the GitHub release page for the user
// to download and install by hand instead.
function openReleasesPage() {
  window.api.updates.openReleasesPage();
}

function renderUpdateWidget() {
  const footer = document.getElementById('sidebar-footer');
  if (!footer) return;
  const { escapeHtml } = window.Helpers;
  const s = updateStatus;
  let action;
  if (s.state === 'checking') {
    action = `<span class="update-row">Checking for updates…</span>`;
  } else if (s.state === 'available') {
    action = `<button class="update-btn primary" id="update-download">Download update ${escapeHtml(s.version)}</button>`;
  } else if (s.state === 'available-manual') {
    action = `<button class="update-btn primary" id="update-manual">Get update ${escapeHtml(s.version)}</button>`;
  } else if (s.state === 'downloading') {
    action = `<span class="update-row">Downloading… ${s.percent ?? 0}%</span>`;
  } else if (s.state === 'downloaded') {
    action = `<button class="update-btn" id="update-restart">Restart to install</button>`;
  } else if (s.state === 'not-available') {
    action = `<span class="update-row clickable" id="update-recheck">Up to date</span>`;
  } else if (s.state === 'error') {
    action = `<span class="update-row clickable error" id="update-recheck" title="${escapeHtml(s.message || '')}">Update check failed</span>`;
  } else {
    action = `<span class="update-row clickable" id="update-check">Check for updates</span>`;
  }

  footer.innerHTML = `<span class="app-version">Version ${escapeHtml(appVersion)}</span>${action}`;

  const downloadBtn = footer.querySelector('#update-download');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadUpdate);
  const manualBtn = footer.querySelector('#update-manual');
  if (manualBtn) manualBtn.addEventListener('click', openReleasesPage);
  const restartBtn = footer.querySelector('#update-restart');
  if (restartBtn) restartBtn.addEventListener('click', restartToInstall);
  const checkBtn = footer.querySelector('#update-check');
  if (checkBtn) checkBtn.addEventListener('click', checkForUpdates);
  const recheckBtn = footer.querySelector('#update-recheck');
  if (recheckBtn) recheckBtn.addEventListener('click', checkForUpdates);
}

async function initUpdateWidget() {
  appVersion = await window.api.updates.getVersion();
  window.api.updates.onStatus((status) => setUpdateStatus(status));
  renderUpdateWidget();
  checkForUpdates(); // not awaited — a startup check shouldn't block the UI
}

// Delegated so any screen can drop in a linkify()'d field without wiring its
// own click handler for each link.
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-ext-link]');
  if (!link) return;
  e.preventDefault();
  window.api.shell.openExternal(link.dataset.extLink);
});

// Covers closing the window/app with unsaved work — in-app navigation is
// already guarded via navigate() itself (see helpers.js).
window.addEventListener('beforeunload', (e) => {
  if (!window.Helpers.hasUnsavedChanges()) return;
  e.preventDefault();
  e.returnValue = '';
});

// Tells ipc/activity.js's auto-close timer someone is actually using BookBin.
// Deliberately scoped to input inside this window rather than Electron's
// system-wide idle time, so leaving the app open in the background while
// working in something else doesn't keep the shared write lock held.
// Throttled to once/second — plenty of resolution for a 2-hour timer, and
// far cheaper than pinging on every mousemove.
let lastActivityPing = 0;
function notifyActivity() {
  const now = Date.now();
  if (now - lastActivityPing < 1000) return;
  lastActivityPing = now;
  window.api.activity.notify();
}
['mousedown', 'mousemove', 'keydown', 'wheel', 'touchstart'].forEach((type) => {
  window.addEventListener(type, notifyActivity, { passive: true });
});

// --- Shared-database lock + inactivity auto-close banners -------------------
// ipc/lock.js owns whether another device currently holds the write lock
// (plus the request-access handshake); ipc/activity.js owns the 2-hour-idle
// auto-close countdown. All of them just push status here — the CSS in
// styles.css (body.read-only-mode) is what actually disables editing
// controls app-wide once the class is applied below.
let lockStatus = { readOnly: false, lockedByHost: null, lockedAt: null };
let myRequestState = null; // 'waiting' | 'granted' | 'declined' | 'timed-out' | null
let incomingRequest = null; // { requestId, requestedByHost, remainingSeconds } | null (holder side)
let autoCloseRemaining = null;
let requestResultClearTimer = null;

function formatLockTimestamp(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch (err) {
    return iso;
  }
}

function renderBanners() {
  const root = document.getElementById('banner-root');
  const { escapeHtml } = window.Helpers;
  const parts = [];

  if (lockStatus.readOnly) {
    if (myRequestState === 'waiting') {
      parts.push(`
        <div class="banner banner-readonly">
          ⏳ Waiting for <strong>${escapeHtml(lockStatus.lockedByHost || 'the other computer')}</strong>
          to respond to your access request (up to 5 minutes)…
        </div>
      `);
    } else {
      const since = lockStatus.lockedAt ? ` since ${escapeHtml(formatLockTimestamp(lockStatus.lockedAt))}` : '';
      const note = myRequestState === 'declined' ? ' Your last request was declined.'
        : myRequestState === 'timed-out' ? ' Your last request timed out with no response.'
        : '';
      parts.push(`
        <div class="banner banner-readonly">
          🔒 Read-only — this database is currently open on
          <strong>${escapeHtml(lockStatus.lockedByHost || 'another computer')}</strong>${since}.${note}
          <button type="button" class="btn small" id="request-access-btn">Request Access</button>
        </div>
      `);
    }
  } else if (myRequestState === 'granted') {
    parts.push(`<div class="banner banner-granted">✅ Access granted — you can edit again.</div>`);
  }

  if (incomingRequest) {
    const mins = Math.floor(incomingRequest.remainingSeconds / 60);
    const secs = String(incomingRequest.remainingSeconds % 60).padStart(2, '0');
    parts.push(`
      <div class="banner banner-request">
        📨 <strong>${escapeHtml(incomingRequest.requestedByHost)}</strong> is requesting access to this database.
        <button type="button" class="btn small primary" id="retain-access-btn">Retain Access</button>
        <button type="button" class="btn small" id="release-access-btn">Release Access</button>
        <span>Auto-releasing in ${mins}:${secs}</span>
      </div>
    `);
  }

  if (autoCloseRemaining != null) {
    parts.push(`
      <div class="banner banner-autoclose">
        ⏳ BookBin will close in ${autoCloseRemaining}s due to inactivity.
        <button type="button" class="btn small" id="keep-open-btn">Keep Open</button>
      </div>
    `);
  }

  root.innerHTML = parts.join('');

  const requestBtn = document.getElementById('request-access-btn');
  if (requestBtn) {
    requestBtn.addEventListener('click', () => {
      myRequestState = 'waiting';
      renderBanners();
      window.api.lock.requestAccess();
    });
  }
  const retainBtn = document.getElementById('retain-access-btn');
  if (retainBtn) {
    retainBtn.addEventListener('click', () => {
      incomingRequest = null;
      renderBanners();
      window.api.lock.respondToRequest('retain');
    });
  }
  const releaseBtn = document.getElementById('release-access-btn');
  if (releaseBtn) {
    releaseBtn.addEventListener('click', () => {
      incomingRequest = null;
      renderBanners();
      window.api.lock.respondToRequest('release');
    });
  }
  const keepOpenBtn = document.getElementById('keep-open-btn');
  // Clicking this counts as input inside the window, so it resets the same
  // clock ipc/activity.js reads from — this just hides the banner instantly
  // instead of waiting up to a second for that to come back around.
  if (keepOpenBtn) {
    keepOpenBtn.addEventListener('click', () => {
      autoCloseRemaining = null;
      renderBanners();
    });
  }
}

function applyLockStatus(status) {
  lockStatus = status;
  // Cover the case where the lock simply freed up (holder quit, went stale)
  // rather than our request being explicitly answered — still a "granted"
  // outcome from the requester's point of view, regardless of event order
  // against the dedicated lock:requestResult push below.
  if (!status.readOnly && myRequestState === 'waiting') {
    myRequestState = 'granted';
  }
  document.body.classList.toggle('read-only-mode', status.readOnly);
  renderBanners();
}

// Transient outcomes (declined/timed-out/granted) shouldn't linger forever
// once they've been seen.
function setRequestResult(result) {
  myRequestState = result;
  renderBanners();
  if (requestResultClearTimer) clearTimeout(requestResultClearTimer);
  requestResultClearTimer = setTimeout(() => {
    myRequestState = null;
    renderBanners();
  }, 5000);
}

async function initLockAndActivity() {
  applyLockStatus(await window.api.lock.getStatus());
  window.api.lock.onStatus(applyLockStatus);
  window.api.lock.onIncomingRequest((payload) => {
    incomingRequest = payload;
    renderBanners();
  });
  window.api.lock.onRequestResult(({ result }) => setRequestResult(result));
  window.api.activity.onCountdown(({ remainingSeconds }) => {
    autoCloseRemaining = remainingSeconds;
    renderBanners();
  });
}

function renderUserWidget() {
  const box = document.getElementById('sidebar-user');
  if (!box) return;
  if (!currentProfile) {
    box.innerHTML = '';
    return;
  }
  const { escapeHtml } = window.Helpers;
  const name = currentProfile.fullName || currentProfile.email || 'Signed in';
  const role = currentProfile.role === 'owner' ? 'Owner' : 'Manager';
  box.innerHTML = `
    <div class="user-row" title="${escapeHtml(currentProfile.email || '')}">
      <span class="user-name">${escapeHtml(name)}</span>
      <span class="user-role">${escapeHtml(role)}</span>
    </div>
    <button class="user-signout" id="sign-out-btn" type="button" title="Sign out" aria-label="Sign out"><span class="signout-label">Sign out</span><span class="signout-icon" aria-hidden="true">⎋</span></button>
  `;
  box.querySelector('#sign-out-btn').addEventListener('click', async () => {
    await window.api.auth.signOut();
  });
}

// Everything below the login runs once, the first time somebody signs in.
// Signing out and back in re-renders but does not re-attach listeners.
function startApp() {
  if (appStarted) return;
  appStarted = true;
  buildNav();
  initSidebarToggle();
  initUpdateWidget();
  initLockAndActivity();
}

function applyProfile(profile) {
  currentProfile = profile || null;
  document.body.classList.toggle('signed-out', !currentProfile);
  if (currentProfile) {
    startApp();
    renderUserWidget();
    render();
  } else {
    renderUserWidget();
    window.Login.reset();
    window.Login.show();
  }
}

async function initAuth() {
  // Start hidden rather than flashing the app for the moment it takes to
  // learn there is no session.
  document.body.classList.add('signed-out');
  let profile = null;
  try {
    profile = await window.api.auth.getSession();
  } catch (err) {
    console.error('session check failed', err);
  }
  applyProfile(profile);
  window.api.auth.onChanged(applyProfile);
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', initAuth);
