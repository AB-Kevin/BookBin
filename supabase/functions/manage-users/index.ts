// Creating and deleting BookBin accounts, and setting their passwords.
//
// This exists because creating a user requires Supabase's admin API, which
// requires the service_role key -- a key that ignores every row-level security
// policy in the database. Putting it in the app would hand complete control of
// the data to anyone who unpacked the installer, so the key stays here, on the
// server, and the app asks this function instead.
//
// The function does not trust the caller. A request arrives with the caller's
// own access token; the first thing that happens is asking the database, as
// that caller, whether they are an owner. Only then does anything touch the
// admin client. The app hides its user-management screen from managers, but
// that is cosmetic -- this check is what actually stops one.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Supabase is moving from the legacy anon / service_role JWTs to sb_ keys, and
// projects made since late 2025 have only the new ones. Those arrive as JSON
// dictionaries of named keys; the legacy variables are read only if they are
// absent, so this runs unchanged on old projects and new.
function projectKey(dictionaryVar: string, legacyVar: string): string {
  const dictionary = Deno.env.get(dictionaryVar);
  if (dictionary) {
    try {
      const keys = JSON.parse(dictionary) as Record<string, string>;
      const key = keys.default ?? Object.values(keys)[0];
      if (key) return key;
    } catch {
      // Not JSON; fall through to the legacy variable.
    }
  }
  return Deno.env.get(legacyVar) ?? '';
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = projectKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = projectKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');

const ROLES = ['owner', 'manager'];

// Printed once per cold start. A deployment that is not this code -- the
// dashboard's default template, say -- prints nothing, which is exactly the
// difference between "my function refused the request" and "my function was
// never there". Bump it when changing this file.
const VERSION = 'manage-users v3';
console.log(`${VERSION} booted`);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json(401, { error: 'Not signed in.' });

  // Acting as the caller, with only their own permissions.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // The token is passed explicitly: a client with no stored session does not
  // reliably fall back to the Authorization header when asked who it is.
  const { data: user } = await caller.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user?.user) return json(401, { error: 'Not signed in.' });

  const { data: isOwner, error: roleError } = await caller.rpc('is_owner');
  if (roleError) {
    console.error('is_owner failed:', roleError.message);
    return json(500, { error: 'Could not check your permissions.' });
  }
  if (!isOwner) {
    console.warn(`refused: ${user.user.id} is not an owner`);
    return json(403, { error: 'Only an owner can manage accounts.' });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Malformed request.' });
  }

  // Logged by id, not email: these lines are for working out what happened,
  // not for keeping a copy of who was hired.
  console.log(`${VERSION}: action=${body.action} by=${user.user.id}`);

  // Only from here on, having established the caller is an owner.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.action === 'create') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || 'manager');
    const fullName = String(body.fullName || '').trim();

    if (!email) return json(400, { error: 'An email address is required.' });
    if (password.length < 8) {
      return json(400, { error: 'The password must be at least 8 characters.' });
    }
    if (!ROLES.includes(role)) return json(400, { error: 'Unknown role.' });

    // email_confirm skips the confirmation email: an owner creating an account
    // for a colleague has already vouched for the address, and there is no
    // inbox to click through to in a desktop app.
    //
    // The role goes in app_metadata, which only the admin API can write. The
    // database trigger reads it from there and nowhere else, so a role cannot
    // be smuggled in through anything the user themselves controls.
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: fullName ? { full_name: fullName } : {},
    });

    if (error) {
      console.error('createUser failed:', error.message);
      const message = /already been registered|already exists/i.test(error.message)
        ? 'An account with that email already exists.'
        : error.message;
      return json(400, { error: message });
    }

    const id = data.user?.id;
    if (!id) return json(500, { error: 'The account was not created.' });

    // The on_auth_user_created trigger should have written this row already.
    // Doing it again costs one statement and removes a silent failure: without
    // a profile the account exists, cannot be listed, and is bounced straight
    // back out at sign-in, with nothing anywhere saying why.
    const { error: profileError } = await admin
      .from('profiles')
      .upsert({ id, email, full_name: fullName || null, role }, { onConflict: 'id' });

    if (profileError) {
      console.error('profile upsert failed, rolling back:', profileError.message);
      // Leaving an auth user with no profile would be worse than no account.
      await admin.auth.admin.deleteUser(id);
      return json(500, { error: `The account could not be set up: ${profileError.message}` });
    }

    console.log(`created ${id} as ${role}`);
    return json(200, { ok: true, id, email, role });
  }

  if (body.action === 'delete') {
    const userId = String(body.userId || '');
    if (!userId) return json(400, { error: 'Which account?' });
    if (userId === user.user.id) {
      return json(400, { error: 'You cannot remove your own account.' });
    }

    // Deleting the auth user cascades to its profile row, where the
    // guard_last_owner trigger fires. Removing the only remaining owner
    // therefore fails here rather than leaving nobody able to manage accounts.
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      const message = /last owner/i.test(error.message)
        ? 'That is the only owner. Promote someone else first.'
        : error.message;
      return json(400, { error: message });
    }
    return json(200, { ok: true });
  }

  if (body.action === 'setPassword') {
    const userId = String(body.userId || '');
    const password = String(body.password || '');
    if (!userId) return json(400, { error: 'Which account?' });
    if (password.length < 8) {
      return json(400, { error: 'The password must be at least 8 characters.' });
    }
    // Your own goes through Settings, which asks for the current password.
    // Letting an owner skip that here would make that check pointless for
    // exactly the accounts it matters most on.
    if (userId === user.user.id) {
      return json(400, { error: 'Change your own password in Settings.' });
    }

    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) {
      console.error('updateUserById failed:', error.message);
      return json(400, { error: error.message });
    }
    console.log(`password set for ${userId}`);
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action.' });
});
