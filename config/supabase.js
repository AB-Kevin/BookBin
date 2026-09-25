// The Supabase project URL and anon key this build was made with, if any.
//
// These are not secret in the cryptographic sense -- the anon key is designed
// to be held by clients, and it necessarily ships inside the packaged app
// where any user can read it. What keeps the data safe is row-level security
// in the database, not the secrecy of this key. It is kept out of the public
// repo only so scrapers do not find the project URL and probe it.
//
// Resolution order:
//   1. process.env                -- CI builds, and anyone who prefers to
//                                    export the vars in their shell.
//   2. .env at the repo root      -- ordinary development. Gitignored.
//   3. supabase.generated.json    -- packaged builds. Written next to this
//                                    file by scripts/write-supabase-config.js
//                                    during `npm run dist`, and bundled into
//                                    the app. Also gitignored.
//
// A packaged build has no .env and no environment, which is exactly why step
// 3 exists; a dev run has no generated file, which is why steps 1 and 2 do.
//
// Whatever is found here seeds the database list on first launch and nothing
// more: see config/databases.js.
//
// SUPABASE_PUBLISHABLE_KEY is the current name; SUPABASE_ANON_KEY is accepted
// as an alias because Supabase is mid-migration from the legacy anon JWT to
// sb_publishable_ keys, and which one a dashboard shows depends on when the
// project was created. Both are client-safe and both are governed by RLS.

const fs = require('fs');
const path = require('path');

const GENERATED_FILE = path.join(__dirname, 'supabase.generated.json');

/**
 * Reduces whatever was supplied to the project's origin.
 *
 * The Supabase dashboard shows several addresses on one page, and the REST
 * endpoint -- https://<ref>.supabase.co/rest/v1 -- looks like as plausible a
 * "project URL" as the bare origin does. Supplying it makes every request go
 * to /rest/v1/auth/v1/... and the app fails at the login screen with
 * "Invalid path specified in request URL", which says nothing about the cause.
 *
 * Dropping the path here means any of those addresses works.
 */
function normalizeUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch (err) {
    // Not a parseable URL at all; leave it to the caller's validation, minus
    // any trailing slashes.
    return trimmed.replace(/\/+$/, '');
  }
}

const ENV_FILE = path.join(__dirname, '..', '.env');

// Small hand-rolled parser rather than a dotenv dependency: the file has at
// most a few KEY=value lines and this avoids shipping a package to read them.
function readEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {};
  }

  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Tolerate quoted values; people paste them both ways.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value[0] === value[value.length - 1]) value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

function readGeneratedFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {};
  }
}

// Supabase has issued keys in two shapes: the newer sb_publishable_ /
// sb_secret_ prefixes, and older JWTs carrying a "role" claim. Check both.
// A secret key ignores every row-level security policy, so it must never be
// saved on a machine or baked into a build -- and it sits directly below the
// publishable key on the dashboard, which makes it an easy one to grab.
function looksLikeSecretKey(key) {
  const value = String(key || '').trim();
  if (value.startsWith('sb_secret_')) return true;

  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.role === 'service_role';
  } catch (err) {
    return false;
  }
}

/**
 * The database this build was made for, as { url, publishableKey }, or null
 * when there is none.
 *
 * It is no longer the only database the app can use -- just the one offered
 * on first launch, so an existing install keeps working without anybody
 * typing an address. A build without one is perfectly usable; the database
 * list simply starts empty.
 */
function getBuiltInConfig() {
  const fromEnvFile = readEnvFile(ENV_FILE);
  const fromGenerated = readGeneratedFile(GENERATED_FILE);

  const pick = (name) =>
    process.env[name] || fromEnvFile[name] || '';

  const url = normalizeUrl(pick('SUPABASE_URL') || fromGenerated.url || '');
  const publishableKey =
    pick('SUPABASE_PUBLISHABLE_KEY') ||
    pick('SUPABASE_ANON_KEY') ||
    fromGenerated.publishableKey || '';

  if (!url || !publishableKey || looksLikeSecretKey(publishableKey)) return null;
  return { url, publishableKey };
}

module.exports = { getBuiltInConfig, normalizeUrl, looksLikeSecretKey, GENERATED_FILE };
