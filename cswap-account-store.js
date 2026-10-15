// Thin adapter over claude-swap (cswap): reads its roster + stored credentials and
// performs switches through the cswap CLI, so the live credential write uses cswap's locks/format.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFileSync } = require('child_process');

// Mirrors cswap's paths.get_backup_root(): XDG data dir on Linux/WSL, legacy ~/.claude-swap-backup elsewhere
function defaultBackupDir() {
  if (process.platform === 'linux') {
    const xdg = (process.env.XDG_DATA_HOME || '').replace(/^~(?=$|\/)/, os.homedir());
    return path.isAbsolute(xdg) ? path.join(xdg, 'claude-swap') : path.join(os.homedir(), '.local', 'share', 'claude-swap');
  }
  return path.join(os.homedir(), '.claude-swap-backup');
}

const BACKUP_DIR = process.env.CSWAP_BACKUP_DIR || defaultBackupDir();
const CSWAP_BIN = process.env.CSWAP_BIN || 'cswap';

function readRoster() {
  const seq = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'sequence.json'), 'utf8'));
  return { active: seq.activeAccountNumber, order: seq.sequence || [], accounts: seq.accounts || {} };
}

// cswap's macOS backup store: Keychain generic password, service "claude-swap", account "account-<n>-<email>"
const MACOS_KEYCHAIN_SERVICE = 'claude-swap';

function readMacKeychainBackup(num, email) {
  try {
    // Same `security` binary cswap writes with, so the item's ACL allows the read without a prompt
    const out = execFileSync('/usr/bin/security',
      ['find-generic-password', '-a', `account-${num}-${email}`, '-w', '-s', MACOS_KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.replace(/\n$/, ''));
  } catch {
    return null; // not found (rc 44), locked keychain, or malformed
  }
}

// Stored credential blob for a slot. Same lookup order as cswap: a base64 JSON `.enc` file wins
// (the only store on Windows/Linux, a fallback on macOS), then the macOS Keychain.
function readSlotCredentials(num, email) {
  const file = path.join(BACKUP_DIR, 'credentials', `.creds-${num}-${email}.enc`);
  try {
    return JSON.parse(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64').toString('utf8'));
  } catch {
    return process.platform === 'darwin' ? readMacKeychainBackup(num, email) : null;
  }
}

// Long-lived setup-token slots: OAuth access token with no refresh token (see cswap add-token)
function listSetupTokenSlots() {
  const roster = readRoster();
  const slots = [];
  for (const num of roster.order) {
    const meta = roster.accounts[String(num)];
    if (!meta || meta.disabled) continue;
    const oauth = readSlotCredentials(num, meta.email)?.claudeAiOauth;
    if (!oauth?.accessToken || oauth.refreshToken) continue;
    slots.push({ num: Number(num), email: meta.email, token: oauth.accessToken });
  }
  return { active: roster.active, slots };
}

function switchTo(num) {
  return new Promise((resolve, reject) => {
    // num is a validated integer, so the command string is safe; exec resolves .exe/.cmd shims on Windows
    exec(`"${CSWAP_BIN}" switch ${Number(num)} --json`, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`cswap switch ${num} failed: ${(stderr || stdout || err.message).trim()}`));
      resolve(stdout.trim());
    });
  });
}

module.exports = { listSetupTokenSlots, switchTo, BACKUP_DIR };
