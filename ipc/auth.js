// Sign-in, sign-out, and who the current user is.
//
// The role returned here is for the interface only -- deciding whether to show
// the user-management screen. It is NOT a security boundary. Every rule that
// matters is a row-level security policy in the database, because a determined
// user can edit this app's JavaScript but cannot edit Postgres. If this file
// and the policies ever disagree, the policies win, which is the point.

const {
  getSupabase,
  getCurrentDatabase,
  createScratchClient,
  clearStoredSession,
} = require('../db/supabase');
const { describeConnectionFailure } = require('../db/errors');

// Supabase's own messages leak implementation detail ("Invalid login
// credentials", "AuthApiError") and are not much help to somebody who has
// simply mistyped a password.
function friendlyAuthError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/invalid login credentials/i.test(message)) {
    return 'That email and password do not match an account.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'That account has not been confirmed yet. Ask an owner to confirm it.';
  }
  const connection = describeConnectionFailure(error);
  if (connection) return connection;
  if (/rate limit|too many/i.test(message)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return message;
}

// Checks a password without touching the open session. Signing in on the
// real client would check it too, but would also replace the session --
// harmless when it is the same person, a silent account switch if not.
async function verifyPassword(email, password) {
  let scratch;
  try {
    scratch = createScratchClient();
  } catch (err) {
    return { ok: false, connection: err.message };
  }
  const { error } = await scratch.auth.signInWithPassword({
    email,
    password: String(password || ''),
  });
  if (error) return { ok: false, connection: describeConnectionFailure(error) };

  // The check made a real session on the server. End just that one: the
  // default scope would sign the person out everywhere, this window included.
  try {
    await scratch.auth.signOut({ scope: 'local' });
  } catch (err) {
    // It expires on its own; nothing holds its refresh token.
  }
  return { ok: true };
}

module.exports = function registerAuth(ipcMain, getMainWindow) {
  let currentProfile = null;
  const resetListeners = [];

  // Anything held for the signed-in person -- the owner unlock on the Users
  // page, say -- is dropped whenever that person stops being signed in here.
  function reset() {
    currentProfile = null;
    for (const listener of resetListeners) listener();
  }

  async function loadProfile() {
    if (!getCurrentDatabase()) {
      reset();
      return null;
    }
    const supabase = getSupabase();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData || !userData.user) {
      reset();
      return null;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (error) {
      console.error('BookBin: could not load profile —', error.message);
      reset();
      return null;
    }

    // A signed-in user with no profile row means the account exists in auth
    // but was never given access -- every RLS policy will deny it, so treat it
    // as not signed in rather than showing an app that silently does nothing.
    if (!data) {
      reset();
      return null;
    }

    currentProfile = {
      id: data.id,
      email: data.email || userData.user.email,
      fullName: data.full_name,
      role: data.role,
    };
    return currentProfile;
  }

  function broadcast() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('auth:changed', currentProfile);
    }
  }

  ipcMain.handle('auth:signIn', async (_event, email, password) => {
    if (!getCurrentDatabase()) return { ok: false, error: 'Choose a database first.' };
    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || ''),
    });
    if (error) return { ok: false, error: friendlyAuthError(error) };

    const profile = await loadProfile();
    if (!profile) {
      // Signed in, but no profile: do not leave a usable session lying around.
      await supabase.auth.signOut();
      clearStoredSession();
      return {
        ok: false,
        error: 'That account has no access to this database. Ask an owner to add you.',
      };
    }

    broadcast();
    return { ok: true, profile };
  });

  ipcMain.handle('auth:signOut', async () => {
    try {
      // Local scope: signs out this computer only. The default would end the
      // person's sessions everywhere, which is not what the button says.
      if (getCurrentDatabase()) await getSupabase().auth.signOut({ scope: 'local' });
    } catch (err) {
      // Network failure should not strand somebody in a session they asked to
      // leave; the local session is cleared either way below.
      console.error('BookBin: sign-out call failed —', err.message);
    }
    clearStoredSession();
    reset();
    broadcast();
    return { ok: true };
  });

  // Called on startup: restores a saved session if the refresh token is still
  // good, and returns null if it is not, which is the cue to show the login.
  ipcMain.handle('auth:getSession', async () => {
    try {
      return await loadProfile();
    } catch (err) {
      console.error('BookBin: session restore failed —', err.message);
      return null;
    }
  });

  ipcMain.handle('auth:getProfile', () => currentProfile);

  // Re-reads the signed-in person's profile -- after their own role changed,
  // say -- and tells the window, which redraws to match.
  ipcMain.handle('auth:refresh', async () => {
    await loadProfile();
    broadcast();
    return currentProfile;
  });

  // Changing your own password, having proved you know the current one.
  //
  // Supabase's updateUser does not ask for the old password, so the check is
  // done by signing in with it first, on a throwaway client (see
  // verifyPassword). Be clear about what that is worth: an
  // attacker who already has the session could call updateUser directly and
  // skip this entirely. It is not a defence against someone who has taken
  // over the account -- it is a defence against someone who walks up to an
  // unlocked machine, and against changing the wrong account by accident.
  ipcMain.handle('auth:changePassword', async (_event, currentPassword, newPassword) => {
    if (!currentProfile) return { ok: false, error: 'You are not signed in.' };
    const supabase = getSupabase();

    const { data: userData } = await supabase.auth.getUser();
    const email = userData && userData.user && userData.user.email;
    if (!email) return { ok: false, error: 'You are not signed in.' };

    if (String(newPassword || '').length < 8) {
      return { ok: false, error: 'The new password must be at least 8 characters.' };
    }
    if (currentPassword === newPassword) {
      return { ok: false, error: 'The new password is the same as the current one.' };
    }

    const check = await verifyPassword(email, currentPassword);
    if (!check.ok) {
      return { ok: false, error: check.connection || 'Your current password is not correct.' };
    }

    const { error } = await supabase.auth.updateUser({ password: String(newPassword) });
    if (error) return { ok: false, error: friendlyAuthError(error) };

    return { ok: true };
  });

  return {
    getProfile: () => currentProfile,
    verifyPassword,
    onReset: (listener) => resetListeners.push(listener),
    // Called when a database is opened: signs straight back in if this machine
    // still holds a good session for it, and returns null if not.
    loadForOpenDatabase: async () => {
      try {
        return await loadProfile();
      } catch (err) {
        console.error('BookBin: session restore failed —', err.message);
        reset();
        return null;
      }
    },
    closeDatabase: () => reset(),
    isSignedIn: () => currentProfile !== null,
    isOwner: () => !!currentProfile && currentProfile.role === 'owner',
    refresh: async () => {
      await loadProfile();
      broadcast();
      return currentProfile;
    },
  };
};
