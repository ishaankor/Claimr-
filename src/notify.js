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

  // 2. On macOS: route notification through Claimr's bundle ID ("com.claimr.app")
  // so macOS attaches Claimr's official app icon instead of the generic Script Editor scroll!
  if (process.platform === 'darwin') {
    const escapedMsg = safeMessage.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedTitle = safeTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `try
      tell application id "com.claimr.app" to display notification "${escapedMsg}" with title "${escapedTitle}" sound name "default"
    on error
      display notification "${escapedMsg}" with title "${escapedTitle}" sound name "default"
    end try`;
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

