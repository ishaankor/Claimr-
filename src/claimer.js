import { chromium } from 'playwright';
import { CONFIG } from './config.js';
import { isGameClaimed, recordClaim } from './history.js';
import { sendNotification } from './notify.js';
import { getActiveProfileDir, createNewProfileDir, registerAccount } from './accounts.js';
import { resolveBrowserOptions } from './browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initializes the Playwright browser context using a persistent profile directory.
 */
export async function launchBrowser({ headless = false, profileDir } = {}) {
  const targetDir = profileDir || getActiveProfileDir('epic');
  const browserOpts = await resolveBrowserOptions();
  const context = await chromium.launchPersistentContext(targetDir, {
    ...browserOpts,
    headless,
    viewport: { width: 1366, height: 850 },
    userAgent: CONFIG.USER_AGENT,
    locale: CONFIG.LOCALE,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

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
    await sleep(2500);
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
    const continueBtn = page.locator('button:has-text("Continue"), //button[contains(.,"Continue")]');
    if (await continueBtn.count() > 0 && await continueBtn.first().isVisible()) {
      logger('   Handling confirmation modal (Continue)...');
      await continueBtn.first().click();
      await sleep(1500);
    }

    const yesBtn = page.locator('button:has-text("Yes, buy now")');
    if (await yesBtn.count() > 0 && await yesBtn.first().isVisible()) {
      await yesBtn.first().click();
      await sleep(1000);
    }

    const eulaCheck = page.locator('input#agree');
    if (await eulaCheck.count() > 0 && await eulaCheck.isVisible()) {
      logger('   Accepting EULA...');
      await eulaCheck.check();
      const acceptBtn = page.locator('button:has-text("Accept")');
      if (await acceptBtn.count() > 0) {
        await acceptBtn.click();
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
    'button.payment-btn--primary',
  ];

  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
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

  await page.goto(game.storeUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.DEFAULT_TIMEOUT });
  await sleep(3000);

  await handleDialogs(page, logger);

  const cta = page.locator('button[data-testid="purchase-cta-button"]');
  try {
    await cta.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    logger('⚠️ Could not locate purchase button (data-testid="purchase-cta-button").');
    return { status: 'error_button_not_found' };
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
  await sleep(2500);

  await handleDialogs(page, logger);

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
  try {
    if (!page.url().includes('accounts.epicgames.com/account/personal')) {
      await page.goto('https://accounts.epicgames.com/account/personal', {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      }).catch(() => {});
    }

    await page.waitForFunction(() => {
      const el = document.querySelector('input[name="displayName"], #displayName');
      return el && el.value && el.value.trim().length > 0;
    }, { timeout: 6000 }).catch(() => {});

    const input = page.locator('input[name="displayName"], #displayName');
    if (await input.count() > 0) {
      const name = (await input.inputValue()).trim();
      if (name) return name;
    }
  } catch {}

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
 * Checks whether a game is already owned in the user's Epic library by visiting its store URL.
 */
export async function isGameInEpicLibrary(storeUrl, { profileDir } = {}) {
  if (!storeUrl) return false;
  const context = await launchBrowser({ headless: true, profileDir });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const cta = page.locator('button[data-testid="purchase-cta-button"]');
    await cta.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    if (await cta.count() > 0) {
      const text = (await cta.first().innerText()).trim().toUpperCase();
      return text.includes('IN LIBRARY') || text.includes('VIEW IN LIBRARY') || text.includes('OWNED');
    }
  } catch (err) {
    console.warn('Epic library check notice:', err.message);
  } finally {
    await context.close();
  }
  return false;
}

