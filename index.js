import { getPromotions } from './src/api.js';
import { loadHistory, isGameClaimed } from './src/history.js';
import { launchBrowser, ensureLoggedIn, claimGame } from './src/claimer.js';
import { claimGog, loginGog } from './src/gog.js';
import { getActiveAccount, loadAccounts, getFullProfileDir } from './src/accounts.js';
import { sendNotification } from './src/notify.js';

const args = process.argv.slice(2);
const isCheckOnly = args.includes('--check') || args.includes('-c');
const isEpicLoginOnly = args.includes('--login') || args.includes('--login:epic') || args.includes('-l');
const isGogLoginOnly = args.includes('--login:gog');
const isHeadless = args.includes('--headless');
const isForce = args.includes('--force') || args.includes('-f');
const isEpicOnly = args.includes('--epic-only');
const isGogOnly = args.includes('--gog-only');
const isAllAccounts = args.includes('--all-accounts') || isHeadless;

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

  const newlyClaimed = [];

  // 3. Process Epic Games Claims (Multi-Account)
  if (!isGogOnly && currentFreeGames.length > 0) {
    const accountsData = loadAccounts();
    const epicAccounts = isAllAccounts && accountsData.epic?.accounts?.length > 0
      ? accountsData.epic.accounts
      : [getActiveAccount('epic')].filter(Boolean);

    for (const account of epicAccounts) {
      const history = loadHistory();
      const unclaimed = currentFreeGames.filter(g => isForce || !isGameClaimed(history, g, account.id));
      if (unclaimed.length === 0) {
        console.log(`\n✅ All current Epic promotions already claimed/owned for ${account.username || account.id}.`);
        continue;
      }

      console.log(`\n🚀 Starting Epic claiming session for: ${account.username || account.id}...`);
      const profileDir = getFullProfileDir(account.profileDir, 'epic');
      const context = await launchBrowser({ headless: isHeadless, profileDir });
      const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

      try {
        const loggedIn = await ensureLoggedIn(page, { interactive: !isHeadless });
        if (!loggedIn) {
          console.error(`\n❌ Authentication required for ${account.username || account.id}. Skipping.`);
        } else {
          for (const game of unclaimed) {
            const res = await claimGame(page, game, loadHistory(), {
              force: isForce,
              accountId: account.id,
              username: account.username,
            });
            if (res && res.status === 'claimed') {
              newlyClaimed.push(`${game.title} (${account.username || account.id})`);
            }
          }
        }
      } catch (err) {
        console.error(`❌ Epic claimer error for ${account.username || account.id}:`, err.message);
      } finally {
        await context.close();
      }
    }
  }

  // 4. Process GOG Claims (Multi-Account)
  if (!isEpicOnly) {
    const accountsData = loadAccounts();
    const gogAccounts = isAllAccounts && accountsData.gog?.accounts?.length > 0
      ? accountsData.gog.accounts
      : [getActiveAccount('gog')].filter(Boolean);

    for (const account of gogAccounts) {
      try {
        console.log(`\n👾 Starting GOG claiming check for: ${account.username || account.id}...`);
        const gogRes = await claimGog({
          headless: isHeadless,
          accountId: account.id,
          username: account.username,
          profileDir: getFullProfileDir(account.profileDir, 'gog'),
        });
        if (gogRes && gogRes.status === 'claimed') {
          newlyClaimed.push(`${gogRes.title} (${account.username || 'GOG'})`);
        }
      } catch (err) {
        console.error(`❌ GOG claimer error for ${account.username || account.id}:`, err.message);
      }
    }
  }

  console.log('\n✨ All store checks completed!');

  // 5. Native OS notification on completion in headless/scheduled mode
  if (isHeadless || isAllAccounts) {
    if (newlyClaimed.length > 0) {
      sendNotification(
        'Claimr - Free Games Claimed! 🎁',
        `Successfully claimed: ${newlyClaimed.join(', ')}`
      );
    } else if (currentFreeGames.length > 0) {
      const titles = currentFreeGames.map(g => g.title).join(' & ');
      sendNotification(
        'Claimr - Library Verified ✅',
        `All active offers (${titles}) are verified in your library!`
      );
    }
  }
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
