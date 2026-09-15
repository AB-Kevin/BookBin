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
  const [section, param] = raw.split('/');
  return { section: section || 'dashboard', param: param || null };
}

function screenFor(section) {
  const map = {
    dashboard: window.Screens.dashboard,
    items: window.Screens.items,
    vendors: window.Screens.vendors,
    customers: window.Screens.customers,
    'incoming-invoices': window.Screens.incomingInvoices,
    'outgoing-invoices': window.Screens.outgoingInvoices,
    settings: window.Screens.settings,
  };
  return map[section] || window.Screens.dashboard;
}

async function render() {
  const { section, param } = parseHash();
  window.Helpers.qsa('.nav-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === section);
  });

  const container = document.getElementById('content');
  container.innerHTML = '<p class="loading">Loading…</p>';
  try {
    await screenFor(section)(container, param);
  } catch (err) {
    console.error(err);
    container.innerHTML = `<p class="error">Something went wrong: ${window.Helpers.escapeHtml(err.message)}</p>`;
  }
}

// --- Update checking -------------------------------------------------------
// ipc/updates.js owns autoUpdater and does all the talking to GitHub; this
// just mirrors the status it pushes over "updates:status" into the sidebar
// footer widget.
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

buildNav();
initSidebarToggle();
initUpdateWidget();
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
