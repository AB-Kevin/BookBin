// Setting up a blank Supabase project as a BookBin database, from inside the
// app.
//
// Everything that used to be a list of manual steps in the README -- run the
// migrations, deploy the manage-users function, turn off public signups,
// create the first owner by hand -- is done here through Supabase's
// Management API, authorised by a personal access token the person pastes in.
//
// That token can do anything to every project in their Supabase account, so
// it is handled as narrowly as possible: it arrives with each call, is used
// for that call, and is never written anywhere. The project's secret key is
// treated the same way -- fetched to create the owner account, then dropped.
// What is saved at the end is exactly what "Add database" would have saved:
// the project address and its publishable key.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');
const { createClient } = require('@supabase/supabase-js');
const databases = require('../config/databases');
const { describeConnectionFailure } = require('../db/errors');

const API = 'https://api.supabase.com';
const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const FUNCTION_FILE = path.join(ROOT, 'supabase', 'functions', 'manage-users', 'index.ts');
const HEALTH_SERVICES = ['db', 'auth', 'rest', 'storage'];

function tokenError(status) {
  if (status === 401) {
    return 'That access token was not accepted. Create a new one at supabase.com → Account → Access Tokens, and paste the whole thing.';
  }
  if (status === 403) return 'That access token is not allowed to change this project.';
  return null;
}

