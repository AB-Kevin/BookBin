# BookBin

A small local-only desktop app for recording incoming (purchase) invoices,
tracking inventory off of them, and producing outgoing (sales) invoices as
PDFs. Built with Electron + SQLite, no external services, no accounts, no
subscription.

## Setup

```
npm install
npm start
```

Your data lives in a single SQLite file at:

```
%APPDATA%\bookbin\bookbin.db
```

(created automatically on first launch). Back it up by copying that file.

### If `npm install` fails to build the SQLite native module

`better-sqlite3` is a native module and needs to match Electron's Node ABI,
not your system Node's. If `npm start` errors on launch (or `npm install`
complains about `node-gyp`/Python), run:

```
npm install --save-dev @electron/rebuild
npx electron-rebuild -f -w better-sqlite3
```

That pulls a prebuilt binary for Electron's ABI instead of compiling from
source, so you don't need Python or Visual Studio Build Tools installed.

## What it does

- **Items** — your catalog. Items can be marked "inventory" (stock is
  tracked) or "non-inventory" (e.g. Shipping, a misc fee) — non-inventory
  items appear on invoices but never affect stock counts. Each item also has
  a manual "Adjust Stock" action (for physical-count corrections) and a
  full history of every quantity change.
- **Vendors / Customers** — simple contact records.
- **Incoming Invoices** — record what you bought. Saving one automatically
  adds each inventory line's quantity to on-hand stock. Editing or deleting
  an invoice correctly reverses its old stock effect first.
- **Outgoing Invoices** — record what you sold. Saving one automatically
  subtracts stock the same way. Each saved outgoing invoice has an
  **Export PDF** button that renders a styled invoice and lets you save it
  anywhere via the normal Save dialog.
- **Dashboard** — low-stock warnings plus your most recent invoices of each
  kind.
- **Settings** — your company name/address (shown on PDF invoices),
  invoice number prefixes/counters, and the low-stock threshold.

## Releasing (both platforms, from either OS)

Releases are automated via [.github/workflows/release.yml](.github/workflows/release.yml).
Bump the version, commit, and push the tag `npm version` creates:

```
npm version patch   # or: minor / major
git push --follow-tags
```

GitHub Actions then builds the Windows `.exe` (on a Windows runner) and the
Mac `.dmg`/`.zip` (on a macOS runner) and publishes both to the GitHub Release
for that tag — no local Mac needed, this can be run entirely from Windows.

## Project layout

```
main.js               Electron entry point, wires up IPC handlers
preload.js             contextBridge surface exposed to the renderer as window.api
db/                    SQLite schema + connection setup
ipc/                   One module per domain (items, vendors, customers,
                        incoming/outgoing invoices, settings, dashboard) —
                        all DB access happens here, in the main process
renderer/              Plain HTML/CSS/JS UI, no framework, no build step
  screens/             One file per screen
  invoice-template.js  Builds the printable invoice HTML (shared by PDF export)
```

No bundler, no framework — every renderer file is loaded directly as a
`<script>` tag from `index.html`, so you can open any screen file and edit
it directly.
