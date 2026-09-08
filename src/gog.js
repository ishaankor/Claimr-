import { chromium } from 'playwright';
import path from 'path';
import { CONFIG } from './config.js';
import { loadHistory, recordClaim } from './history.js';
import { sendNotification } from './notify.js';
import { getActiveProfileDir, createNewProfileDir, registerAccount } from './accounts.js';
import { launchBrowserContext } from './browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const GOG_CONFIG = {
  get PROFILE_DIR() {
    return path.join(CONFIG.DATA_DIR, '.profile-gog');
  },
  HOME_URL: 'https://www.gog.com/en',
  LOGIN_URL: 'https://login.gog.com/login',
  CLAIM_URL: 'https://www.gog.com/giveaway/claim',
  TIMEOUT: 30000,
};

/**
 * Launches persistent browser context for GOG.
 */
export async function launchGogBrowser({ headless = false, profileDir, log } = {}) {
  const targetDir = profileDir || getActiveProfileDir('gog');
  const context = await launchBrowserContext(targetDir, {
    headless,
    viewport: { width: 1366, height: 850 },
    userAgent: CONFIG.USER_AGENT,
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  }, log);

  await context.addCookies([
    {
      name: 'CookieConsent',
      value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}',
      domain: 'www.gog.com',
      path: '/',
    },
  ]);

  return context;
}

/**
 * Checks if the user is authenticated on GOG.
 */
export async function isGogLoggedIn(page) {
  // 1. Direct check against GOG user data API endpoint using shared context cookies
  try {
    const res = await page.request.get('https://www.gog.com/userData.json', { timeout: 6000 });
    if (res.ok()) {
      const data = await res.json();
      if (data && data.isLoggedIn && data.username) {
        return data.username;
      }
    }
  } catch {}

  // 2. In-page evaluate if on www.gog.com
  try {
    const userData = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.gog.com/userData.json');
        if (res.ok) return await res.json();
      } catch {}
      return null;
    });

    if (userData && userData.isLoggedIn && userData.username) {
      return userData.username;
    }

    const usernameLoc = page.locator('#menuUsername');
    if (await usernameLoc.count() > 0 && await usernameLoc.first().isVisible()) {
      const username = (await usernameLoc.first().innerText()).trim();
      if (username) return username;
    }
  } catch {}

  return null;
}

/**
 * Interactive login flow for GOG.
 */
export async function loginGog({ profileDir } = {}) {
  console.log('\n========================================');
  console.log('🔑 GOG LOGIN SESSION SETUP');
  console.log('Opening GOG login in browser. Please sign in to your GOG account.');
  console.log('========================================\n');

  const context = await launchGogBrowser({ headless: false, profileDir });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await page.goto(GOG_CONFIG.LOGIN_URL, { waitUntil: 'domcontentloaded' });
    console.log('⏳ Waiting for you to log in (up to 3 minutes)...');

    const start = Date.now();
    const maxWaitMs = 180000;

    while (Date.now() - start < maxWaitMs) {
      await sleep(2000);
      const user = await isGogLoggedIn(page);
      if (user) {
        console.log(`🎉 Successfully authenticated on GOG as ${user}! Profile session saved.`);
        await sleep(2000);
        return { success: true, username: user };
      }
    }

    console.error('❌ GOG login timed out.');
    return { success: false, error: 'Login timed out' };
  } finally {
    await context.close();
  }
}

/**
 * Interactively logs into a new isolated GOG profile and registers it.
 */
export async function loginNewGogAccount() {
  console.log('➕ Adding new GOG account...');
  const { id, relPath, fullPath } = createNewProfileDir('gog');
  const result = await loginGog({ profileDir: fullPath });
  if (!result.success) {
    return result;
  }
  const username = result.username || `GOG User (${id.slice(-4)})`;
  const account = registerAccount('gog', { id, username, profileDir: relPath });
  return { success: true, account };
}

/**
 * Switches GOG account by logging out and prompting new sign-in.
 */
export async function switchGogAccount() {
  console.log('🔄 Switching GOG account...');
  const context = await launchGogBrowser({ headless: false });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await context.clearCookies();
    await page.goto('https://www.gog.com/en/logout', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2000);
    return await loginGog();
  } finally {
    await context.close();
  }
}

/**
 * Detects whether an active giveaway is available on the GOG homepage.
 * Extracts title, high-resolution thumbnail, and library ownership state.
 */
