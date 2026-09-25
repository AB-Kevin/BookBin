#!/usr/bin/env node
// Builds the Android app's web content into mobile/www, which Capacitor copies
// into the APK (webDir in capacitor.config.json).
//
// The renderer is used as it is. What differs on Android is where window.api
// comes from: the desktop gets it from preload.js talking to the main
// process, and the phone gets mobile-api.js -- mobile/main.js bundled with
// preload.js and the ipc/*.js modules it registers, Electron and Node swapped
// for the stand-ins in mobile/shims/ (see mobile/main.js).
//
// The database a build offers on first launch comes from the same place as
// the desktop's (config/supabase.js: env vars, .env, or the generated file),
// and is baked into the bundle the way the desktop bakes it into the
// installer. It is only ever a URL and a publishable key.
//
// Usage:
//   node scripts/build-mobile.js

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { getBuiltInConfig } = require('../config/supabase');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'renderer');
const OUT = path.join(ROOT, 'mobile', 'www');
const SHIMS = path.join(ROOT, 'mobile', 'shims');
const { version } = require(path.join(ROOT, 'package.json'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SOURCE, OUT, { recursive: true });

const builtIn = getBuiltInConfig();

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'mobile', 'main.js')],
  outfile: path.join(OUT, 'mobile-api.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome111',
  alias: {
    electron: path.join(SHIMS, 'electron.js'),
    fs: path.join(SHIMS, 'fs.js'),
    crypto: path.join(SHIMS, 'crypto.js'),
    os: path.join(SHIMS, 'os.js'),
    path: 'path-browserify',
  },
  inject: [path.join(SHIMS, 'buffer-global.js')],
  define: {
    __BOOKBIN_VERSION__: JSON.stringify(version),
    // config/supabase.js looks for its .env and generated file beside itself;
    // neither exists in the bundle, and the built-in database comes in below.
    __dirname: JSON.stringify('/bookbin'),
    'process.env': JSON.stringify(builtIn
      ? { SUPABASE_URL: builtIn.url, SUPABASE_PUBLISHABLE_KEY: builtIn.publishableKey }
      : {}),
  },
  // Kept readable: this is what chrome://inspect shows when debugging.
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});

// Three changes to the page's security policy:
//   connect-src  the page talks to Supabase directly here, so it has to allow
//                requests out -- to any https host, since a database can be
//                any project.
//   script-src   Capacitor injects its native bridge into the page as an
//                inline <script>; without 'unsafe-inline' it is blocked and
//                window.Capacitor never exists.
//   img-src      the logo arrives as a data: URL (see mobile/main.js).
const indexPath = path.join(OUT, 'index.html');
let index = fs.readFileSync(indexPath, 'utf8');
const marker = '<script src="theme.js"></script>';
const csp = "default-src 'self';";
const scriptSrc = "script-src 'self';";
const imgSrc = "img-src 'self' file:";
if (![marker, csp, scriptSrc, imgSrc].every((s) => index.includes(s))) {
  throw new Error('renderer/index.html has changed shape; update scripts/build-mobile.js to match.');
}
index = index
  .replace(marker, `<script src="mobile-api.js"></script>\n  ${marker}`)
  .replace(csp, `${csp} connect-src 'self' https:;`)
  .replace(scriptSrc, "script-src 'self' 'unsafe-inline';")
  .replace(imgSrc, "img-src 'self' data:");
fs.writeFileSync(indexPath, index);

console.log(`Built mobile/www for BookBin ${version}${builtIn ? `, offering ${new URL(builtIn.url).hostname}` : ''}.`);
