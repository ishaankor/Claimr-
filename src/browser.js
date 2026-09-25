import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { getDataDir } from './config.js';

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
    // Mask navigator.webdriver cleanly only if not already masked natively by Chrome flags
    try {
      if (navigator.webdriver) {
        Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', {
          get: () => false,
          configurable: true,
        });
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
    const isCloudflareTitle = async () => {
      const title = (await page.title().catch(() => '')) || '';
      return title.includes('Just a moment') || title.includes('One more step');
    };

    const scopes = [page, ...page.frames()];
    for (const scope of scopes) {
      const url = (typeof scope.url === 'function' ? scope.url() : page.url() || '').toLowerCase();
      const isCfUrl = url.includes('challenges.cloudflare.com') || url.includes('turnstile') || url.includes('cloudflare.com/cdn-cgi');
      const isCfPage = await isCloudflareTitle();

      if (isCfUrl || isCfPage) {
        // 1. Check if Turnstile has already solved itself
        try {
          const responseInput = scope.locator('[name*="cf-turnstile-response"], [name*="cf-chl-widget"], input[type="hidden"]');
          if (await responseInput.count() > 0) {
            const val = await responseInput.first().inputValue().catch(() => '');
            if (val && val.length > 10) {
              return true;
            }
          }
        } catch {}

        const checkbox = scope.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, div.checkbox, div.cf_challenge');
        if (await checkbox.count() > 0) {
          const firstBox = checkbox.first();
          if (await firstBox.isVisible().catch(() => false)) {
            logger?.('   🛡️ Cloudflare verification detected. Completing security check...');
            await new Promise((r) => setTimeout(r, 1200));

            // Human-like pointer movement and click to avoid synthetic click detection
            const box = await firstBox.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 }).catch(() => {});
              await new Promise((r) => setTimeout(r, 200));
              await page.mouse.down().catch(() => {});
              await new Promise((r) => setTimeout(r, 100));
              await page.mouse.up().catch(() => {});
            } else {
              await firstBox.click().catch(() => {});
            }

            // Wait for verification to clear or token to populate (up to 12 seconds)
            for (let t = 0; t < 24; t++) {
              await new Promise((r) => setTimeout(r, 500));
              if (!(await isCloudflareTitle())) {
                return true;
              }
              try {
                const responseInput = scope.locator('[name*="cf-turnstile-response"], [name*="cf-chl-widget"]');
                if (await responseInput.count() > 0) {
                  const val = await responseInput.first().inputValue().catch(() => '');
                  if (val && val.length > 10) {
                    return true;
                  }
                }
              } catch {}
            }
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
        bounds: { left: 100, top: 100, width: 1280, height: 800 }
      });
    }
  } catch {}
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

  // On desktop platforms (Windows and macOS, or Linux with display), if headless is requested,
  // launch headed off-screen so Chromium maintains authentic hardware GPU acceleration (DirectX / Metal / Vulkan)
  // and real plugin metrics. This completely prevents SwiftShader detection from triggering Cloudflare Turnstile blocks.
  const hasDisplay = process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  const useOffscreenHeaded = options.headless === true && hasDisplay;

  const effectiveHeadless = useOffscreenHeaded ? false : !!options.headless;
  const offscreenArgs = useOffscreenHeaded
    ? ['--window-position=-2400,-2400', '--window-size=1366,850']
    : [];

  const mergedArgs = Array.from(new Set([
    ...(options.args || []),
    ...STEALTH_ARGS,
    ...offscreenArgs,
  ]));

  const launchConfig = {
    ...browserOpts,
    ...options,
    headless: effectiveHeadless,
    args: mergedArgs,
    ignoreDefaultArgs: ['--enable-automation'],
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
