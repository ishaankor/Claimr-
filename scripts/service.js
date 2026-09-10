import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const SERVICE_LABEL = 'com.user.epic-game-claimer';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);
const LOG_FILE = path.join(ROOT_DIR, 'service.log');
const ERR_LOG_FILE = path.join(ROOT_DIR, 'service-error.log');

function resolveNodePath() {
  if (process.execPath && !process.execPath.toLowerCase().includes('electron')) {
    return process.execPath;
  }
  try {
    const n = execSync('which node', { encoding: 'utf-8' }).trim();
    if (n && fs.existsSync(n)) return n;
  } catch {}
  const home = os.homedir();
  const candidates = [
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : null,
    home ? path.join(home, '.nvm/versions/node', process.version, 'bin/node') : null,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean);

  if (home && fs.existsSync(path.join(home, '.nvm/versions/node'))) {
    try {
      const versions = fs.readdirSync(path.join(home, '.nvm/versions/node')).reverse();
      for (const v of versions) {
        candidates.push(path.join(home, '.nvm/versions/node', v, 'bin', 'node'));
      }
    } catch {}
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node';
}

const nodePath = resolveNodePath();
const scriptPath = path.join(ROOT_DIR, 'index.js');
const pathEnv = `${path.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

function generatePlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>--headless</string>
        <string>--all-accounts</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathEnv}</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>

    <!-- Run every 2 hours (7200 seconds) so missed drops or flash giveaways are automatically caught -->
    <key>StartInterval</key>
    <integer>7200</integer>

    <!-- Also explicitly trigger at 11:15 AM (covers Thursday drops) and 8:15 PM -->
    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Hour</key>
            <integer>11</integer>
            <key>Minute</key>
            <integer>15</integer>
        </dict>
        <dict>
            <key>Hour</key>
            <integer>20</integer>
            <key>Minute</key>
            <integer>15</integer>
        </dict>
    </array>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>

    <key>StandardErrorPath</key>
    <string>${ERR_LOG_FILE}</string>
</dict>
</plist>
`;
}

const action = process.argv[2] || 'install';

switch (action) {
  case 'install': {
    console.log(`📦 Setting up macOS background service (${SERVICE_LABEL})...`);

    if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
      fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    }

    // If previously loaded, unload first
    try {
      execSync(`launchctl bootout gui/$(id -u)/${SERVICE_LABEL} 2>/dev/null || true`);
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    } catch {}

    const plistContent = generatePlist();
    fs.writeFileSync(PLIST_PATH, plistContent, 'utf-8');
    console.log(`✅ Created LaunchAgent at: ${PLIST_PATH}`);

    try {
      try {
        execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}" 2>/dev/null`);
      } catch {
        execSync(`launchctl load -w "${PLIST_PATH}"`);
      }
      console.log(`🚀 Service loaded into macOS launchd!`);
      console.log(`📅 Schedule: Runs automatically every day at 11:15 AM & 8:15 PM.`);
      console.log(`📝 Log file: ${LOG_FILE}`);
      console.log(`\n🎉 You are all set! Games will now be claimed silently in the background.`);
    } catch (err) {
      console.error(`❌ Failed to load service into launchd:`, err.message);
    }
    break;
  }

  case 'uninstall': {
    console.log(`🛑 Removing background service (${SERVICE_LABEL})...`);
    try {
      execSync(`launchctl bootout gui/$(id -u)/${SERVICE_LABEL} 2>/dev/null || true`);
    } catch {}
    try {
      if (fs.existsSync(PLIST_PATH)) {
        execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
      }
    } catch {}

    if (fs.existsSync(PLIST_PATH)) {
      fs.unlinkSync(PLIST_PATH);
      console.log(`🗑️ Removed plist file: ${PLIST_PATH}`);
    }
    console.log(`✅ Background service successfully uninstalled.`);
    break;
  }

  case 'status': {
    try {
      const output = execSync(`launchctl list | grep "${SERVICE_LABEL}" || true`).toString().trim();
      if (output) {
        console.log(`✅ Background service is ACTIVE:`);
        console.log(`   ${output}`);
        console.log(`   Plist: ${PLIST_PATH}`);
        console.log(`   Logs:  ${LOG_FILE}`);
      } else {
        console.log(`ℹ️ Background service is NOT currently loaded.`);
      }
    } catch (err) {
      console.error(`Error checking status:`, err.message);
    }
    break;
  }

  case 'run': {
    console.log(`⚡ Triggering immediate background run...`);
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}`);
      console.log(`✅ Triggered. Check logs with 'npm run service:logs'.`);
    } catch (err) {
      console.error(`Failed to start service:`, err.message);
    }
    break;
  }

  case 'logs': {
    if (fs.existsSync(LOG_FILE)) {
      console.log(`--- ${LOG_FILE} (last 30 lines) ---`);
      const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
      console.log(lines.slice(-30).join('\n'));
    } else {
      console.log(`No log file found yet at ${LOG_FILE}`);
    }
    break;
  }

  default:
    console.log(`Usage: node scripts/service.js [install|uninstall|status|run|logs]`);
}
