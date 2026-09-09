import { chromium } from 'playwright';
import { CONFIG } from './config.js';
import { isGameClaimed, recordClaim, loadHistory } from './history.js';
import { sendNotification } from './notify.js';
import { getActiveProfileDir, createNewProfileDir, registerAccount } from './accounts.js';
import { launchBrowserContext, handleCloudflareTurnstile } from './browser.js';
import { getPromotions } from './api.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initializes the Playwright browser context using a persistent profile directory.
 */
export async function launchBrowser({ headless = false, profileDir, log } = {}) {
  const targetDir = profileDir || getActiveProfileDir('epic');
  const context = await launchBrowserContext(targetDir, {
    headless,
    viewport: { width: 1366, height: 850 },
    locale: CONFIG.LOCALE,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  }, log);

  // Pre-seed cookies to bypass consent and mature age verification modals
  await context.addCookies([
    {
      name: 'OptanonAlertBoxClosed',
      value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      domain: '.epicgames.com',
      path: '/',
    },
    {
      name: 'HasAcceptedAgeGates',
      value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18',
      domain: 'store.epicgames.com',
      path: '/',
    },
  ]);

  return context;
}

/**
 * Verifies whether the user is currently signed in.
 */
export async function ensureLoggedIn(page, { interactive = true, logger = console.log } = {}) {
  logger('🔍 Checking Epic Games login status...');
  await page.goto(`${CONFIG.EPIC_STORE_URL}/${CONFIG.LOCALE}/free-games`, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.DEFAULT_TIMEOUT,
  });

  const checkIsLoggedIn = async () => {
    try {
      const cookies = await page.context().cookies();
      const hasAuthCookie = cookies.some((c) =>
        c.name === 'EPIC_BEARER_TOKEN' ||
        c.name === 'EPIC_SSO' ||
        c.name === 'EPIC_EG1' ||
        c.name === 'EPIC_SESSION_AP'
      );
      if (!hasAuthCookie) return false;

      const nav = page.locator('egs-navigation');
      if (await nav.count() > 0) {
        const loggedInAttr = await nav.getAttribute('isloggedin');
        if (loggedInAttr === 'true') return true;
      }
      return true;
    } catch {
      return false;
    }
  };

  // Poll for login status up to 10 seconds to allow egs-navigation to hydrate
  let loggedIn = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    loggedIn = await checkIsLoggedIn();
    if (loggedIn) break;
  }

  if (loggedIn) {
    logger('✅ Successfully authenticated with Epic Games!');
    return true;
  }

  if (!interactive) {
    logger('❌ Not logged into Epic Games.');
    return false;
  }

  logger('\n🔑 You are not logged in. Opening Epic Games login page...');
  logger('👉 Please complete the login in the opened browser window.');
  logger('⏳ Waiting for you to log in (up to 3 minutes)...\n');

  await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const start = Date.now();
  const maxWaitMs = 180000;

  while (Date.now() - start < maxWaitMs) {
    await sleep(2000);

    loggedIn = await checkIsLoggedIn();
    if (loggedIn) {
      logger('🎉 Login detected! Profile session saved.');
      return true;
    }
    if (page.url().includes('store.epicgames.com') && !page.url().includes('/login')) {
      loggedIn = await checkIsLoggedIn();
      if (loggedIn) {
        logger('🎉 Login detected! Profile session saved.');
        return true;
      }
    }
  }

  logger('❌ Login timed out. Please try again.');
  return false;
}

/**
 * Handles any interstitial dialogs (mature content, device warnings, EULA).
 */
async function handleDialogs(page, logger = console.log) {
  try {
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("CONTINUE")');
    if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
      logger('   Handling confirmation modal (Continue)...');
      await continueBtn.first().click({ delay: 50 });
      await sleep(1500);
    }

    const yesBtn = page.locator('button:has-text("Yes, buy now"), button:has-text("YES, BUY NOW")');
    if (await yesBtn.count() > 0 && await yesBtn.first().isVisible()) {
      await yesBtn.first().click({ delay: 50 });
      await sleep(1000);
    }

    const eulaCheck = page.locator('input#agree');
    if (await eulaCheck.count() > 0 && await eulaCheck.isVisible()) {
      logger('   Accepting EULA...');
      await eulaCheck.check();
      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("ACCEPT")');
      if (await acceptBtn.count() > 0) {
        await acceptBtn.click({ delay: 50 });
        await sleep(1500);
      }
    }

    for (const frame of page.frames()) {
      const frameContinue = frame.locator('button:has-text("Continue"), button:has-text("CONTINUE")');
      if (await frameContinue.count() > 0 && await frameContinue.first().isVisible()) {
        logger('   Handling confirmation modal in frame (Continue)...');
        await frameContinue.first().click({ delay: 50 });
        await sleep(1500);
      }
    }
  } catch {}
}

