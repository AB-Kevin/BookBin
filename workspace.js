// Resolves where BookBin's data lives on disk. Defaults to the app's normal
// per-machine userData folder, but a user can point this at a synced folder
// (e.g. OneDrive) instead so multiple devices can share the same database and
// logo. The chosen location is itself stored per-machine (in userData), since
// each device needs to be told separately where the shared folder is.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

function getWorkspaceDir() {
  const config = readConfig();
  return config.workspaceDir || app.getPath('userData');
}

function setWorkspaceDir(dir) {
  writeConfig({ ...readConfig(), workspaceDir: dir });
}

function logoDir(workspaceDir) {
  return path.join(workspaceDir, 'logo');
}

// Rolling snapshots of the database, written on launch by whichever device
// holds the write lock. They live inside the workspace so they travel through
// the same folder sync as the database — the whole point is to have a clean,
// self-consistent copy to fall back on if a sync leaves bookbin.db damaged or
// missing a device's work.
function backupsDir(workspaceDir) {
  return path.join(workspaceDir, 'backups');
}

// kind is 'incoming' or 'outgoing' — kept in separate folders since both
// invoice tables have their own id sequence and would otherwise collide.
function attachmentsDir(workspaceDir, kind) {
  return path.join(workspaceDir, 'attachments', kind);
}

function ensureWorkspaceDirs(workspaceDir) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(logoDir(workspaceDir), { recursive: true });
  fs.mkdirSync(attachmentsDir(workspaceDir, 'incoming'), { recursive: true });
  fs.mkdirSync(attachmentsDir(workspaceDir, 'outgoing'), { recursive: true });
  fs.mkdirSync(backupsDir(workspaceDir), { recursive: true });
}

module.exports = { getWorkspaceDir, setWorkspaceDir, ensureWorkspaceDirs, logoDir, attachmentsDir, backupsDir };
