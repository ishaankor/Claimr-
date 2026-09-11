import path from 'path';
import { execFile } from 'child_process';
import { CONFIG } from './config.js';

let customNotifier = null;

export function setCustomNotifier(fn) {
  customNotifier = fn;
}

export function sendNotification(title, message) {
  const safeTitle = String(title || 'Claimr');
  const safeMessage = String(message || '');

  // 1. If Electron has registered its native notification handler, invoke it
  if (typeof customNotifier === 'function') {
    try {
      customNotifier(safeTitle, safeMessage);
      return;
    } catch (e) {
      console.warn('Custom notification notice:', e.message);
    }
  }

  // 2. Headless CLI / LaunchAgent fallback on macOS when Electron is not running
  if (process.platform === 'darwin') {
    execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
    const escapedMsg = safeMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedTitle = safeTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${escapedMsg}" with title "${escapedTitle}" sound name "default"`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) console.warn('macOS notification warning:', err.message);
    });
    return;
  }

  // 3. Fallback for Linux
  if (process.platform === 'linux') {
    const iconPath = path.join(CONFIG.ROOT_DIR, 'assets', 'icon.png');
    execFile('notify-send', ['-i', iconPath, safeTitle, safeMessage], () => {});
  }
}