/**
 * Completes the checkout screen by finding and clicking "Add to library" or "Place Order".
 */
async function completeCheckout(page, logger = console.log) {
  logger('⏳ Waiting for checkout screen to load...');

  const candidateSelectors = [
    'button:has-text("Add to library")',
    'button:has-text("Add to Library")',
    'button:has-text("Place Order")',
    'button:has-text("Place order")',
    'button:has-text("PLACE ORDER")',
    'button.payment-btn--primary',
  ];

  const maxAttempts = 35;
  for (let i = 0; i < maxAttempts; i++) {
    // 1. Handle any dialogs ("Device not supported", mature content, EULA) that block checkout
    await handleDialogs(page, logger);

    // 2. Check main page for checkout button
    for (const sel of candidateSelectors) {
      try {
        const btn = page.locator(sel);
        if (await btn.count() > 0 && await btn.first().isVisible()) {
          const text = (await btn.first().innerText()).trim();
          logger(`👉 Found button "${text}" on checkout overlay. Clicking...`);
          await btn.first().click({ delay: 50 });
          return true;
        }
      } catch {}
    }

    // 3. Check all iframes for checkout button
    for (const frame of page.frames()) {
      for (const sel of candidateSelectors) {
        try {
          const btn = frame.locator(sel);
          if (await btn.count() > 0 && await btn.first().isVisible()) {
            const text = (await btn.first().innerText()).trim();
            logger(`👉 Found button "${text}" in checkout frame. Clicking...`);
            await btn.first().click({ delay: 50 });
            return true;
          }
        } catch {}
      }
    }

    try {
      const euAgree = page.locator('button:has-text("I Accept"), button:has-text("I Agree")');
      if (await euAgree.count() > 0 && await euAgree.first().isVisible()) {
        await euAgree.first().click();
        await sleep(500);
      }
    } catch {}

    await sleep(1000);
  }

  return false;
}

/**
 * Claims a single free game by URL.
 */
