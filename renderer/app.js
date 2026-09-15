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

buildNav();
initSidebarToggle();
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);
