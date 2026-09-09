import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const activeProfileLocks = new Map();

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];

/**
 * Injects anti-bot and stealth scripts into the browser context.
 * Masks automation fingerprints including navigator.webdriver, window.chrome,
 * and navigator.plugins that cause Cloudflare Turnstile to block or loop.
 * 
 * @param {BrowserContext} context
 */
export async function applyStealthScripts(context) {
  await context.addInitScript(() => {
    // 1. Cleanly mask navigator.webdriver on Navigator.prototype if present
    try {
      if (navigator.webdriver) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
          get: () => false,
          configurable: true,
        });
      }
    } catch (e) {}

    // 2. Remove HeadlessChrome from navigator.userAgent if present
    try {
      if (navigator.userAgent && navigator.userAgent.includes('HeadlessChrome')) {
        const cleanUA = navigator.userAgent.replace('HeadlessChrome', 'Chrome');
        Object.defineProperty(Object.getPrototypeOf(navigator), 'userAgent', {
          get: () => cleanUA,
          configurable: true,
        });
      }
    } catch (e) {}

    // 3. Ensure window.chrome runtime exists cleanly without injecting deprecated/fake methods
    try {
      if (!window.chrome) {
        window.chrome = {};
      }
    } catch (e) {}
  });
}

/**
 * Automatically detects and solves Cloudflare Turnstile if present on the page.
 * 
 * @param {Page} page
 * @param {Function} [logger]
 * @returns {Promise<boolean>} Whether a challenge was handled
 */
export async function handleCloudflareTurnstile(page, logger = console.log) {
  try {
    const frames = page.frames();
    for (const frame of frames) {
      const url = frame.url();
      if (url.includes('challenges.cloudflare.com') || url.includes('turnstile') || url.includes('cloudflare.com/cdn-cgi')) {
        const checkbox = frame.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, div.checkbox');
        if (await checkbox.count() > 0) {
          const firstBox = checkbox.first();
          if (await firstBox.isVisible()) {
            logger?.('   🛡️ Cloudflare verification detected. Completing security check...');
            await new Promise((r) => setTimeout(r, 1500));
            await firstBox.click({ force: true });
            await new Promise((r) => setTimeout(r, 2500));
            return true;
          }
        }
      }
    }
  } catch (e) {
    // Non-critical, ignore
  }
  return false;
}

/**
 * Resolves the optimal browser launch options for the user's environment.
 * 
 * Order of preference:
 * 1. Pre-installed Playwright Chromium (if developer or previously downloaded)
 * 2. System Google Chrome (channel: 'chrome')
 * 3. System Microsoft Edge (channel: 'msedge' - pre-installed on Windows 10/11)
 * 4. Automatic one-time background download of Chromium
 * 
 * @param {Function} [log] - Optional logger function for UI status feedback
 * @returns {Promise<Object>} Launch options to pass into chromium.launchPersistentContext()
 */
export async function resolveBrowserOptions(log = console.log) {
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
  } catch (e) {
    // Registry lookup failed
  }

  // 2. Check if Playwright Chromium already exists in user's cache
  try {
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      return {};
    }
  } catch (e) {
    // Playwright executable not found or thrown
  }

  // 3. If neither system Chrome/Edge nor Playwright Chromium is present, download Chromium
  try {
    const { registry } = require('playwright-core/lib/coreBundle');
    log?.('[Browser] Initializing browser engine for first-time setup (one-time download)...');
    await registry.installBrowsersForNpmInstall(['chromium']);
    log?.('[Browser] Browser engine ready.');
    return {};
  } catch (err) {
    log?.(`[Browser] Engine detection note: ${err.message}. Attempting default launch...`);
    return {};
  }
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
  const browserOpts = await resolveBrowserOptions(log);

  const defaultUserAgent = process.platform === 'darwin'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    : (process.platform === 'win32'
      ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');

  const userAgent = options.userAgent || defaultUserAgent;

  const mergedArgs = Array.from(new Set([
    `--user-agent=${userAgent}`,
    ...(options.args || []),
    ...STEALTH_ARGS,
  ]));

  const launchConfig = {
    ...browserOpts,
    userAgent,
    ...options,
    args: mergedArgs,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  const resolvedDir = targetDir ? path.resolve(targetDir) : null;
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
    context = await chromium.launchPersistentContext(targetDir, launchConfig);
  } catch (err) {
    const isMissingExec = err.message && (
      err.message.includes("Executable doesn't exist") ||
      err.message.includes('run the following command') ||
      err.message.includes('Failed to launch')
    );

    if (isMissingExec) {
      log?.('[Browser] Browser executable missing. Automatically installing Chromium engine...');
      try {
        const { registry } = require('playwright-core/lib/coreBundle');
        await registry.installBrowsersForNpmInstall(['chromium']);
        log?.('[Browser] Chromium engine successfully installed! Launching browser...');
        
        const fallbackOpts = {
          ...options,
          args: mergedArgs,
          ignoreDefaultArgs: ['--enable-automation'],
        };
        delete fallbackOpts.channel;
        context = await chromium.launchPersistentContext(targetDir, fallbackOpts);
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

  // Intercept context.close to safely release profile lock and clean up Singleton files
  if (release) {
    const originalClose = context.close.bind(context);
    context.close = async (...args) => {
      try {
        return await originalClose(...args);
      } finally {
        if (resolvedDir) {
          const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
          for (const lock of lockFiles) {
            try { fs.unlinkSync(path.join(resolvedDir, lock)); } catch {}
          }
          activeProfileLocks.delete(resolvedDir);
          release();
        }
      }
    };
  }

  // Inject stealth and anti-bot evasions into all pages in this context
  await applyStealthScripts(context);
  return context;
}
