import path from 'path';
import { exec } from 'child_process';
import { CONFIG } from './config.js';

let customNotifier = null;

export function setCustomNotifier(fn) {
  customNotifier = fn;
}

export function sendNotification(title, message) {
  // 1. If Electron has registered its native notification handler
  if (typeof customNotifier === 'function') {
    try {
      customNotifier(title, message);
      return;
    } catch (e) {
      console.warn('Custom notification notice:', e.message);
    }
  }

  // 2. Fallback for non-Electron macOS
  if (process.platform === 'darwin') {
    const safeTitle = String(title).replace(/["\\]/g, '\\$&');
    const safeMessage = String(message).replace(/["\\]/g, '\\$&');
    exec(`osascript -e 'display notification "${safeMessage}" with title "${safeTitle}"'`, () => {});
    return;
  }

  // 3. Fallback for Linux
  if (process.platform === 'linux') {
    const iconPath = path.join(CONFIG.ROOT_DIR, 'assets', 'icon.png');
    const safeTitle = String(title).replace(/["\\]/g, '\\$&');
    const safeMessage = String(message).replace(/["\\]/g, '\\$&');
    exec(`notify-send -i "${iconPath}" "${safeTitle}" "${safeMessage}"`, () => {});
  }
}

