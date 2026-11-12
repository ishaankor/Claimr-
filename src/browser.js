import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { getDataDir } from './config.js';

const require = createRequire(import.meta.url);
const activeProfileLocks = new Map();

const STEALTH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];

let cachedStealthScripts = null;

function getStealthEvasionScripts() {
  if (cachedStealthScripts) return cachedStealthScripts;
  const scripts = [];
  try {
    const createStealthPlugin = require('puppeteer-extra-plugin-stealth');
    const stealth = createStealthPlugin();
    const mockPage = {
      evaluateOnNewDocument: (fn, ...args) => {
        scripts.push({ fn, args });
      }
    };
    for (const name of stealth.enabledEvasions) {
      // 1. NEVER override native Chrome User-Agent & Client Hints
      if (name === 'user-agent-override') continue;
      // 2. NEVER proxy WebGL getParameter: Arkose Labs (Epic login & checkout) explicitly
      // checks WebGLRenderingContext.prototype.getParameter.toString().includes('[native code]')
      // and fails submission with "Incorrect response. Please refresh the page."
      if (name === 'webgl.vendor') continue;
      // 3. Do not override navigator.webdriver with synthetic getters
      if (name === 'navigator.webdriver') continue;

      try {
        const evasion = require(`puppeteer-extra-plugin-stealth/evasions/${name}`)();
        if (typeof evasion.onPageCreated === 'function') {
          evasion.onPageCreated(mockPage);
        }
      } catch {}
    }
  } catch {}
  cachedStealthScripts = scripts;
  return cachedStealthScripts;
}

/**
 * Injects anti-bot and stealth scripts into the browser context.
 * Masks automation fingerprints in headless mode while strictly preserving
 * native prototypes ([native code]) so Arkose Labs and Cloudflare do not flag tampering.
 * 
 * @param {BrowserContext} context
 * @param {boolean} [isHeadless=false]
 */
export async function applyStealthScripts(context, isHeadless = false) {
  // If running in headed / interactive mode (e.g. login), Google Chrome is already 100% genuine.
  // DO NOT inject synthetic scripts or delete prototype descriptors, as Arkose Labs detects tampering.
  if (!isHeadless) return;

  const evasions = getStealthEvasionScripts();
  for (const { fn, args } of evasions) {
    try {
      await context.addInitScript(fn, ...args);
    } catch {}
  }

  // Clean anti-bot evasion for headless mode only
  await context.addInitScript(() => {
    // 1. Ensure window.chrome exists in headless mode
    try {
      if (!window.chrome) {
        window.chrome = {
          app: { isInstalled: false },
          csi: () => {},
          loadTimes: () => {},
        };
      }
    } catch (e) {}

    // 2. Ensure screen dimensions are realistic in headless mode
    try {
      if (window.outerWidth === 0 && window.outerHeight === 0) {
        window.outerWidth = 1366;
        window.outerHeight = 850;
      }
    } catch (e) {}
  });
}

/**
 * Detects if a page is currently gated by Cloudflare Turnstile / "Just a moment..." challenge.
 * In visible mode, prompts and waits for the user to complete verification directly in the browser.
 * 
 * @param {Page} page
 * @param {Function} [logger]
 * @param {number} [maxWaitSec=90]
 * @returns {Promise<boolean>} Whether the challenge was cleared
 */
