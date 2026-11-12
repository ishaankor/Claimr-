import { chromium } from 'playwright';
import { createCursor } from 'ghost-cursor';
import { CONFIG } from './config.js';
import { isGameClaimed, recordClaim, loadHistory } from './history.js';
import { sendNotification } from './notify.js';
import { getActiveProfileDir, getFullProfileDir, createNewProfileDir, registerAccount } from './accounts.js';
import { launchBrowserContext, waitForCloudflareResolution, bringWindowToForeground } from './browser.js';
import { getPromotions } from './api.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Initializes the Playwright browser context using a persistent profile directory.
 */
export async function launchBrowser({ headless = false, profileDir, log } = {}) {
  const targetDir = profileDir ? getFullProfileDir(profileDir, 'epic') : getActiveProfileDir('epic');
  const context = await launchBrowserContext(targetDir, {
    headless,
    viewport: { width: 1366, height: 850 },
    locale: CONFIG.LOCALE,
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  }, log);

  // Only pre-seed consent cookies for headless runs; in interactive mode, let OneTrust load naturally
  if (headless) {
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
  }

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

const cursorCache = new WeakMap();

/**
 * Simulates authentic human cursor trajectory and click using ghost-cursor (natural Bézier curves)
 * to avoid anti-bot heuristic flags from Arkose Labs and Cloudflare.
 */
async function humanClick(page, locator) {
  try {
    let cursor = cursorCache.get(page);
    if (!cursor) {
      cursor = createCursor(page);
      cursorCache.set(page, cursor);
    }
    const element = await locator.elementHandle().catch(() => null);
    if (element) {
      await cursor.click(element, {
        paddingPercentage: 15,
        waitBeforeClick: [120, 280],
        waitBetweenClick: [60, 140],
      });
      return;
    }
  } catch {}

  try {
    const box = await locator.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
      const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);
      await page.mouse.move(targetX, targetY, { steps: 12 }).catch(() => {});
      await sleep(150 + Math.random() * 120);
      await page.mouse.down().catch(() => {});
      await sleep(70 + Math.random() * 60);
      await page.mouse.up().catch(() => {});
      return;
    }
  } catch {}
  await locator.click({ delay: 60 }).catch(() => {});
}

/**
 * Identifies if an iframe belongs to a known captcha or security challenge provider.
 */