export async function checkGogGiveaway(page) {
  try {
    const banner = page.locator('#giveaway');
    if (await banner.count() === 0 || !(await banner.first().isVisible())) {
      return { active: false };
    }

    const bannerText = (await banner.first().innerText()).trim();

    // 1. Title matching from banner text
    let title = null;
    const match = bannerText.match(/Claim (.*?) and/i) 
      || bannerText.match(/Success!\s*(.*?)\s*was added to/i)
      || bannerText.match(/(.*?) is free/i);
    if (match) title = match[1].trim();

    // 2. Link & fallback title from URL slug
    let link = null;
    try {
      link = await banner.locator('a.giveaway__overlay-link, a').first().getAttribute('href');
      if (!title && link) {
        const slugMatch = link.match(/\/game\/([a-zA-Z0-9_-]+)/);
        if (slugMatch) {
          title = slugMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
      }
    } catch {}

    if (!title) title = 'GOG Promotional Freebie';

    // 3. Extract cover thumbnail from picture sources
    let thumbnail = null;
    try {
      const sources = await banner.locator('source').elementHandles();
      for (const s of sources) {
        const srcset = await s.getAttribute('srcset');
        if (srcset && (srcset.includes('.jpg') || srcset.includes('.webp') || srcset.includes('.png'))) {
          thumbnail = srcset.split(',')[0].split(' ')[0].trim();
          if (thumbnail) break;
        }
      }
    } catch {}

    let isAlreadyClaimed = bannerText.toLowerCase().includes('was added to your library') 
      || bannerText.toLowerCase().includes('in library');

    // Also verify against the user's real GOG account library
    if (title) {
      try {
        const searchUrl = `https://www.gog.com/account/getFilteredProducts?mediaType=1&search=${encodeURIComponent(title)}`;
        const libRes = await page.request.get(searchUrl, { timeout: 6000 });
        if (libRes.ok()) {
          const libData = await libRes.json();
          if (libData && libData.totalProducts > 0 && Array.isArray(libData.products)) {
            const cleanTarget = title.toLowerCase().replace(/[^a-z0-9]/g, '');
            const found = libData.products.some(p => {
              const cleanTitle = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const cleanSlug = (p.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanTitle === cleanTarget || cleanSlug === cleanTarget;
            });
            if (found) isAlreadyClaimed = true;
          }
        }
      } catch {}
    }

    return {
      active: true,
      title,
      thumbnail,
      url: link || 'https://www.gog.com/en',
      isAlreadyClaimed,
      text: bannerText.slice(0, 150),
    };
  } catch (err) {
    return { active: false, error: err.message };
  }
}

/**
 * Checks whether a game title exists in the user's real GOG account library.
 */
export async function isGameInGogLibrary(gameTitle, { profileDir } = {}) {
  if (!gameTitle) return false;
  const context = await launchGogBrowser({ headless: true, profileDir });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    const url = `https://www.gog.com/account/getFilteredProducts?mediaType=1&search=${encodeURIComponent(gameTitle)}`;
    const res = await page.request.get(url, { timeout: 8000 });
    if (res.ok()) {
      const data = await res.json();
      if (data && data.totalProducts > 0 && Array.isArray(data.products)) {
        const cleanTarget = gameTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
        return data.products.some(p => {
          const cleanTitle = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const cleanSlug = (p.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return cleanTitle === cleanTarget || cleanSlug === cleanTarget;
        });
      }
    }
  } catch (err) {
    console.warn('GOG library check error:', err.message);
  } finally {
    await context.close();
  }
  return false;
}

/**
 * Claims current active GOG giveaway.
 */
export async function claimGog({ headless = true, logger = console.log, accountId = null, username = null } = {}) {
  logger(`\n========================================`);
  logger(`🎮 [GOG.COM] Checking for Giveaways...`);

  const context = await launchGogBrowser({ headless });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    await page.goto(GOG_CONFIG.HOME_URL, { waitUntil: 'domcontentloaded', timeout: GOG_CONFIG.TIMEOUT });
    await sleep(3500);

    const giveaway = await checkGogGiveaway(page);
    if (!giveaway.active) {
      logger('ℹ️ No active time-limited giveaway on GOG right now.');
      return { status: 'no_giveaway' };
    }

    logger(`🎁 Active GOG Giveaway detected: "${giveaway.title}"`);

    if (giveaway.isAlreadyClaimed) {
      logger(`✅ "${giveaway.title}" is already in your GOG library!`);
      const history = loadHistory();
      recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'in_library', accountId, username);
      return { status: 'already_claimed', title: giveaway.title };
    }

    const user = await isGogLoggedIn(page);
    if (!user) {
      logger('⚠️ Found GOG giveaway, but you are not signed into GOG.');
      logger('👉 Click "Connect" next to GOG to sign into your GOG account.');
      return { status: 'unauthorized', title: giveaway.title };
    }

    logger(`👤 Signed into GOG as: ${user}`);
    logger('👉 Claiming GOG giveaway...');

    await page.goto(GOG_CONFIG.CLAIM_URL, { waitUntil: 'domcontentloaded', timeout: GOG_CONFIG.TIMEOUT });
    await sleep(2000);

    const bodyText = (await page.innerText('body')).trim();
    let resultJson = {};
    try {
      resultJson = JSON.parse(bodyText);
    } catch {}

    const history = loadHistory();

    if (bodyText === '{}' || bodyText === '') {
      logger(`🎉 SUCCESS: Successfully claimed "${giveaway.title}" on GOG!`);
      recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'claimed', accountId, username);
      sendNotification('GOG Freebie Claimed!', `Successfully claimed "${giveaway.title}" on GOG!`);
      return { status: 'claimed', title: giveaway.title };
    } else if (resultJson.message === 'Already claimed') {
      logger(`✅ "${giveaway.title}" is already in your GOG library!`);
      recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'in_library', accountId, username);
      return { status: 'already_claimed', title: giveaway.title };
    } else if (resultJson.message === 'Unauthorized') {
      logger('❌ GOG reported Unauthorized. Please re-authenticate.');
      return { status: 'unauthorized', title: giveaway.title };
    } else {
      logger(`ℹ️ GOG claim response: ${bodyText}`);
      return { status: 'response', message: bodyText, title: giveaway.title };
    }
  } catch (err) {
    logger(`❌ GOG error: ${err.message}`);
    return { status: 'error', error: err.message };
  } finally {
    await context.close();
  }
}