export async function waitForCloudflareResolution(page, logger = console.log, maxWaitSec = 90) {
  try {
    const checkStatus = async () => {
      const title = (await page.title().catch(() => '')) || '';
      const url = (page.url() || '').toLowerCase();
      const isChallenge = title.includes('Just a moment') ||
                          title.includes('One more step') ||
                          url.includes('challenges.cloudflare.com') ||
                          url.includes('/cdn-cgi/challenge-platform');
      return { isChallenge, title, url };
    };

    const initial = await checkStatus();
    if (!initial.isChallenge) {
      return true;
    }

    logger?.('🛡️ Cloudflare security check detected. Please complete the verification in the opened browser window...');

    // Bring window to front so the user sees the challenge
    await bringWindowToForeground(page).catch(() => {});

    for (let t = 0; t < maxWaitSec; t++) {
      await new Promise((r) => setTimeout(r, 1000));
      const status = await checkStatus();
      // Only consider it cleared once NOT in a challenge, title is non-empty, and back on the store page
      if (!status.isChallenge && status.title.trim().length > 0 && !status.url.includes('challenges.cloudflare.com')) {
        logger?.('✅ Cloudflare security check cleared!');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/**
 * Repositions an offscreen browser window back onto the primary screen
 * so the user can interactively complete a captcha or challenge if needed.
 */
export async function bringWindowToForeground(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    if (windowId) {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', left: 100, top: 100, width: 1280, height: 800 }
      });
    }
  } catch {}

  try {
    await page.bringToFront().catch(() => {});
  } catch {}

  if (process.platform === 'darwin') {
    try {
      execFile('osascript', ['-e', 'tell application "System Events" to set frontmost of (first process whose name contains "Google Chrome" or name contains "Chromium" or name contains "Electron") to true'], () => {});
    } catch {}
  }
}

let browserInstallPromise = null;

/**
 * Resolves the optimal browser launch options for the user's environment.
 * 
 * Order of preference:
 * 1. Pre-installed Playwright Chromium (if developer or previously downloaded)
 * 2. System Google Chrome (channel: 'chrome')
 * 3. System Microsoft Edge (channel: 'msedge' - pre-installed on Windows 10/11)
 * 4. Automatic one-time background download of Chromium + Headless Shell
 * 
 * @param {Function} [log] - Optional logger function for UI status feedback
 * @returns {Promise<Object>} Launch options to pass into chromium.launchPersistentContext()
 */
export async function resolveBrowserOptions(log = console.log) {
  // If an engine installation is currently in flight, wait for it
  if (browserInstallPromise) {
    log?.('[Browser] Waiting for browser engine installation to complete...');
    const inFlightResult = await browserInstallPromise.catch(() => null);
    if (inFlightResult && (inFlightResult.channel || inFlightResult.executablePath)) {
      return inFlightResult;
    }
  }

  // 1. Check system browsers via Playwright registry first (Google Chrome or Microsoft Edge)
  // System browsers have authentic hardware GPU acceleration, avoid SwiftShader, and match real OS fingerprints.
  try {
    const { registry } = require('playwright-core/lib/coreBundle');
    const reg = registry.registry;

    // Try system Google Chrome first (best compatibility & real hardware GPU)
    try {
      const chromePath = reg.findExecutable('chrome')?.executablePathOrDie('javascript');
      if (chromePath && fs.existsSync(chromePath)) {
        log?.('[Browser] Using system Google Chrome.');
        return { channel: 'chrome' };
      }
    } catch (e) {
      // Chrome not installed
    }

    // Try system Microsoft Edge (pre-installed on Windows 10 & 11)
    try {
      const edgePath = reg.findExecutable('msedge')?.executablePathOrDie('javascript');
      if (edgePath && fs.existsSync(edgePath)) {
        log?.('[Browser] Using system Microsoft Edge.');
        return { channel: 'msedge' };
      }
    } catch (e) {
      // Edge not installed
    }

    // Try system Linux browsers (Google Chrome, Chromium, snap Chromium)
    if (process.platform === 'linux') {
      const linuxCandidates = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
      ];
      for (const bin of linuxCandidates) {
        if (fs.existsSync(bin)) {
          log?.(`[Browser] Using system Linux browser: ${bin}`);
          return { executablePath: bin };
        }
      }
    }
  } catch (e) {
    // Registry lookup failed
  }

  // 2. Check if Playwright Chromium already exists in user's cache
  try {
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      // Use chrome-for-testing channel so Playwright executes full chromium in both headed and headless modes
      return { channel: 'chrome-for-testing' };
    }
  } catch (e) {
    // Playwright executable not found or thrown
  }

  // 3. If neither system browser nor Playwright Chromium is present, download Chromium
  return await ensurePlaywrightBrowser(log);
}

/**
 * Proactively verifies and installs the Playwright Chromium browser engine on startup.
 * Automatically runs on first launch so users never encounter missing executable errors.
 */
