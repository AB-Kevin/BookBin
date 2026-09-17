// Small shared DOM/formatting helpers used by every screen module.
// Loaded as a plain <script>, so it just hangs everything off `window.Helpers`.

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

// Escapes text and turns http(s)/www URLs into clickable spans. Real <a href>
// isn't used since clicking one would navigate the app's own BrowserWindow;
// app.js instead delegates clicks on [data-ext-link] to shell.openExternal.
function linkify(text) {
  const str = String(text == null ? '' : text);
  const urlPattern = /\bhttps?:\/\/[^\s<]+|\bwww\.[^\s<]+/gi;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(str))) {
    result += escapeHtml(str.slice(lastIndex, match.index));
    let raw = match[0];
    let trail = '';
    while (raw && /[.,;:!?)\]}'"]$/.test(raw)) {
      trail = raw.slice(-1) + trail;
      raw = raw.slice(0, -1);
    }
    const href = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    result += `<a href="#" class="ext-link" data-ext-link="${escapeHtml(href)}">${escapeHtml(raw)}</a>${escapeHtml(trail)}`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(str.slice(lastIndex));
  return result;
}

function formatMoney(n) {
  const num = Number(n || 0);
  return `$${num.toFixed(2)}`;
}

function formatDate(isoLike) {
  if (!isoLike) return '';
  return String(isoLike).slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function qs(sel, root) {
  return (root || document).querySelector(sel);
}

function qsa(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}

function showModal(innerHtml) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${innerHtml}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('modal-backdrop')) hideModal();
  });
  return root.querySelector('.modal');
}

function hideModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
}

async function confirmAction(message) {
  return window.confirm(message);
}

// A screen with unsaved work registers a guard ({ isDirty, confirmLeave })
// while it's mounted. navigate() is the single choke point every screen uses
// to move around (buttons, nav-link clicks, prev/next), so routing all of
// them through here is what makes the "prompt to save" behavior automatic
// everywhere instead of needing to be wired into each call site.
let activeGuard = null;

function setNavigationGuard(guard) {
  activeGuard = guard;
}

function clearNavigationGuard() {
  activeGuard = null;
}

function hasUnsavedChanges() {
  return Boolean(activeGuard && activeGuard.isDirty && activeGuard.isDirty());
}

// Three-way prompt (Save / Discard / keep editing) for leaving a dirty form.
// Resolves 'save' | 'discard' | 'cancel'; dismissing via the backdrop counts
// as 'cancel' (stay put) rather than leaving the promise hanging forever.
function confirmSaveChanges(message) {
  return new Promise((resolve) => {
    const modal = showModal(`
      <h2>Unsaved Changes</h2>
      <p>${escapeHtml(message || 'This has unsaved changes.')}</p>
      <div class="modal-actions">
        <button type="button" class="btn" id="discard-btn">Discard</button>
        <button type="button" class="btn" id="stay-btn">Keep Editing</button>
        <button type="button" class="btn primary" id="save-btn">Save</button>
      </div>
    `);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      hideModal();
      resolve(result);
    };
    modal.querySelector('#discard-btn').addEventListener('click', () => finish('discard'));
    modal.querySelector('#stay-btn').addEventListener('click', () => finish('cancel'));
    modal.querySelector('#save-btn').addEventListener('click', () => finish('save'));
    modal.parentElement.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-backdrop')) finish('cancel');
    });
  });
}

async function navigate(path) {
  if (activeGuard) {
    const proceed = await activeGuard.confirmLeave();
    if (!proceed) return;
  }
  activeGuard = null;
  window.location.hash = path;
}

// --- Sortable-table support, shared by every list screen -----------------
// A screen keeps one `sortState` object ({ key, dir }) for the lifetime of
// its render, builds `<th>` cells with sortableHeader(), sorts its rows
// with sortedRows() before rendering, and wires header clicks with
// wireSortableHeaders() to flip sortState and re-render (no refetch needed).

function createSortState(defaultKey, defaultDir) {
  return { key: defaultKey || null, dir: defaultDir || 'asc' };
}

function sortedRows(rows, sortState) {
  if (!sortState || !sortState.key) return rows;
  const dir = sortState.dir === 'desc' ? -1 : 1;
  const key = sortState.key;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return -1 * dir;
    if (bv == null) return 1 * dir;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function sortableHeader(label, key, sortState, extraClass) {
  const active = sortState && sortState.key === key;
  const arrow = active ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const cls = ['sortable', extraClass, active ? 'sorted' : ''].filter(Boolean).join(' ');
  return `<th class="${cls}" data-sort-key="${escapeHtml(key)}">${escapeHtml(label)}${arrow}</th>`;
}

function wireSortableHeaders(root, sortState, onChange) {
  qsa('th.sortable', root).forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = 'asc';
      }
      onChange();
    });
  });
}

window.Helpers = {
  escapeHtml,
  linkify,
  formatMoney,
  formatDate,
  todayIso,
  qs,
  qsa,
  showModal,
  hideModal,
  confirmAction,
  navigate,
  setNavigationGuard,
  clearNavigationGuard,
  hasUnsavedChanges,
  confirmSaveChanges,
  createSortState,
  sortedRows,
  sortableHeader,
  wireSortableHeaders,
};