/** One Management API call. Throws with the server's own explanation when there is one. */
async function api(token, method, pathname, { json, body, headers } = {}) {
  let response;
  try {
    response = await net.fetch(API + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${String(token || '').trim()}`,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch (err) {
    throw new Error(describeConnectionFailure(err) || `Could not reach Supabase: ${err.message}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    // Not JSON; the text itself is the message, if anything is.
  }

  if (!response.ok) {
    const message =
      tokenError(response.status) ||
      (data && (data.message || data.error)) ||
      text ||
      `Supabase answered with an error (${response.status}).`;
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function runSql(token, ref, query, parameters) {
  return api(token, 'POST', `/v1/projects/${ref}/database/query`, {
    json: parameters ? { query, parameters } : { query },
  });
}

async function projectHealth(token, ref) {
  const services = await api(
    token,
    'GET',
    `/v1/projects/${ref}/health?services=${HEALTH_SERVICES.join(',')}`
  );
  const unhealthy = (services || []).filter((s) => s.status !== 'ACTIVE_HEALTHY').map((s) => s.name);
  return { healthy: unhealthy.length === 0 && (services || []).length > 0, unhealthy };
}

async function inspectProject(token, ref) {
  const project = await api(token, 'GET', `/v1/projects/${ref}`);
  if (project.status !== 'ACTIVE_HEALTHY') {
    return { ref, name: project.name, status: project.status, ready: false };
  }
  const health = await projectHealth(token, ref);
  if (!health.healthy) {
    return { ref, name: project.name, status: project.status, ready: false, unhealthy: health.unhealthy };
  }

  const rows = await runSql(
    token,
    ref,
    `select to_regclass('public.settings') is not null as set_up,
            (to_regclass('public.profiles') is not null
             and exists (select 1 from public.profiles where role = 'owner')) as has_owner`
  ).catch(async (err) => {
    // The owner check names a table that may not exist yet; asking again
    // without it tells a blank project from a genuine failure.
    const blank = await runSql(token, ref, `select to_regclass('public.settings') is not null as set_up`);
    if (blank && blank[0] && !blank[0].set_up) return [{ set_up: false, has_owner: false }];
    throw err;
  });

  const row = (rows && rows[0]) || {};
  const alreadySetUp = !!row.set_up;
  return {
    ref,
    name: project.name,
    status: project.status,
    ready: true,
    alreadySetUp,
    hasOwner: !!row.has_owner,
    pending: await pendingMigrations(token, ref, alreadySetUp),
  };
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// Records which migrations a database has had, so a later version of the app
// can tell what it still needs.
const MIGRATIONS_TABLE = `
create table if not exists public.bookbin_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
alter table public.bookbin_migrations enable row level security;
revoke all on public.bookbin_migrations from anon, authenticated;
`;

// Every migration that existed before BookBin started keeping that record. A
// database set up by hand, before setup could be done here, has no record at
// all -- but it cannot be missing any of these, because it could not have run
// without them. So they are presumed applied, and only what came after is new
// to it.
const BASELINE = [
  '20260924000001_schema.sql',
  '20260924000002_roles_and_rls.sql',
  '20260925000003_functions.sql',
  '20260925000004_incoming_invoices.sql',
  '20260925000005_costing.sql',
  '20260925000006_outgoing_invoices.sql',
  '20260925000007_purchase_orders.sql',
  '20260925000008_storage.sql',
];

/** Migration files this database has not had yet, in order. Reads only. */
async function pendingMigrations(token, ref, alreadySetUp) {
  const [row] = await runSql(
    token,
    ref,
    `select to_regclass('public.bookbin_migrations') is not null as tracked`
  );
  let applied;
  if (row && row.tracked) {
    applied = ((await runSql(token, ref, 'select name from public.bookbin_migrations')) || []).map((r) => r.name);
  } else {
    applied = alreadySetUp ? BASELINE : [];
  }
  return migrationFiles().filter((file) => !applied.includes(file));
}

async function applyMigrations(token, ref, { alreadySetUp, pending }, progress) {
  const [row] = await runSql(
    token,
    ref,
    `select to_regclass('public.bookbin_migrations') is not null as tracked`
  );
  await runSql(token, ref, MIGRATIONS_TABLE);
  if (alreadySetUp && !(row && row.tracked)) {
    for (const file of BASELINE) {
      await runSql(token, ref, 'insert into public.bookbin_migrations (name) values ($1) on conflict do nothing', [file]);
    }
  }

  const verb = alreadySetUp ? 'Updating tables' : 'Creating tables';
  for (const [index, file] of pending.entries()) {
    progress(`${verb} (${index + 1} of ${pending.length})…`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await runSql(token, ref, sql);
      await runSql(token, ref, 'insert into public.bookbin_migrations (name) values ($1) on conflict do nothing', [file]);
    } catch (err) {
      throw new Error(`${verb} failed at ${file}: ${err.message}`);
    }
  }
}

async function projectKeys(token, ref) {
  const keys = (await api(token, 'GET', `/v1/projects/${ref}/api-keys?reveal=true`)) || [];
  const find = (type, legacyName) =>
    keys.find((k) => k.type === type && k.api_key) ||
    keys.find((k) => (k.type === 'legacy' || !k.type) && k.name === legacyName && k.api_key);
  const publishable = find('publishable', 'anon');
  const secret = find('secret', 'service_role');
  if (!publishable) throw new Error('The project has no publishable key. Create one under Project Settings → API Keys, then try again.');
  if (!secret) throw new Error('The project has no secret key. Create one under Project Settings → API Keys, then try again.');
  return { publishableKey: publishable.api_key, secretKey: secret.api_key };
}

// Built by hand rather than with FormData: what net.fetch does with a FormData
// body is not something to find out halfway through setting up a database.
function multipart(parts) {
  const boundary = `----bookbin${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
      `Content-Type: ${part.type}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function deployManageUsers(token, ref) {
  // verify_jwt off: the function checks the caller itself, by asking Supabase
  // who the token belongs to and whether they are an owner. The gateway's own
  // check predates the new signing keys and can reject perfectly good tokens.
  const metadata = { entrypoint_path: 'index.ts', name: 'manage-users', verify_jwt: false };
  const { body, contentType } = multipart([
    { name: 'metadata', type: 'application/json', data: JSON.stringify(metadata) },
    { name: 'file', filename: 'index.ts', type: 'application/typescript', data: fs.readFileSync(FUNCTION_FILE) },
  ]);
  await api(token, 'POST', `/v1/projects/${ref}/functions/deploy?slug=manage-users`, {
    body,
    headers: { 'Content-Type': contentType },
  });
}

async function createOwner({ token, ref, url, secretKey, owner }) {
  const admin = createClient(url, secretKey, {
    global: { fetch: (...args) => net.fetch(...args) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const email = String(owner.email || '').trim().toLowerCase();
  const fullName = String(owner.fullName || '').trim();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: String(owner.password || ''),
    email_confirm: true,
    app_metadata: { role: 'owner' },
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (error) {
    throw new Error(/already been registered|already exists/i.test(error.message)
      ? 'An account with that email already exists in this project.'
      : `Could not create your account: ${error.message}`);
  }

  // The sign-up trigger should have written this already; writing it again
  // means an account is never left without the profile that grants access.
  await runSql(
    token,
    ref,
    `insert into public.profiles (id, email, full_name, role) values ($1, $2, $3, 'owner')
     on conflict (id) do update set role = 'owner'`,
    [data.user.id, email, fullName || null]
  );
}

module.exports = function registerSetup(ipcMain, getMainWindow) {
  function progress(message) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('setup:progress', message);
  }

  ipcMain.handle('setup:listProjects', async (_e, token) => {
    try {
      const projects = (await api(token, 'GET', '/v1/projects')) || [];
      return {
        ok: true,
        projects: projects
          .map((p) => ({ ref: p.ref, name: p.name, region: p.region, status: p.status }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('setup:inspect', async (_e, token, ref) => {
    try {
      return { ok: true, project: await inspectProject(token, ref) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Safe to re-run: on a project that already has BookBin's tables it keeps
  // everything in them, applies only the migrations it has not had, and
  // brings the function and sign-up setting up to date. That is also how an
  // existing database gets a newer version's tables and manage-users function
  // without the Supabase CLI.
  ipcMain.handle('setup:run', async (_e, { token, ref, name, owner }) => {
    try {
      progress('Checking the project…');
      const project = await inspectProject(token, ref);
      if (!project.ready) {
        throw new Error(
          project.unhealthy && project.unhealthy.length
            ? `The project is still starting up (${project.unhealthy.join(', ')} not ready). Wait a minute and try again.`
            : `The project is not running (status: ${project.status}). If it is paused, resume it from the Supabase dashboard.`
        );
      }
      if (!project.hasOwner) {
        if (!owner || !owner.email) throw new Error('Enter the email for your owner account.');
        if (String(owner.password || '').length < 8) {
          throw new Error('Your password must be at least 8 characters.');
        }
      }

      const url = `https://${ref}.supabase.co`;

      if (project.pending.length) {
        await applyMigrations(token, ref, project, progress);
      }

      progress('Reading the project keys…');
      const { publishableKey, secretKey } = await projectKeys(token, ref);

      progress('Installing the account manager…');
      await deployManageUsers(token, ref);

      // Without this, anyone who has the publishable key -- every BookBin
      // install that connects to this database -- could sign themselves up.
      progress('Turning off public sign-ups…');
      await api(token, 'PATCH', `/v1/projects/${ref}/config/auth`, { json: { disable_signup: true } });

      if (!project.hasOwner) {
        progress('Creating your owner account…');
        await createOwner({ token, ref, url, secretKey, owner });
      }

      progress('Saving the connection…');
      const existing = databases.list().find((db) => db.url === url);
      const entry = existing || databases.add({ name: name || project.name, url, publishableKey });

      return {
        ok: true,
        databaseId: entry.id,
        alreadySetUp: project.alreadySetUp,
        updatedTables: project.alreadySetUp ? project.pending.length : 0,
        createdOwner: !project.hasOwner,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
};