export function isSecurityOrCaptchaFrame(frame) {
  try {
    const url = (frame.url() || '').toLowerCase();
    const name = (frame.name() || '').toLowerCase();

    if (
      url.includes('turnstile') ||
      url.includes('hcaptcha') ||
      url.includes('recaptcha') ||
      url.includes('arkoselabs') ||
      url.includes('arkose') ||
      url.includes('octocaptcha') ||
      url.includes('funcaptcha') ||
      url.includes('cloudflare.com/cdn-cgi') ||
      name.includes('arkose') ||
      name.includes('captcha') ||
      name.includes('enforcement')
    ) {
      return true;
    }

    const parent = typeof frame.parentFrame === 'function' ? frame.parentFrame() : null;
    if (parent && parent !== frame && isSecurityOrCaptchaFrame(parent)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Checks whether an active security challenge or interactive captcha is visible and awaiting user interaction.
 * Carefully avoids false positives on background invisible tokens while detecting live challenge modals.
 */
export async function isCaptchaActive(page) {
  try {
    // 1. Check for active hCaptcha challenge frame with visible challenge UI
    for (const frame of page.frames()) {
      const url = (frame.url() || '').toLowerCase();
      if (url.includes('hcaptcha.html#frame=challenge')) {
        try {
          const body = frame.locator('body');
          if (await body.count() > 0 && await body.first().isVisible().catch(() => false)) {
            return true;
          }
        } catch {}
      }
      if (url.includes('arkoselabs') || url.includes('funcaptcha') || url.includes('octocaptcha')) {
        try {
          const body = frame.locator('body');
          if (await body.count() > 0 && await body.first().isVisible().catch(() => false)) {
            return true;
          }
        } catch {}
      }
    }

    // 2. Check for visible challenge iframes/containers on page
    const visibleCaptchaContainers = page.locator(
      'iframe[src*="hcaptcha.html#frame=challenge"]:visible, ' +
      'iframe[title*="hCaptcha challenge"]:visible, ' +
      'div#challenge-stage:visible'
    );
    if (await visibleCaptchaContainers.count() > 0) {
      return true;
    }

    // 3. Check for Cloudflare interstitial title
    const title = (await page.title().catch(() => '')) || '';
    if (title.includes('Just a moment') || title.includes('One more step')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Handles any interstitial dialogs (mature content, device warnings, EULA).
 */
async function handleDialogs(page, logger = console.log) {
  try {
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("CONTINUE")');
    if (await continueBtn.count() > 0 && await continueBtn.first().isVisible().catch(() => false)) {
      logger('   Handling confirmation modal (Continue)...');
      await continueBtn.first().click({ delay: 50 }).catch(() => {});
      await sleep(1500);
    }

    const yesBtn = page.locator('button:has-text("Yes, buy now"), button:has-text("YES, BUY NOW"), button:has-text("Yes"), button:has-text("YES")');
    if (await yesBtn.count() > 0 && await yesBtn.first().isVisible().catch(() => false)) {
      await yesBtn.first().click({ delay: 50 }).catch(() => {});
      await sleep(1000);
    }

    const acknowledgeBtn = page.locator('button:has-text("I Understand"), button:has-text("Proceed"), button:has-text("Dismiss"), button:has-text("OK")');
    if (await acknowledgeBtn.count() > 0 && await acknowledgeBtn.first().isVisible().catch(() => false)) {
      await acknowledgeBtn.first().click({ delay: 50 }).catch(() => {});
      await sleep(1000);
    }

    // Dismiss post-purchase "Is Epic Games Launcher installed?" prompt
    const launcherModal = page.locator('div[role="dialog"]:has-text("Epic Games Launcher"), div:has-text("Is Epic Games Launcher installed?")');
    if (await launcherModal.count() > 0 && await launcherModal.first().isVisible().catch(() => false)) {
      const closeBtn = page.locator('button[aria-label="Close"], button[aria-label="close"], button:has-text("Yes, it\'s installed")');
      if (await closeBtn.count() > 0 && await closeBtn.first().isVisible().catch(() => false)) {
        await closeBtn.first().click().catch(() => {});
        await sleep(800);
      }
    }

    const eulaCheck = page.locator('input#agree, input#eula, input[name="agree"]');
    if (await eulaCheck.count() > 0 && await eulaCheck.first().isVisible().catch(() => false)) {
      logger('   Accepting EULA...');
      await eulaCheck.first().check().catch(() => {});
      const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("ACCEPT"), button:has-text("I Agree"), button:has-text("I Accept")');
      if (await acceptBtn.count() > 0 && await acceptBtn.first().isVisible().catch(() => false)) {
        await acceptBtn.first().click({ delay: 50 }).catch(() => {});
        await sleep(1500);
      }
    }

    for (const frame of page.frames()) {
      if (isSecurityOrCaptchaFrame(frame)) continue;
      const frameContinue = frame.locator('button:has-text("Continue"), button:has-text("CONTINUE")');
      if (await frameContinue.count() > 0 && await frameContinue.first().isVisible().catch(() => false)) {
        logger('   Handling confirmation modal in frame (Continue)...');
        await frameContinue.first().click({ delay: 50 }).catch(() => {});
        await sleep(1500);
      }
    }
  } catch {}
}

/**
 * Completes the checkout screen by finding and clicking "Add to library" or "Place Order".
 * Uses authentic human mouse clicks and proactively handles interactive security verifications.
 */
async function completeCheckout(page, logger = console.log, game = {}) {
  logger('⏳ Waiting for checkout screen to load...');

  const candidateSelectors = [
    'button:has-text("Add to library")',
    'button:has-text("Add to Library")',
    'button:has-text("ADD TO LIBRARY")',
    '[role="button"]:has-text("Add to library")',
    '[role="button"]:has-text("Add to Library")',
    'button:has-text("Place Order")',
    'button:has-text("Place order")',
    'button:has-text("PLACE ORDER")',
    '[role="button"]:has-text("Place Order")',
    'button.payment-btn--primary',
    'button.payment-order-confirm__btn',
    'button:has-text("Buy Now")',
    'button:has-text("BUY NOW")',
  ];

  const maxAttempts = 35;
  for (let i = 0; i < maxAttempts; i++) {
    // 1. Check if order confirmation text is already visible
    try {
      const confirmed = page.locator('text=Thanks for your order!, text=Thank you for buying, text=Thank you!, text=Order Confirmed');
      if (await confirmed.count() > 0 && await confirmed.first().isVisible().catch(() => false)) {
        return true;
      }
    } catch {}

    // 2. Handle any dialogs ("Device not supported", mature content, EULA) that block checkout
    await handleDialogs(page, logger);

    // 3. Scan non-captcha frames and main page for checkout button
    const safeFrames = page.frames().filter(f => !isSecurityOrCaptchaFrame(f));
    const scopes = [...safeFrames, page];
    for (const scope of scopes) {
      for (const sel of candidateSelectors) {
        try {
          const loc = scope.locator(sel);
          const count = await loc.count().catch(() => 0);
          for (let c = 0; c < count; c++) {
            const btn = loc.nth(c);
            const testId = (await btn.getAttribute('data-testid').catch(() => '')) || '';
            // STRICTLY IGNORE background store page purchase CTA button
            if (testId.includes('purchase-cta')) continue;

            if (await btn.isVisible().catch(() => false)) {
              const text = (await btn.innerText().catch(() => '')).trim();
              if (/in library|owned|view in library|download/i.test(text)) continue;

              logger(`👉 Found button "${text || 'Add to library'}" in checkout. Clicking...`);
              await btn.scrollIntoViewIfNeeded().catch(() => {});
              await sleep(400);
              await humanClick(page, btn);
              await sleep(1500);

              // Check if an interactive security challenge / hCaptcha appeared
              let captchaActive = false;
              for (let check = 0; check < 3; check++) {
                if (await isCaptchaActive(page)) {
                  captchaActive = true;
                  break;
                }
                await sleep(1000);
              }

              if (captchaActive) {
                const isContextHeadless = page.context()?._isHeadless === true;
                if (isContextHeadless) {
                  logger('   🛡️ Security challenge (Captcha) encountered in headless mode.');
                  logger('   👉 Requesting visible window assist...');
                  return 'captcha_required';
                }

                logger('   🛡️ Security verification (Captcha) required by Epic Games.');
                logger('   👉 Moving browser window to foreground so you can complete verification...');
                await bringWindowToForeground(page);
                sendNotification(
                  'Claimr - Security Check Required 🛡️',
                  `Epic Games requires a quick security check for ${game?.title || 'game'}. Please complete it in the browser window.`
                );

                const startCaptchaWait = Date.now();
                const maxCaptchaWaitMs = 180000; // 3 minutes
                while (Date.now() - startCaptchaWait < maxCaptchaWaitMs) {
                  await sleep(2000);

                  // Check if order confirmed while or after solving
                  try {
                    const confirmed = page.locator('text=Thanks for your order!, text=Thank you for buying, text=Thank you!, text=Order Confirmed');
                    if (await confirmed.count() > 0 && await confirmed.first().isVisible().catch(() => false)) {
                      logger('   🎉 Order confirmation detected!');
                      return true;
                    }
                  } catch {}

                  const stillActive = await isCaptchaActive(page);
                  if (!stillActive) {
                    logger('   ✅ Security verification completed! Processing order...');
                    await sleep(1500);

                    // Re-scan scopes for the "Place Order" / "Add to library" button in case it needs to be clicked with the solved token
                    let reClicked = false;
                    for (const checkScope of scopes) {
                      for (const sel of candidateSelectors) {
                        try {
                          const postBtn = checkScope.locator(sel);
                          if (await postBtn.count() > 0 && await postBtn.first().isVisible().catch(() => false)) {
                            const btnText = (await postBtn.first().innerText().catch(() => '')).trim();
                            if (/in library|owned|view in library|download/i.test(btnText)) {
                              return true;
                            }
                            logger(`   👉 Clicking "${btnText || 'Place Order'}" to submit order with completed verification...`);
                            await humanClick(page, postBtn.first());
                            await sleep(2500);
                            reClicked = true;
                            break;
                          }
                        } catch {}
                      }
                      if (reClicked) break;
                    }
                    break;
                  }
                }

                if (await isCaptchaActive(page)) {
                  logger('   ⚠️ Security verification timed out or was not completed.');
                  return false;
                }
              }

              return true;
            }
          }
        } catch {}
      }
    }

    try {
      const euAgree = page.locator('button:has-text("I Accept"), button:has-text("I Agree")');
      if (await euAgree.count() > 0 && await euAgree.first().isVisible().catch(() => false)) {
        await euAgree.first().click().catch(() => {});
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
  await sleep(2000);

  await handleDialogs(page, logger);

  // Check if blocked by Cloudflare verification gate
  const pageTitle = (await page.title().catch(() => '')) || '';
  if (pageTitle.includes('Just a moment') || pageTitle.includes('One more step')) {
    const isHeadless = !!page.context()?._isHeadless;
    if (isHeadless) {
      logger('⚠️ Blocked by Cloudflare security check ("Just a moment...").');
      return { status: 'cloudflare_blocked' };
    }

    // In visible window, allow user to complete verification directly
    const cleared = await waitForCloudflareResolution(page, logger, 60);
    if (!cleared) {
      logger('⚠️ Cloudflare security check was not completed.');
      return { status: 'cloudflare_blocked' };
    }
    await sleep(2000);
    await handleDialogs(page, logger);
  }

  // Locate the primary purchase / CTA button ("Get", "In Library")
  let cta = page.locator('button[data-testid="purchase-cta-button"]');
  try {
    await cta.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    await handleDialogs(page, logger);
    try {
      await cta.waitFor({ state: 'visible', timeout: 5000 });
    } catch {}
  }

  // Fallback to text selectors if data-testid changed
  if ((await cta.count()) === 0 || !(await cta.first().isVisible().catch(() => false))) {
    const fallbackCta = page.locator('aside button:has-text("Get"), aside button:has-text("GET"), button:has-text("Get"), button:has-text("GET"), button:has-text("In Library"), button:has-text("IN LIBRARY")');
    if ((await fallbackCta.count()) > 0 && (await fallbackCta.first().isVisible().catch(() => false))) {
      cta = fallbackCta.first();
    }
  }

  if ((await cta.count()) === 0 || !(await cta.first().isVisible().catch(() => false))) {
    const finalTitle = (await page.title().catch(() => '')) || '';
    if (finalTitle.includes('Just a moment') || finalTitle.includes('One more step')) {
      logger('⚠️ Blocked by Cloudflare security check ("Just a moment...").');
      return { status: 'cloudflare_blocked' };
    }
    logger('⚠️ Could not locate purchase button (data-testid="purchase-cta-button").');
    return { status: 'error_button_not_found' };
  }

  cta = cta.first();

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
  await humanClick(page, cta);

  // Aggressively dismiss any modals ("Device not supported", mature content) that immediately appear
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    await handleDialogs(page, logger);
  }

  const clicked = await completeCheckout(page, logger, game);
  if (clicked === 'captcha_required') {
    logger('⚠️ Security challenge (Captcha) encountered in headless mode.');
    return { status: 'captcha_required' };
  }
  if (!clicked) {
    if (await isCaptchaActive(page)) {
      logger('⚠️ Blocked by security challenge.');
      return { status: 'captcha_required' };
    }
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
      const refreshedCta = page.locator('button[data-testid="purchase-cta-button"], aside button, button:has-text("In Library"), button:has-text("IN LIBRARY"), button:has-text("Owned")');
      if (await refreshedCta.count() > 0) {
        const text = (await refreshedCta.first().innerText()).toLowerCase();
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
    const finalCta = page.locator('button[data-testid="purchase-cta-button"], aside button, button:has-text("In Library"), button:has-text("IN LIBRARY"), button:has-text("Owned")');
    if (await finalCta.count() > 0) {
      const finalText = (await finalCta.first().innerText()).toLowerCase();
      if (finalText.includes('in library') || finalText.includes('owned')) {
        logger(`🎉 SUCCESS: "${game.title}" verified In Library!`);
        recordClaim(history, game, 'claimed', accountId, username);
        sendNotification('Epic Games Freebie Claimed!', `Successfully claimed "${game.title}"!`);
        return { status: 'claimed' };
      }
    }
  } catch {}

  // Final check: Authenticated order history API check (fast JSON verification with retries)
  for (let poll = 0; poll < 3; poll++) {
    try {
      const isOwnedApi = await isGameInEpicLibrary(game, { page });
      if (isOwnedApi) {
        logger(`🎉 SUCCESS: "${game.title}" verified In Library via Epic API!`);
        recordClaim(history, game, 'claimed', accountId, username);
        sendNotification('Epic Games Freebie Claimed!', `Successfully claimed "${game.title}"!`);
        return { status: 'claimed' };
      }
    } catch {}
    await sleep(2000);
  }

  if (await isCaptchaActive(page)) {
    logger('⚠️ Claim could not be completed because security verification was not finished.');
    return { status: 'captcha_required' };
  }

  logger('❌ Order was placed or attempted, but could not explicitly verify final confirmation in library.');
  logger('   Skipping history record so this title can be safely retried.');
  return { status: 'error_unverified' };
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

  // Prefer native Electron login window to bypass Arkose Labs CDP detection
  try {
    const electronModule = await import('electron').catch(() => null);
    const electronBinary = electronModule?.default;
    if (electronBinary && typeof electronBinary === 'string') {
      const { spawnSync } = await import('child_process');
      const env = { ...process.env, ELECTRON_ENABLE_LOGGING: 'false' };
      delete env.ELECTRON_RUN_AS_NODE;
      spawnSync(electronBinary, ['.', '--login:epic'], { stdio: 'inherit', env });
      const active = getActiveAccount('epic');
      return { success: !!active, account: active };
    }
  } catch {}

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
      let cookies = [];
      try {
        cookies = await context.cookies();
      } catch {
        break;
      }

      const hasAuth = cookies.some((c) =>
        c.name === 'EPIC_BEARER_TOKEN' ||
        c.name === 'EPIC_SSO' ||
        c.name === 'EPIC_EG1'
      );

      try {
        if (hasAuth && !page.url().includes('/id/login')) {
          loggedIn = true;
          break;
        }
      } catch {
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

    let found = checkOrdersAgainstGames(allOrders);

    // If any active free games were not found in recent orders (e.g. claimed long ago or via code),
    // check store page CTA directly in the active session
    if (found.length < unclaimedGames.length) {
      const remaining = unclaimedGames.filter(g => !found.some(f => (f.id && f.id === g.id) || (f.title && f.title === g.title)));
      for (const game of remaining) {
        if (game.storeUrl) {
          try {
            await page.goto(game.storeUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
            const cta = page.locator('button[data-testid="purchase-cta-button"]');
            await cta.waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
            if (await cta.count() > 0) {
              const text = (await cta.first().innerText()).trim().toUpperCase();
              if (text.includes('IN LIBRARY') || text.includes('VIEW IN LIBRARY') || text.includes('OWNED')) {
                found.push(game);
              }
            }
          } catch {}
        }
      }
    }

    return found;
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


