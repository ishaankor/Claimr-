import { chromium } from 'playwright';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
  // 1. Check if Playwright Chromium already exists in user's cache
  try {
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      return {};
    }
  } catch (e) {
    // Playwright executable not found or thrown
  }

  // 2. Check system browsers via Playwright registry
  try {
    const { registry } = require('playwright-core/lib/coreBundle');
    const reg = registry.registry;

    // Try system Google Chrome
    try {
      const chromePath = reg.findExecutable('chrome')?.executablePathOrDie('javascript');
      if (chromePath && fs.existsSync(chromePath)) {
        log?.('[Browser] Using system Google Chrome.');
        return { channel: 'chrome' };
      }
    } catch (e) {
      // Chrome not installed
    }

    // Try system Microsoft Edge (built-in on Windows 10 & 11)
    try {
      const edgePath = reg.findExecutable('msedge')?.executablePathOrDie('javascript');
      if (edgePath && fs.existsSync(edgePath)) {
        log?.('[Browser] Using system Microsoft Edge.');
        return { channel: 'msedge' };
      }
    } catch (e) {
      // Edge not installed
    }

    // 3. If neither system Chrome nor Edge is present, automatically download Chromium
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
 * If the selected browser is missing or fails to launch, automatically downloads
 * Chromium in the background and retries.
 * 
 * @param {string} targetDir - User profile directory
 * @param {Object} options - Browser launch options
 * @param {Function} [log] - Logger function
 * @returns {Promise<BrowserContext>}
 */
export async function launchBrowserContext(targetDir, options = {}, log = console.log) {
  const browserOpts = await resolveBrowserOptions(log);
  const finalOptions = { ...browserOpts, ...options };

  try {
    return await chromium.launchPersistentContext(targetDir, finalOptions);
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
        
        const fallbackOpts = { ...options };
        delete fallbackOpts.channel;
        return await chromium.launchPersistentContext(targetDir, fallbackOpts);
      } catch (installErr) {
        log?.(`[Browser] Auto-install failed: ${installErr.message}`);
        throw installErr;
      }
    }
    throw err;
  }
}