export async function claimGame(page, game, history, { force = false, logger = console.log, accountId = null, username = null } = {}) {
  logger(`\n========================================`);
  logger(`🎮 Processing: ${game.title}`);
  logger(`🔗 Store URL: ${game.storeUrl}`);

  if (!game.storeUrl) {
    logger(`⚠️ No valid store page slug found for ${game.title}. Skipping.`);
    return { status: 'skipped_no_slug' };
  }

  if (!force && isGameClaimed(history, game, accountId)) {
    logger(`ℹ️ Already claimed previously for ${username || accountId || 'this account'}. Skipping.`);
    return { status: 'already_claimed_in_history' };
  }

  // 1. Instant check: If game is already owned according to Epic order history API
  try {
    const isOwned = await isGameInEpicLibrary(game, { page });
    if (isOwned) {
      logger(`✅ "${game.title}" is already in your library!`);
      recordClaim(history, game, 'in_library', accountId, username);
      return { status: 'in_library' };
    }
  } catch (e) {}

  await page.goto(game.storeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.DEFAULT_TIMEOUT });
  await sleep(3000);

  await handleCloudflareTurnstile(page, logger);
  await handleDialogs(page, logger);

  const cta = page.locator('button[data-testid="purchase-cta-button"]');
  try {
    await cta.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    const handled = await handleCloudflareTurnstile(page, logger);
    if (handled) {
      await sleep(2500);
      try {
        await cta.waitFor({ state: 'visible', timeout: 8000 });
      } catch {}
    }
    if (await cta.count() === 0) {
      logger('⚠️ Could not locate purchase button (data-testid="purchase-cta-button").');
      return { status: 'error_button_not_found' };
    }
  }

  const btnText = (await cta.innerText()).toLowerCase().trim();
  logger(`   Button status: "${btnText}"`);

  if (btnText.includes('in library') || btnText.includes('owned')) {
    logger(`✅ "${game.title}" is already in your library!`);
    recordClaim(history, game, 'in_library', accountId, username);
    return { status: 'in_library' };
  }

  if (btnText.includes('requires base game')) {
    logger(`⚠️ "${game.title}" requires base game. Cannot claim standalone.`);
    return { status: 'requires_base_game' };
  }

  if (!btnText.includes('get') && !btnText.includes('free')) {
    logger(`⚠️ Button indicates game is not currently free (text: "${btnText}"). Skipping.`);
    return { status: 'not_free' };
  }

  logger(`👉 Clicking "Get" for ${game.title}...`);
  await cta.click();

  // Aggressively dismiss any modals ("Device not supported", mature content) that immediately appear
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    await handleDialogs(page, logger);
  }

  const clicked = await completeCheckout(page, logger);
  if (!clicked) {
    logger('❌ Could not locate or click checkout confirmation button.');
    return { status: 'error_checkout_button_not_found' };
  }

  logger('⏳ Waiting for order completion...');
  const maxConfirmAttempts = 25;
  for (let i = 0; i < maxConfirmAttempts; i++) {
    await sleep(1000);

    try {
      const confirmed = page.locator('text=Thanks for your order!, text=Thank you for buying, text=Thank you!, text=Order Confirmed');
      if (await confirmed.count() > 0 && await confirmed.first().isVisible()) {
        logger(`🎉 SUCCESS: Successfully claimed "${game.title}"!`);
        recordClaim(history, game, 'claimed', accountId, username);
        sendNotification('Epic Games Freebie Claimed!', `Successfully claimed "${game.title}"!`);
        await sleep(3000);
        return { status: 'claimed' };
      }
    } catch {}

    try {
      const refreshedCta = page.locator('button[data-testid="purchase-cta-button"]');
      if (await refreshedCta.count() > 0) {
        const text = (await refreshedCta.innerText()).toLowerCase();
        if (text.includes('in library') || text.includes('owned')) {
          logger(`🎉 SUCCESS: "${game.title}" is now verified In Library!`);
          recordClaim(history, game, 'claimed', accountId, username);
          sendNotification('Epic Games Freebie Claimed!', `Successfully claimed "${game.title}"!`);
          await sleep(2000);
          return { status: 'claimed' };
        }
      }
    } catch {}
  }

  try {
    logger('🔄 Verifying library status on store page...');
    await page.goto(game.storeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.DEFAULT_TIMEOUT });
    await sleep(3000);
    const finalCta = page.locator('button[data-testid="purchase-cta-button"]');
    const finalText = (await finalCta.innerText()).toLowerCase();
    if (finalText.includes('in library') || finalText.includes('owned')) {
      logger(`🎉 SUCCESS: "${game.title}" verified In Library!`);
      recordClaim(history, game, 'claimed', accountId, username);
      sendNotification('Epic Games Freebie Claimed!', `Successfully claimed "${game.title}"!`);
      return { status: 'claimed' };
    }
  } catch {}

  logger('⚠️ Order button was clicked, but could not explicitly verify final confirmation.');
  recordClaim(history, game, 'claimed', accountId, username);
  return { status: 'claimed_unverified' };
}

/**
 * Retrieves the display name of the currently authenticated Epic user.
 */
export async function getEpicUsername(page) {
  // 1. Primary: Fast direct session API (instant JSON response)
  try {
    const res = await page.request.get('https://www.epicgames.com/id/api/account', { timeout: 6000 });
    if (res.ok()) {
      const data = await res.json();
      if (data && data.displayName && data.displayName.trim().length > 0) {
        return data.displayName.trim();
      }
    }
  } catch {}

  // 2. Fallback: Check account portal
  try {
    if (!page.url().includes('accounts.epicgames.com/account/personal')) {
      await page.goto('https://accounts.epicgames.com/account/personal', {
        waitUntil: 'domcontentloaded',
        timeout: 8000,
      }).catch(() => {});
    }

    const input = page.locator('input[name="displayName"], #displayName');
    if (await input.count() > 0) {
      const name = (await input.inputValue()).trim();
      if (name) return name;
    }
  } catch {}

  // 3. Fallback: Parse display name from EGS navigation if present
  try {
    const nav = page.locator('egs-navigation');
    if (await nav.count() > 0) {
      const name = await nav.getAttribute('displayname');
      if (name && name !== 'null') return name;
    }
  } catch {}

  return null;
}