export async function ensurePlaywrightBrowser(log = console.log) {
  if (browserInstallPromise) {
    return browserInstallPromise;
  }

  browserInstallPromise = (async () => {
    try {
      const { registry } = require('playwright-core/lib/coreBundle');
      const reg = registry.registry;

      // 1. Check system Chrome
      try {
        const chromePath = reg.findExecutable('chrome')?.executablePathOrDie('javascript');
        if (chromePath && fs.existsSync(chromePath)) {
          log?.('[Browser] System Google Chrome detected.');
          return { channel: 'chrome' };
        }
      } catch {}

      // 2. Check system Edge
      try {
        const edgePath = reg.findExecutable('msedge')?.executablePathOrDie('javascript');
        if (edgePath && fs.existsSync(edgePath)) {
          log?.('[Browser] System Microsoft Edge detected.');
          return { channel: 'msedge' };
        }
      } catch {}

      // 3. Check Linux system binaries
      if (process.platform === 'linux') {
        const linuxCandidates = [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
        ];
        for (const bin of linuxCandidates) {
          if (fs.existsSync(bin)) {
            log?.(`[Browser] System Linux browser detected: ${bin}`);
            return { executablePath: bin };
          }
        }
      }

      // 4. Check if Playwright Chromium already exists
      try {
        const execPath = chromium.executablePath();
        if (execPath && fs.existsSync(execPath)) {
          return { channel: 'chrome-for-testing' };
        }
      } catch {}

      // 5. Download both chromium and chromium-headless-shell so any launch mode works
      log?.('⏳ [Browser] First-time setup: downloading browser engine...');
      await registry.installBrowsersForNpmInstall(['chromium', 'chromium-headless-shell']);
      log?.('✅ [Browser] Browser engine ready for claiming.');
      return { channel: 'chrome-for-testing' };
    } catch (err) {
      log?.(`⚠️ [Browser] Browser engine setup note: ${err.message}. Attempting default launch...`);
      return {};
    } finally {
      browserInstallPromise = null;
    }
  })();

  return browserInstallPromise;
}

/**
 * Normalizes any profile directory to a valid absolute path under the Claimr data directory.
 * Strips erroneous root prefixes (like '/.profiles') caused by process.cwd() being root on macOS.
 * 
 * @param {string} [targetDir] 
 * @returns {string} Fully resolved absolute directory path
 */
export function normalizeProfileDir(targetDir) {
  if (!targetDir) {
    return path.join(getDataDir(), '.profile');
  }
  let cleanDir = targetDir;
  if (typeof cleanDir === 'string' && (cleanDir.startsWith('/.profile') || cleanDir.startsWith('\\.profile'))) {
    cleanDir = cleanDir.replace(/^[/\\]+/, '');
  }
  if (path.isAbsolute(cleanDir)) {
    return cleanDir;
  }
  return path.resolve(getDataDir(), cleanDir);
}

/**
 * Launches a persistent browser context with automatic fallback and self-healing.
 * Injects anti-bot stealth hooks and disables automation flags so Cloudflare Turnstile
 * does not block login.
 * 
 * @param {string} targetDir - User profile directory
 * @param {Object} options - Browser launch options
 * @param {Function} [log] - Logger function
 * @returns {Promise<BrowserContext>}
 */
