// Resolves the Supabase project URL and anon key.
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
// SUPABASE_PUBLISHABLE_KEY is the current name; SUPABASE_ANON_KEY is accepted
// as an alias because Supabase is mid-migration from the legacy anon JWT to
// sb_publishable_ keys, and which one a dashboard shows depends on when the
// project was created. Both are client-safe and both are governed by RLS.

const fs = require('fs');
const path = require('path');

const GENERATED_FILE = path.join(__dirname, 'supabase.generated.json');
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

let cached = null;

/**
 * Returns { url, publishableKey }, or throws with an explanation of how to fix it.
 * Throwing beats returning nulls here: a missing key surfaces at startup as
 * one clear message rather than as a confusing auth failure later on.
 */
function getSupabaseConfig() {
  if (cached) return cached;

  const fromEnvFile = readEnvFile(ENV_FILE);
  const fromGenerated = readGeneratedFile(GENERATED_FILE);

  const pick = (name) =>
    process.env[name] || fromEnvFile[name] || '';

  const url = pick('SUPABASE_URL') || fromGenerated.url || '';
  const publishableKey =
    pick('SUPABASE_PUBLISHABLE_KEY') ||
    pick('SUPABASE_ANON_KEY') ||
    fromGenerated.publishableKey || '';

  if (!url || !publishableKey) {
    const missing = [!url && 'SUPABASE_URL', !publishableKey && 'SUPABASE_PUBLISHABLE_KEY']
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `BookBin is not configured: ${missing} missing.\n` +
      'For development, copy .env.example to .env and fill in the values from\n' +
      'your Supabase dashboard (Settings -> API). For a packaged build, set the\n' +
      'same variables in the environment before running npm run dist.'
    );
  }

  cached = { url, publishableKey };
  return cached;
}

module.exports = { getSupabaseConfig, GENERATED_FILE };