/**
 * Interactively logs into a new isolated Epic Games profile and registers it.
 */
export async function loginNewEpicAccount() {
  console.log('➕ Adding new Epic Games account...');
  const { id, relPath, fullPath } = createNewProfileDir('epic');
  const context = await launchBrowser({ headless: false, profileDir: fullPath });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await page.goto(CONFIG.LOGIN_URL, { waitUntil: 'domcontentloaded' });
    console.log('⏳ Waiting for you to complete Epic Games login (up to 3 minutes)...');

    const start = Date.now();
    const maxWaitMs = 180000;
    let loggedIn = false;

    while (Date.now() - start < maxWaitMs) {
      await sleep(2500);
      const cookies = await context.cookies();
      const hasAuth = cookies.some((c) =>
        c.name === 'EPIC_BEARER_TOKEN' ||
        c.name === 'EPIC_SSO' ||
        c.name === 'EPIC_EG1'
      );

      if (hasAuth && !page.url().includes('/id/login')) {
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      return { success: false, error: 'Login timed out or was cancelled' };
    }

    await sleep(2500);
    const username = (await getEpicUsername(page)) || `Epic User (${id.slice(-4)})`;
    const account = registerAccount('epic', { id, username, profileDir: relPath });

    // Instantly check promotions and sync library while browser session is active
    try {
      const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
      if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
        await syncEpicLibraryForAccount(currentFreeGames, account, { page });
      }
    } catch (e) {
      console.warn('Post-login library sync notice:', e.message);
    }

    return { success: true, account };
  } finally {
    await context.close();
  }
}

/**
 * Switches Epic Games account by clearing cookies and prompting login.
 */
export async function switchEpicAccount() {
  console.log('🔄 Switching Epic Games account...');
  const context = await launchBrowser({ headless: false });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await context.clearCookies();
    await page.goto('https://www.epicgames.com/id/logout?redirectUrl=https://www.epicgames.com/id/login', {
      waitUntil: 'domcontentloaded',
    });
    return await ensureLoggedIn(page, { interactive: true });
  } finally {
    await context.close();
  }
}

/**
 * Synchronizes real Epic Games library status for active promotions in a single browser session.
 * Queries Epic Games' authenticated order history API (~200ms JSON response, completely bypassing Cloudflare).
 * @param {Array<Object>} games - Promotional games to check
 * @param {Object} account - Epic account { id, username, profileDir }
 * @param {Object} [options]
 * @param {import('playwright').Page} [options.page] - Existing page if already open
 * @returns {Promise<Array<Object>>} Array of games confirmed to be in library
 */
export async function syncEpicLibraryForAccount(games, account, { page: existingPage } = {}) {
  if (!account || !Array.isArray(games) || games.length === 0) return [];

  const history = loadHistory();
  const unclaimedGames = games.filter(g => !isGameClaimed(history, g, account.id));
  if (unclaimedGames.length === 0) return [];

  const checkOrdersAgainstGames = (orders) => {
    const owned = [];
    if (!Array.isArray(orders)) return owned;
    for (const game of unclaimedGames) {
      const isOwned = orders.some(order => (order.items || []).some(item => {
        if (game.id && item.offerId && item.offerId.toLowerCase() === game.id.toLowerCase()) return true;
        if (game.title && item.description && item.description.trim().toLowerCase() === game.title.trim().toLowerCase()) return true;
        if (game.slug && item.description) {
          const cleanDesc = item.description.toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanSlug = game.slug.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (cleanDesc && cleanSlug && (cleanDesc.includes(cleanSlug) || cleanSlug.includes(cleanDesc))) return true;
        }
        return false;
      }));
      if (isOwned) owned.push(game);
    }
    return owned;
  };

  const executeCheck = async (page) => {
    let allOrders = [];
    let pageNum = 1;
    let nextPageToken = null;
    while (pageNum <= 3) {
      const url = nextPageToken
        ? `https://accounts.epicgames.com/account/v2/payment/ajaxGetOrderHistory?sortDir=DESC&sortBy=DATE&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : `https://accounts.epicgames.com/account/v2/payment/ajaxGetOrderHistory?sortDir=DESC&sortBy=DATE&page=${pageNum}`;

      const res = await page.request.get(url, { timeout: 6000 }).catch(() => null);
      if (res && res.ok()) {
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.orders)) {
          allOrders = allOrders.concat(data.orders);
          const found = checkOrdersAgainstGames(allOrders);
          if (found.length === unclaimedGames.length) {
            return found;
          }
          nextPageToken = data.nextPageToken;
          if (!nextPageToken) break;
        } else {
          break;
        }
      } else {
        break;
      }
      pageNum++;
    }
    return checkOrdersAgainstGames(allOrders);
  };

  let newlyOwned = [];
  if (existingPage) {
    newlyOwned = await executeCheck(existingPage);
  } else {
    let context = null;
    try {
      context = await launchBrowser({ headless: true, profileDir: account.profileDir });
      const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
      newlyOwned = await executeCheck(page);
    } catch (err) {
      console.warn('Sync Epic library error:', err.message);
    } finally {
      if (context) await context.close().catch(() => {});
    }
  }

  if (newlyOwned.length > 0) {
    const freshHistory = loadHistory();
    for (const game of newlyOwned) {
      recordClaim(freshHistory, game, 'in_library', account.id, account.username);
    }
  }

  return newlyOwned;
}