export async function launchBrowserContext(targetDir, options = {}, log = console.log) {
  const resolvedDir = normalizeProfileDir(targetDir);

  // Ensure directory exists on disk before Chromium launch
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch (err) {
    log?.(`[Browser] Profile directory notice: ${err.message}`);
  }

  const browserOpts = await resolveBrowserOptions(log);

  const isHeadless = !!options.headless;

  const mergedArgs = Array.from(new Set([
    ...(options.args || []),
    ...STEALTH_ARGS,
    ...(isHeadless ? ['--headless=new'] : []),
  ]));

  const launchConfig = {
    viewport: { width: 1366, height: 768 },
    ...browserOpts,
    ...options,
    headless: isHeadless,
    args: mergedArgs,
    ignoreDefaultArgs: [
      '--enable-automation',
      '--enable-unsafe-swiftshader',
      ...(process.platform !== 'linux' ? ['--no-sandbox'] : [])
    ],
  };

  // Only override userAgent if explicitly requested by caller.
  // Otherwise, allow system Chrome / Edge / Chromium to use its genuine native
  // User-Agent and matching Client Hints (Sec-CH-UA) to avoid anti-bot fingerprint mismatches.
  if (options.userAgent) {
    launchConfig.userAgent = options.userAgent;
  }

  if (resolvedDir) {
    while (activeProfileLocks.has(resolvedDir)) {
      await activeProfileLocks.get(resolvedDir);
    }
  }

  let release;
  if (resolvedDir) {
    const lockPromise = new Promise(r => { release = r; });
    activeProfileLocks.set(resolvedDir, lockPromise);
  }

  // Clean up any stale Chromium process locks in profile directory to prevent ProcessSingleton crashes
  if (resolvedDir) {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const lock of lockFiles) {
      try {
        fs.unlinkSync(path.join(resolvedDir, lock));
      } catch {}
    }
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(resolvedDir, launchConfig);
  } catch (err) {
    const isMissingExec = err.message && (
      err.message.includes("Executable doesn't exist") ||
      err.message.includes('run the following command') ||
      err.message.includes('Failed to launch')
    );

    if (isMissingExec) {
      log?.('⏳ [Browser] Browser engine missing. Automatically installing Chromium...');
      try {
        const { registry } = require('playwright-core/lib/coreBundle');
        await registry.installBrowsersForNpmInstall(['chromium', 'chromium-headless-shell']);
        log?.('✅ [Browser] Chromium engine successfully installed! Launching browser...');
        
        const fallbackOpts = {
          ...options,
          channel: 'chrome-for-testing',
          args: mergedArgs,
          ignoreDefaultArgs: ['--enable-automation'],
        };
        context = await chromium.launchPersistentContext(resolvedDir, fallbackOpts);
      } catch (installErr) {
        if (release) {
          activeProfileLocks.delete(resolvedDir);
          release();
        }
        log?.(`[Browser] Auto-install failed: ${installErr.message}`);
        throw installErr;
      }
    } else {
      if (release) {
        activeProfileLocks.delete(resolvedDir);
        release();
      }
      throw err;
    }
  }

  // Intercept context.close to safely persist cookies, release profile lock and clean up Singleton files
  const originalClose = context.close.bind(context);
  context.close = async (...args) => {
    try {
      if (resolvedDir) {
        try {
          const freshCookies = await context.cookies().catch(() => []);
          if (Array.isArray(freshCookies) && freshCookies.length > 0) {
            fs.writeFileSync(path.join(resolvedDir, 'cookies.json'), JSON.stringify(freshCookies, null, 2), 'utf-8');
          }
        } catch {}
      }
      return await originalClose(...args);
    } finally {
      if (release) {
        if (resolvedDir) {
          const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
          for (const lock of lockFiles) {
            try { fs.unlinkSync(path.join(resolvedDir, lock)); } catch {}
          }
          activeProfileLocks.delete(resolvedDir);
        }
        release();
      }
    }
  };

  // Hydrate session cookies from cookies.json if present (e.g. from native Electron login)
  if (resolvedDir) {
    const cookiesFile = path.join(resolvedDir, 'cookies.json');
    if (fs.existsSync(cookiesFile)) {
      try {
        const raw = fs.readFileSync(cookiesFile, 'utf-8');
        const cookies = JSON.parse(raw);
        if (Array.isArray(cookies) && cookies.length > 0) {
          const now = Date.now() / 1000;
          const valid = cookies.filter((c) => !c.expires || c.expires === -1 || c.expires > now);
          if (valid.length > 0) {
            await context.addCookies(valid);
            log?.(`[Browser] Hydrated ${valid.length} session cookies from cookies.json`);
          }
        }
      } catch (err) {
        log?.(`[Browser] Notice reading cookies.json: ${err.message}`);
      }
    }
  }

  // Inject stealth and anti-bot evasions into all pages in this context
  await applyStealthScripts(context, isHeadless);
  context._isHeadless = isHeadless;
  return context;
}
