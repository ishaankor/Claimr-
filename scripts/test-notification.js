import { sendNotification } from '../src/notify.js';

console.log('🚀 Dispatching test notification...');
sendNotification(
  'Claimr Test 🎮',
  'Desktop notification is working properly!'
);
console.log('✅ Notification dispatched.');
