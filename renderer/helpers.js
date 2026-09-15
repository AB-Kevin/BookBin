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

function navigate(path) {
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
  formatMoney,
  formatDate,
  todayIso,
  qs,
  qsa,
  showModal,
  hideModal,
  confirmAction,
  navigate,
  createSortState,
  sortedRows,
  sortableHeader,
  wireSortableHeaders,
};
