// The sign-in screen.
//
// Nothing here decides anything about access. It collects an email and a
// password, hands them to the main process, and shows whatever comes back.
// Whether that account may read or write a single row is settled by row-level
// security in the database, which this window cannot influence.

(function () {
  let submitting = false;

  function root() {
    return document.getElementById('login-root');
  }

  function render(errorMessage) {
    const { escapeHtml } = window.Helpers;
    root().innerHTML = `
      <div class="login-card">
        <div class="login-brand">
          <span class="login-icon">📒</span>
          <span class="login-title">BookBin</span>
        </div>
        <p class="login-sub">Sign in to continue</p>

        <form id="login-form" autocomplete="on" novalidate>
          <label class="login-label" for="login-email">Email</label>
          <input class="login-input" id="login-email" name="email" type="email"
                 autocomplete="username" required />

          <label class="login-label" for="login-password">Password</label>
          <input class="login-input" id="login-password" name="password" type="password"
                 autocomplete="current-password" required />

          <div class="login-error" id="login-error" role="alert" aria-live="polite">${
            errorMessage ? escapeHtml(errorMessage) : ''
          }</div>

          <button class="login-submit" id="login-submit" type="submit">Sign in</button>
        </form>
      </div>
    `;

    const form = document.getElementById('login-form');
    form.addEventListener('submit', onSubmit);
    document.getElementById('login-email').focus();
  }

  function setError(message) {
    const box = document.getElementById('login-error');
    if (box) box.textContent = message || '';
  }

  function setSubmitting(value) {
    submitting = value;
    const button = document.getElementById('login-submit');
    const email = document.getElementById('login-email');
    const password = document.getElementById('login-password');
    if (button) {
      button.disabled = value;
      button.textContent = value ? 'Signing in…' : 'Sign in';
    }
    if (email) email.disabled = value;
    if (password) password.disabled = value;
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) {
      setError('Enter both an email and a password.');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      const result = await window.api.auth.signIn(email, password);
      if (!result.ok) {
        setSubmitting(false);
        setError(result.error);
        const passwordField = document.getElementById('login-password');
        passwordField.value = '';
        passwordField.focus();
        return;
      }
      // On success the main process broadcasts auth:changed, and app.js swaps
      // the view. Deliberately leave the button disabled until that happens so
      // a second click cannot fire another sign-in.
    } catch (err) {
      setSubmitting(false);
      setError('Something went wrong signing in. Please try again.');
      console.error('sign-in failed', err);
    }
  }

  window.Login = {
    show(errorMessage) {
      render(errorMessage);
    },
    reset() {
      submitting = false;
    },
  };
})();
