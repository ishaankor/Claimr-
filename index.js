import { getPromotions } from './src/api.js';
import { loadHistory } from './src/history.js';
import { launchBrowser, ensureLoggedIn, claimGame } from './src/claimer.js';
import { claimGog, loginGog } from './src/gog.js';
import { getActiveAccount } from './src/accounts.js';

const args = process.argv.slice(2);
const isCheckOnly = args.includes('--check') || args.includes('-c');
const isEpicLoginOnly = args.includes('--login') || args.includes('--login:epic') || args.includes('-l');
const isGogLoginOnly = args.includes('--login:gog');
const isHeadless = args.includes('--headless');
const isForce = args.includes('--force') || args.includes('-f');
const isEpicOnly = args.includes('--epic-only');
const isGogOnly = args.includes('--gog-only');

const intervalArgIndex = args.indexOf('--interval');
const intervalHours = intervalArgIndex !== -1 ? parseFloat(args[intervalArgIndex + 1]) : null;

function printHeader() {
  console.log(`
┌─────────────────────────────────────────────────────────┐
│              FREE GAME CLAIMER (EPIC & GOG)             │
│              Multi-Store Automated Freebie Agent        │
└─────────────────────────────────────────────────────────┘
`);
}

async function displayPromotions() {
  console.log('📡 Fetching active promotions from Epic Games...');
  const { currentFreeGames, upcomingFreeGames } = await getPromotions();

  console.log(`\n🎁 [EPIC] CURRENTLY FREE GAMES (${currentFreeGames.length}):`);
  if (currentFreeGames.length === 0) {
    console.log('  No free promotions active at this moment.');
  } else {
    currentFreeGames.forEach((g, i) => {
      console.log(`  ${i + 1}. ${g.title}`);
      console.log(`     URL: ${g.storeUrl || 'N/A'}`);
      console.log(`     Ends: ${new Date(g.endDate).toLocaleString()}`);
    });
  }

  console.log(`\n⏳ [EPIC] UPCOMING FREE GAMES (${upcomingFreeGames.length}):`);
  if (upcomingFreeGames.length === 0) {
    console.log('  No upcoming promotions announced yet.');
  } else {
    upcomingFreeGames.forEach((g, i) => {
      console.log(`  ${i + 1}. ${g.title}`);
      console.log(`     URL: ${g.storeUrl || 'N/A'}`);
      console.log(`     Starts: ${new Date(g.startDate).toLocaleString()}`);
    });
  }

  return { currentFreeGames, upcomingFreeGames };
}

async function runClaimer() {
  printHeader();

  // 1. Handle Login-only requests
  if (isEpicLoginOnly) {
    console.log('\n🚀 Starting Epic Games browser login session...');
    const context = await launchBrowser({ headless: false });
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    try {
      const ok = await ensureLoggedIn(page, { interactive: true });
      if (ok) console.log('✅ Epic Games session verified and saved!');
    } finally {
      await context.close();
    }
    return;
  }

  if (isGogLoginOnly) {
    await loginGog();
    return;
  }

  // 2. Fetch Epic Promotions
  let currentFreeGames = [];
  if (!isGogOnly) {
    const promo = await displayPromotions();
    currentFreeGames = promo.currentFreeGames;
  }

  if (isCheckOnly) {
    console.log('\n✨ Check completed. Exiting.');
    return;
  }

  // 3. Process Epic Games Claims
  if (!isGogOnly && currentFreeGames.length > 0) {
    console.log('\n🚀 Starting Epic Games claiming session...');
    const context = await launchBrowser({ headless: isHeadless });
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
      const loggedIn = await ensureLoggedIn(page, { interactive: !isHeadless });
      if (!loggedIn) {
        console.error('\n❌ Authentication required for Epic. Run `npm run login:epic` to sign in.');
      } else {
        const history = loadHistory();
        const activeEpic = getActiveAccount('epic');
        console.log(`👤 Active Epic Account: ${activeEpic?.username || 'Default'} (${activeEpic?.id || 'default'})`);
        for (const game of currentFreeGames) {
          await claimGame(page, game, history, {
            force: isForce,
            accountId: activeEpic?.id || 'default',
            username: activeEpic?.username,
          });
        }
      }
    } catch (err) {
      console.error('❌ Epic claimer error:', err.message);
    } finally {
      await context.close();
    }
  }

  // 4. Process GOG Claims
  if (!isEpicOnly) {
    try {
      const activeGog = getActiveAccount('gog');
      console.log(`👤 Active GOG Account: ${activeGog?.username || 'Default'} (${activeGog?.id || 'default'})`);
      await claimGog({
        headless: isHeadless,
        accountId: activeGog?.id || 'default',
        username: activeGog?.username,
      });
    } catch (err) {
      console.error('❌ GOG claimer error:', err.message);
    }
  }

  console.log('\n✨ All store checks completed!');
}

async function main() {
  if (intervalHours && intervalHours > 0) {
    console.log(`⏰ Scheduler mode active: Checking every ${intervalHours} hours.`);
    await runClaimer();
    setInterval(async () => {
      console.log(`\n⏰ [${new Date().toLocaleTimeString()}] Scheduled check triggered...`);
      await runClaimer();
    }, intervalHours * 60 * 60 * 1000);
  } else {
    await runClaimer();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
