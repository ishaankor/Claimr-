import { chromium } from 'playwright';
import path from 'path';
import { CONFIG } from './config.js';
import { loadHistory, recordClaim } from './history.js';
import { sendNotification } from './notify.js';
import { getActiveProfileDir, getFullProfileDir, createNewProfileDir, registerAccount } from './accounts.js';
import { launchBrowserContext } from './browser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const GOG_CONFIG = {
  get PROFILE_DIR() {
    return path.join(CONFIG.DATA_DIR, '.profile-gog');
  },
  HOME_URL: 'https://www.gog.com/en',
  LOGIN_URL: 'https://login.gog.com/auth?client_id=46755278331571209&layout=default&brand=gog&response_type=code&redirect_uri=https%3A%2F%2Fwww.gog.com%2Fon_login_success%3FreturnTo%3D%2Fen',
  CLAIM_URL: 'https://www.gog.com/giveaway/claim',
  TIMEOUT: 30000,
};

/**
 * Launches persistent browser context for GOG.
 */
export async function launchGogBrowser({ headless = false, profileDir, log } = {}) {
  const targetDir = profileDir ? getFullProfileDir(profileDir, 'gog') : getActiveProfileDir('gog');
  const context = await launchBrowserContext(targetDir, {
    headless,
    viewport: { width: 1366, height: 850 },
    locale: 'en-US',
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
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

    const usernameLoc = page.locator('#menuUsername, a.menu-link[href*="account"], .menu-item--username, [data-menu-username]');
    if (await usernameLoc.count() > 0 && await usernameLoc.first().isVisible()) {
      const username = (await usernameLoc.first().innerText()).trim();
      if (username) return username;
    }
  } catch {}

  // 3. Fallback: check context cookies for gog_us/login tokens
  try {
    const cookies = await page.context().cookies('https://www.gog.com');
    const hasAuth = cookies.some(c => c.name === 'gog_us' || c.name === 'gog_lc' || c.name === 'login-token');
    if (hasAuth && !page.url().includes('www.gog.com')) {
      await page.goto('https://www.gog.com/en', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1500);
      const res = await page.request.get('https://www.gog.com/userData.json', { timeout: 6000 });
      if (res.ok()) {
        const data = await res.json();
        if (data && data.isLoggedIn && data.username) {
          return data.username;
        }
      }
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

      // Auto-navigate to store if on callback or success page
      const currentUrl = page.url();
      if (currentUrl.includes('on_login_success') || currentUrl.includes('/auth/success') || currentUrl.includes('/en/account')) {
        console.log('🔄 GOG login detected! Finalizing session on store...');
        await page.goto(GOG_CONFIG.HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(1500);
      }

      // If user finished login on login.gog.com, navigate to www.gog.com
      const cookies = await context.cookies();
      const hasAuthCookie = cookies.some(c => 
        (c.name === 'gog_us' || c.name === 'gog_lc' || c.name === 'login-token' || c.name === 'gog-al') &&
        c.domain.includes('gog.com')
      );
      if (hasAuthCookie && page.url().includes('login.gog.com')) {
        console.log('🔄 Auth session detected on login subdomain. Navigating to www.gog.com...');
        await page.goto(GOG_CONFIG.HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(1500);
      }

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
 * Ultra-fast SSR HTML fetcher for GOG giveaways (~400ms).
 * Avoids spawning a heavy Chromium instance unless strictly necessary.
 */
export async function fetchGogGiveawayFast() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://www.gog.com/en', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const html = await res.text();

    const giveawayIdx = html.indexOf('id="giveaway"');
    if (giveawayIdx === -1) {
      return { active: false };
    }

    const snippet = html.substring(giveawayIdx, giveawayIdx + 8000);
    const linkMatch = snippet.match(/href=["'](https:\/\/www\.gog\.com\/[a-z]{2}\/game\/[a-zA-Z0-9_-]+|https:\/\/www\.gog\.com\/game\/[a-zA-Z0-9_-]+|\/game\/[a-zA-Z0-9_-]+)/i);
    const altMatch = snippet.match(/alt=["'](.*?)(\s+giveaway)?["']/i);
    const imgMatch = snippet.match(/srcset=["']([^"']+)["']/i);

    let title = null;
    if (altMatch && altMatch[1]) {
      title = altMatch[1].replace(/\s+giveaway/i, '').trim();
    }

    let link = linkMatch ? (linkMatch[1].startsWith('/') ? `https://www.gog.com${linkMatch[1]}` : linkMatch[1]) : null;

    if (!title && link) {
      const slugMatch = link.match(/\/game\/([a-zA-Z0-9_-]+)/);
      if (slugMatch) {
        title = slugMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }

    if (!title && !link) {
      return { active: false };
    }

    let thumbnail = null;
    if (imgMatch) {
      thumbnail = imgMatch[1].split(',')[0].split(' ')[0].trim();
    }

    return {
      active: true,
      title: title || 'GOG Promotional Freebie',
      thumbnail: thumbnail || 'https://images.gog-statics.com/948360d0e110622fdbdab367732dc1a3004fd51bad991bada0e95a1f9acb8ccf_giveaway_465w.jpg',
      url: link || 'https://www.gog.com/en',
      isAlreadyClaimed: false,
    };
  } catch {
    return null;
  }
}

/**
 * Fast giveaway retriever: uses fast HTTP fetch first, falls back to headless browser only if necessary.
 */
export async function getGogGiveawayFastOrBrowser() {
  const fast = await fetchGogGiveawayFast();
  if (fast) return fast;

  try {
    const gogContext = await launchGogBrowser({ headless: true });
    const gogPage = gogContext.pages().length > 0 ? gogContext.pages()[0] : await gogContext.newPage();
    await gogPage.goto('https://www.gog.com/en', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await new Promise(r => setTimeout(r, 1000));
    const giveaway = await checkGogGiveaway(gogPage);
    await gogContext.close();
    return giveaway;
  } catch (e) {
    console.warn('GOG check notice:', e.message);
    return { active: false, error: e.message };
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
export async function claimGog({ headless = true, logger = console.log, accountId = null, username = null, profileDir = null } = {}) {
  logger(`\n========================================`);
  logger(`🎮 [GOG.COM] Checking for Giveaways...`);

  const context = await launchGogBrowser({ headless, profileDir });
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
