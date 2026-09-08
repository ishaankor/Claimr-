import { exec } from 'child_process';

export function sendNotification(title, message) {
  const safeTitle = String(title).replace(/["\\]/g, '\\$&');
  const safeMessage = String(message).replace(/["\\]/g, '\\$&');
  const script = `display notification "${safeMessage}" with title "${safeTitle}"`;

  exec(`osascript -e '${script}'`, () => {});
}
