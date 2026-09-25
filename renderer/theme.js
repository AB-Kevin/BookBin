// Light/dark theme. Loaded in <head>, ahead of the stylesheet's first paint,
// so a dark window never flashes light while the rest of the app loads.
//
// The choice is per computer (localStorage). With nothing saved, BookBin
// follows the OS setting and keeps following it if that changes; the toggle
// pins it to whichever one it switches to.

(function () {
  const KEY = 'bookbin.theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function current() {
    return saved() || (media.matches ? 'dark' : 'light');
  }

  function apply() {
    const theme = current();
    document.documentElement.dataset.theme = theme;
    // Mirrors it onto the native title bar and menus (see ipc/theme.js).
    if (window.api && window.api.theme) window.api.theme.set(saved() || 'system');
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      const next = theme === 'dark' ? 'light' : 'dark';
      btn.title = `Switch to ${next} mode`;
      btn.setAttribute('aria-label', btn.title);
      const icon = btn.querySelector('.icon');
      if (icon) icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
    });
  }

  function toggle() {
    const next = current() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch (err) {
      // Not persisted, but still switches for this session.
      document.documentElement.dataset.theme = next;
      return;
    }
    apply();
  }

  media.addEventListener('change', () => {
    if (!saved()) apply();
  });

  // Delegated, so the launcher and sidebar can both drop in a toggle button
  // without wiring it themselves.
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-toggle]')) toggle();
  });

  apply();
  // Again once the body exists, for the toggle buttons' icons and titles.
  document.addEventListener('DOMContentLoaded', apply);
  window.Theme = { apply, toggle, current };
})();