/**
 * Checks whether a game is already owned in the user's Epic library.
 * Primary: Queries Epic Games' authenticated order history API via fast JSON request (~200ms, bypasses Cloudflare).
 * Fallback: Visits the store page CTA button in headless mode.
 */
export async function isGameInEpicLibrary(gameOrUrl, { profileDir, page: existingPage } = {}) {
  if (!gameOrUrl) return false;

  const targetTitle = typeof gameOrUrl === 'object' ? gameOrUrl.title : null;
  const targetId = typeof gameOrUrl === 'object' ? gameOrUrl.id : null;
  const targetSlug = typeof gameOrUrl === 'object'
    ? gameOrUrl.slug
    : (typeof gameOrUrl === 'string' ? gameOrUrl.split('/p/')[1]?.split('/')[0]?.split('?')[0] : null);

  const checkOrdersMatch = (orders) => {
    if (!Array.isArray(orders)) return false;
    for (const order of orders) {
      for (const item of (order.items || [])) {
        if (targetId && item.offerId && item.offerId.toLowerCase() === targetId.toLowerCase()) {
          return true;
        }
        if (targetTitle && item.description && item.description.trim().toLowerCase() === targetTitle.trim().toLowerCase()) {
          return true;
        }
        if (targetSlug && item.description) {
          const cleanDesc = item.description.toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanSlug = targetSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (cleanDesc && cleanSlug && (cleanDesc.includes(cleanSlug) || cleanSlug.includes(cleanDesc))) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const queryOrderHistory = async (page) => {
    let pageNum = 1;
    let nextPageToken = null;
    while (pageNum <= 3) {
      const url = nextPageToken
        ? `https://accounts.epicgames.com/account/v2/payment/ajaxGetOrderHistory?sortDir=DESC&sortBy=DATE&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : `https://accounts.epicgames.com/account/v2/payment/ajaxGetOrderHistory?sortDir=DESC&sortBy=DATE&page=${pageNum}`;

      const res = await page.request.get(url, { timeout: 6000 }).catch(() => null);
      if (res && res.ok()) {
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.orders)) {
          if (checkOrdersMatch(data.orders)) {
            return true;
          }
          nextPageToken = data.nextPageToken;
          if (!nextPageToken) break;
        } else {
          break;
        }
      } else {
        break;
      }
      pageNum++;
    }
    return false;
  };

  if (existingPage) {
    try {
      return await queryOrderHistory(existingPage);
    } catch (e) {
      console.warn('Epic library check on existing page failed:', e.message);
      return false;
    }
  }

  let context = null;
  try {
    const targetDir = profileDir || getActiveProfileDir('epic');
    context = await launchBrowser({ headless: true, profileDir: targetDir });
    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    const isOwned = await queryOrderHistory(page);
    if (isOwned) return true;

    const storeUrl = typeof gameOrUrl === 'string' ? gameOrUrl : gameOrUrl?.storeUrl;
    if (storeUrl) {
      await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      const cta = page.locator('button[data-testid="purchase-cta-button"]');
      await cta.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      if (await cta.count() > 0) {
        const text = (await cta.first().innerText()).trim().toUpperCase();
        if (text.includes('IN LIBRARY') || text.includes('VIEW IN LIBRARY') || text.includes('OWNED')) {
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('Epic library check notice:', err.message);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  return false;
}


