// Resolves where BookBin keeps its local files: the company logo and invoice
// attachments. The database itself is no longer here -- it is in Postgres --
// so this folder no longer needs to be shared between machines, and pointing
// it at a synced folder is now a convenience rather than the way two people
// work on the same data. The chosen location is stored per-machine.
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
}

module.exports = { getWorkspaceDir, setWorkspaceDir, ensureWorkspaceDirs, logoDir, attachmentsDir };
