import { app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, Notification, powerMonitor, screen } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFile } from 'child_process';
import { getPromotions } from '../src/api.js';
import { loadHistory, isGameClaimed, recordClaim } from '../src/history.js';
import { launchBrowser, ensureLoggedIn, claimGame, getEpicUsername, loginNewEpicAccount, isGameInEpicLibrary, syncEpicLibraryForAccount } from '../src/claimer.js';
import { claimGog, loginGog, launchGogBrowser, isGogLoggedIn, checkGogGiveaway, loginNewGogAccount, isGameInGogLibrary, getGogGiveawayFastOrBrowser } from '../src/gog.js';
import { loadAccounts, getActiveAccount, setActiveAccount, removeAccount, registerAccount, getFullProfileDir, createNewProfileDir } from '../src/accounts.js';
import { setCustomNotifier, sendNotification } from '../src/notify.js';
import { ensurePlaywrightBrowser } from '../src/browser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

if (app.isPackaged) {
  process.env.CLAIMR_DATA_DIR = app.getPath('userData');
}

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';
app.commandLine.appendSwitch('disable-logging');
app.setName('Claimr');
app.name = 'Claimr';

// Anti-bot stealth configuration for native Electron Chromium instances
const chromeMajorVersion = (process.versions.chrome || '133').split('.')[0];
const chromeFullVersion = process.versions.chrome || '133.0.6943.142';

function getStealthUserAgent() {
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFullVersion} Safari/537.36`;
  } else if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFullVersion} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeFullVersion} Safari/537.36`;
}

const STEALTH_UA = getStealthUserAgent();
app.userAgentFallback = STEALTH_UA;

/**
 * Strips Electron and Claimr markers from request headers and User-Agent
 * so Cloudflare Turnstile and Arkose Labs see a genuine Google Chrome browser.
 */
function configureSessionStealth(ses) {
  ses.setUserAgent(STEALTH_UA);

  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      if (requestHeaders['User-Agent']) {
        requestHeaders['User-Agent'] = STEALTH_UA;
      }
      if (requestHeaders['sec-ch-ua']) {
        requestHeaders['sec-ch-ua'] = requestHeaders['sec-ch-ua']
          .replace(/"Electron";v="[^"]*"/g, `"Google Chrome";v="${chromeMajorVersion}"`)
          .replace(/"Claimr";v="[^"]*"/g, `"Google Chrome";v="${chromeMajorVersion}"`);
      }
      callback({ requestHeaders });
    });
  } catch (_) {}
}

let activeToastWindow = null;
let toastTimeout = null;

/**
 * Cross-platform floating notification banner with Claimr logo.
 * Bypasses macOS Gatekeeper / ad-hoc code-signing restrictions completely.
 * Always renders with Claimr branding, dark glassmorphic styling, and auto-dismissal.
 */
function showFloatingNotification(title, message) {
  try {
    if (activeToastWindow && !activeToastWindow.isDestroyed()) {
      clearTimeout(toastTimeout);
      try { activeToastWindow.destroy(); } catch (_) {}
      activeToastWindow = null;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { workArea } = primaryDisplay;
    const bannerWidth = 360;
    const bannerHeight = 84;
    const x = Math.round(workArea.x + workArea.width - bannerWidth - 16);
    const y = Math.round(workArea.y + 16);

    const toastWin = new BrowserWindow({
      width: bannerWidth,
      height: bannerHeight,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      show: false,
      backgroundColor: '#00000000',
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    activeToastWindow = toastWin;
    toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    toastWin.setAlwaysOnTop(true, 'floating');

    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    let iconSrc = '';
    if (fs.existsSync(iconPath)) {
      const b64 = fs.readFileSync(iconPath).toString('base64');
      iconSrc = `data:image/png;base64,${b64}`;
    }

    const safeTitle = String(title || 'Claimr')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeMsg = String(message || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 100%;
    background: rgba(18, 22, 34, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    padding: 10px 14px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(99, 102, 241, 0.2);
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .toast:hover {
    background: rgba(26, 32, 48, 0.98);
    border-color: rgba(99, 102, 241, 0.4);
  }
  .icon-box {
    width: 44px;
    height: 44px;
    min-width: 44px;
    border-radius: 10px;
    overflow: hidden;
    background: #0d1117;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .icon-box img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .content {
    flex: 1;
    min-width: 0;
  }
  .title {
    color: #ffffff;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .message {
    color: #94a3b8;
    font-size: 11.5px;
    line-height: 1.35;
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
</head>
<body>
  <div class="toast" onclick="window.location.href='claimr://open'">
    <div class="icon-box">
      ${iconSrc ? `<img src="${iconSrc}" />` : '🎮'}
    </div>
    <div class="content">
      <div class="title">${safeTitle}</div>
      <div class="message">${safeMsg}</div>
    </div>
  </div>
</body>
</html>`;

    toastWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    toastWin.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
      try { toastWin.destroy(); } catch (_) {}
      if (activeToastWindow === toastWin) activeToastWindow = null;
    });

    toastWin.once('ready-to-show', () => {
      if (!toastWin.isDestroyed()) {
        toastWin.showInactive();
      }
    });

    toastTimeout = setTimeout(() => {
      if (toastWin && !toastWin.isDestroyed()) {
        toastWin.destroy();
        if (activeToastWindow === toastWin) activeToastWindow = null;
      }
    }, 6000);
  } catch (err) {
    console.warn('Could not display floating notification banner:', err.message);
  }
}

setCustomNotifier((title, message) => {
  // 1. Audio chime (100% reliable, zero permissions required)
  if (process.platform === 'darwin') {
    execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
    if (app.dock) app.dock.bounce('informational');
  }

  // 2. Custom floating desktop banner with official Claimr icon (immune to Gatekeeper & code signing)
  showFloatingNotification(title, message);

  // 3. Best-effort native notification
  if (Notification.isSupported()) {
    try {
      const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
      const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
      const n = new Notification({
        title,
        body: message,
        icon,
      });
      n.show();
    } catch (_) {}
  }
});

let mainWindow = null;
let tray = null;
let isClaimingInProgress = false;
let isClaimAbortRequested = false;
let activeClaimWindow = null;
let activeClaimFinish = null;

function createWindow() {
  const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Claimr - Free Game Claimer',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(iconPath);
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  mainWindow.loadFile(path.join(ROOT_DIR, 'app', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    if (app.dock) app.dock.show();
    console.log('✅ Claimr dashboard is now active on your screen.');
  });

  mainWindow.webContents.on('console-message', (event) => {
    const msg = event?.message || event;
    if (typeof msg === 'string' && !msg.includes('Electron Security Warning') && !msg.includes('ERROR:net')) {
      console.log(`[Claimr UI] ${msg}`);
    }
  });

  mainWindow.on('close', (event) => {
    if (tray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      console.log('ℹ️ Claimr minimized to macOS menu bar tray.');
    }
  });
}

function createTray() {
  const trayIconPath = path.join(ROOT_DIR, 'assets', 'tray.png');
  let trayIcon = nativeImage.createFromPath(trayIconPath);
  if (!trayIcon.isEmpty()) {
    tray = new Tray(trayIcon);
  } else {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setTitle('🎮 Claimr');
  }
  tray.setToolTip('Claimr - Free Game Claimer');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Claim All Free Games Now',
      click: async () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('claim:trigger-ui');
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Claimr',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// -------------------------------------------------------------
// IPC Handlers
// -------------------------------------------------------------

ipcMain.handle('store:get-epic-games', async () => {
  try {
    const epicPromos = await getPromotions().catch(e => {
      console.warn('Epic promotions fetch notice:', e.message);
      return { currentFreeGames: [], upcomingFreeGames: [] };
    });

    const activeEpic = getActiveAccount('epic');
    if (activeEpic && Array.isArray(epicPromos?.currentFreeGames) && epicPromos.currentFreeGames.length > 0) {
      syncEpicLibraryForAccount(epicPromos.currentFreeGames, activeEpic).then(newlyOwned => {
        if (newlyOwned.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('library:updated');
        }
      }).catch(() => {});
    }

    return epicPromos;
  } catch (err) {
    console.error('Error fetching Epic games:', err);
    return { currentFreeGames: [], upcomingFreeGames: [] };
  }
});

ipcMain.handle('store:get-gog-game', async () => {
  try {
    const gogGiveaway = await getGogGiveawayFastOrBrowser();

    const history = loadHistory();
    const activeGog = getActiveAccount('gog');
    if (activeGog && gogGiveaway?.active && gogGiveaway?.isAlreadyClaimed) {
      recordClaim(history, { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' }, 'in_library', activeGog.id, activeGog.username);
    }

    return gogGiveaway;
  } catch (err) {
    console.error('Error fetching GOG giveaway:', err);
    return { active: false, error: err.message };
  }
});

ipcMain.handle('store:get-all-games', async () => {
  try {
    const [epicPromos, gogGiveaway] = await Promise.all([
      getPromotions().catch(e => {
        console.warn('Epic promotions fetch notice:', e.message);
        return { currentFreeGames: [], upcomingFreeGames: [] };
      }),
      getGogGiveawayFastOrBrowser(),
    ]);

    // Sync detected real library status into history
    const history = loadHistory();
    const activeGog = getActiveAccount('gog');
    if (activeGog && gogGiveaway?.active && gogGiveaway?.isAlreadyClaimed) {
      recordClaim(history, { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' }, 'in_library', activeGog.id, activeGog.username);
    }

    const activeEpic = getActiveAccount('epic');
    if (activeEpic && Array.isArray(epicPromos?.currentFreeGames) && epicPromos.currentFreeGames.length > 0) {
      syncEpicLibraryForAccount(epicPromos.currentFreeGames, activeEpic).then(newlyOwned => {
        if (newlyOwned.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('library:updated');
        }
      }).catch(() => {});
    }

    return {
      epic: epicPromos,
      gog: gogGiveaway,
    };
  } catch (err) {
    console.error('Error fetching games:', err);
    throw err;
  }
});

ipcMain.handle('store:check-auth', async (_event, opts = {}) => {
  if (opts && opts.fast) {
    const refreshedAccounts = loadAccounts();
    const activeEpic = getActiveAccount('epic');
    const activeGog = getActiveAccount('gog');
    return {
      epic: !!activeEpic,
      epicUsername: activeEpic?.username ?? null,
      epicAccounts: refreshedAccounts.epic?.accounts || [],
      epicActiveId: refreshedAccounts.epic?.activeId || null,

      gog: !!activeGog,
      gogUsername: activeGog?.username ?? null,
      gogAccounts: refreshedAccounts.gog?.accounts || [],
      gogActiveId: refreshedAccounts.gog?.activeId || null,
    };
  }

  let epicUser = null;
  let gogUser = null;

  // Epic check
  try {
    const activeEpic = getActiveAccount('epic');
    if (activeEpic) {
      const ses = session.fromPartition(`persist:epic_${activeEpic.id}`);
      const cookies = await ses.cookies.get({});
      const hasAuth = cookies.some((c) =>
        c.name === 'EPIC_BEARER_TOKEN' ||
        c.name === 'EPIC_SSO' ||
        c.name === 'EPIC_EG1' ||
        c.name === 'REFRESH_EPIC_EG1' ||
        c.name === 'EPIC_SSO_RM' ||
        c.name === 'EPIC_SESSION_AP' ||
        (c.name && c.name.startsWith('EPIC_RECEIPT_')) ||
        (c.name && c.name.startsWith('EPIC_AUTH_'))
      );
      if (hasAuth) {
        epicUser = activeEpic.username;
        try {
          const accRes = await ses.fetch('https://www.epicgames.com/id/api/account');
          if (accRes.ok) {
            const accData = await accRes.json();
            if (accData && accData.displayName) {
              epicUser = accData.displayName;
              registerAccount('epic', { ...activeEpic, username: accData.displayName });
            }
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('Epic auth check notice:', e.message);
  }

  // GOG check (Native Electron Session - 0ms Chromium spawn overhead)
  try {
    const activeGog = getActiveAccount('gog');
    if (activeGog) {
      const ses = session.fromPartition(`persist:gog_${activeGog.id}`);
      await hydrateGogSession(ses, activeGog);
      const res = await ses.fetch('https://www.gog.com/userData.json');
      if (res.ok) {
        const data = await res.json();
        if (data && data.isLoggedIn && data.username) {
          gogUser = data.username;
          registerAccount('gog', { ...activeGog, username: data.username });
        }
      }
    }
  } catch (e) {
    console.warn('GOG auth check notice:', e.message);
  }

  const refreshedAccounts = loadAccounts();

  return {
    epic: !!epicUser,
    epicUsername: epicUser || (getActiveAccount('epic')?.username ?? null),
    epicAccounts: refreshedAccounts.epic.accounts,
    epicActiveId: refreshedAccounts.epic.activeId,

    gog: !!gogUser,
    gogUsername: gogUser || (getActiveAccount('gog')?.username ?? null),
    gogAccounts: refreshedAccounts.gog.accounts,
    gogActiveId: refreshedAccounts.gog.activeId,
  };
});

ipcMain.handle('accounts:get', async () => {
  return loadAccounts();
});

ipcMain.handle('accounts:swap', async (_event, { store, accountId }) => {
  console.log(`🔄 Swapping active ${store} account to: ${accountId}`);
  const target = setActiveAccount(store, accountId);

  // Asynchronously verify real store library for the target account
  (async () => {
    try {
      if (store === 'gog' && target) {
        const gogGiveaway = await getGogGiveawayFastOrBrowser().catch(() => null);
        if (gogGiveaway?.active && gogGiveaway?.title) {
          const isOwned = await isGameInGogLibraryNative(gogGiveaway.title, target);
          if (isOwned) {
            const h = loadHistory();
            recordClaim(h, { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' }, 'in_library', target.id, target.username);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('library:updated');
            }
          }
        }
      } else if (store === 'epic' && target) {
        const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
        if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
          const newlyOwned = await syncEpicLibraryForAccount(currentFreeGames, target);
          if (newlyOwned.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }
        }
      }
    } catch (err) {
      console.warn('Real library check notice on swap:', err.message);
    }
  })();

  return { success: true, activeAccount: target, accounts: loadAccounts() };
});

ipcMain.handle('store:verify-real-library', async (_event, { store, accountId, title, url, id } = {}) => {
  try {
    const history = loadHistory();
    if (store === 'GOG' || store === 'gog') {
      const activeGog = accountId ? loadAccounts().gog.accounts.find(a => a.id === accountId) : getActiveAccount('gog');
      if (activeGog && title) {
        const isOwned = await isGameInGogLibraryNative(title, activeGog);
        if (isOwned) {
          recordClaim(history, { id: id || `gog_${title}`, title, slug: 'gog' }, 'in_library', activeGog.id, activeGog.username);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }
          return { isOwned: true };
        }
      }
    } else if (store === 'EPIC' || store === 'epic') {
      const activeEpic = accountId ? loadAccounts().epic.accounts.find(a => a.id === accountId) : getActiveAccount('epic');
      if (activeEpic) {
        const gameObj = {
          id: id || title,
          title: title,
          slug: url ? url.split('/p/')[1]?.split('/')[0]?.split('?')[0] || url.split('/').pop() : title,
          storeUrl: url,
        };
        let isOwned = false;
        try {
          const ses = session.fromPartition(`persist:epic_${activeEpic.id}`);
          const res = await ses.fetch('https://accounts.epicgames.com/account/v2/payment/ajaxGetOrderHistory?sortDir=DESC&sortBy=DATE&page=1');
          if (res.ok) {
            const data = await res.json();
            const orders = Array.isArray(data?.orders) ? data.orders : [];
            isOwned = orders.some(o => (o.items || []).some(item => {
              if (gameObj.id && item.offerId && item.offerId.toLowerCase() === gameObj.id.toLowerCase()) return true;
              if (gameObj.title && item.description && item.description.trim().toLowerCase() === gameObj.title.trim().toLowerCase()) return true;
              return false;
            }));
          }
        } catch (_) {}

        if (!isOwned) {
          isOwned = await isGameInEpicLibrary(gameObj, { profileDir: activeEpic.profileDir });
        }

        if (isOwned) {
          recordClaim(history, gameObj, 'in_library', activeEpic.id, activeEpic.username);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }
          return { isOwned: true };
        }
      }
    }
  } catch (e) {
    console.warn('Real library verify error:', e.message);
  }
  return { isOwned: false };
});

ipcMain.handle('store:sync-library', async () => {
  const history = loadHistory();
  const results = { epic: [], gog: [] };

  // 1. Sync active Epic account library
  const activeEpic = getActiveAccount('epic');
  if (activeEpic) {
    try {
      const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
      if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
        const newlyOwned = await syncEpicLibraryForAccount(currentFreeGames, activeEpic);
        results.epic = newlyOwned;
      }
    } catch (e) {
      console.warn('Sync Epic library error:', e.message);
    }
  }

  // 2. Sync active GOG account library
  const activeGog = getActiveAccount('gog');
  if (activeGog) {
    try {
      const gogGiveaway = await getGogGiveawayFastOrBrowser();
      if (gogGiveaway?.active && gogGiveaway?.title) {
        const isOwned = gogGiveaway.isAlreadyClaimed || await isGameInGogLibraryNative(gogGiveaway.title, activeGog);
        if (isOwned) {
          recordClaim(history, { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' }, 'in_library', activeGog.id, activeGog.username);
          results.gog.push(gogGiveaway.title);
        }
      }
    } catch (e) {
      console.warn('Sync GOG library error:', e.message);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('library:updated');
  }

  return results;
});

let activeEpicLoginWindow = null;

/**
 * Automatically detects and clicks the saved account card on Epic's "Welcome back" screen.
 * Employs multi-layer fallback:
 * 1. Finds element by email pattern or username and walks up to the card container.
 * 2. Finds element immediately above "Use another account" button.
 * 3. Finds item located between "Welcome back" heading and "or" divider.
 * 4. Dispatches both synthetic DOM events AND native Chromium OS mouse events (sendInputEvent) at exact coordinates.
 * 5. Scans both the main document and all sub-frames.
 */
async function tryClickWelcomeBackAccount(win, targetUsername = '', logger = console.log) {
  if (!win || win.isDestroyed()) return false;

  // Check if Epic displayed the "Something went wrong. Please refresh the page and check that you allow cookies" error
  try {
    const hasCookieError = await win.webContents.executeJavaScript(`
      (() => {
        const bodyText = (document.body ? document.body.innerText : '') || '';
        return bodyText.includes('Something went wrong') && bodyText.includes('allow cookies');
      })()
    `).catch(() => false);

    if (hasCookieError) {
      const ses = win.webContents.session;
      const cookies = await ses.cookies.get({});
      for (const c of cookies) {
        if (c.name === 'XSRF-TOKEN' || c.name === 'EPIC_CLIENT_SESSION' || c.name === '__cf_bm') {
          const dom = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
          const u = `${c.secure ? 'https' : 'http'}://${dom}${c.path || '/'}`;
          await ses.cookies.remove(u, c.name).catch(() => {});
        }
      }
      const alreadyReloaded = await win.webContents.executeJavaScript(`
        (() => {
          if (window.__claimrCookieErrReloaded) return true;
          window.__claimrCookieErrReloaded = true;
          return false;
        })()
      `).catch(() => false);

      if (!alreadyReloaded) {
        logger('🔄 Clearing stale CSRF cookie and refreshing Epic "Welcome back" page...');
        win.webContents.reload();
        return true;
      }
    }
  } catch (_) {}

  const script = `
    (() => {
      const bodyText = (document.body ? document.body.innerText : '') || '';
      const docTitle = document.title || '';
      if (!bodyText.includes('Welcome back') && !docTitle.includes('Confirm Your Account')) {
        return null;
      }

      // Guard: Never click more than once per 12 seconds so we don't fire concurrent POST requests
      // that invalidate Epic's rotating one-time CSRF/session cookie.
      if (window.__claimrWelcomeClickedAt && Date.now() - window.__claimrWelcomeClickedAt < 12000) {
        return { alreadyClicked: true };
      }

      const allElements = Array.from(document.querySelectorAll('*'));

      // 1. Find leaf element with email address (e.g., any masked email)
      const emailEl = allElements.find(el => {
        if (el.children.length > 2) return false;
        const txt = (el.innerText || '').trim();
        return /@.*\\./.test(txt) && !txt.includes('\\n');
      });

      // 2. Find by target username if known
      const targetUser = ${JSON.stringify(targetUsername || '')}.trim().toLowerCase();
      const userEl = targetUser ? allElements.find(el => {
        if (el.children.length > 2) return false;
        const txt = (el.innerText || '').trim().toLowerCase();
        return (txt === targetUser || txt.includes(targetUser)) && !txt.includes('welcome');
      }) : null;

      const anchor = emailEl || userEl;
      let targetCard = null;

      if (anchor) {
        let curr = anchor;
        while (curr && curr !== document.body) {
          const parent = curr.parentElement;
          if (!parent) break;
          const pTxt = parent.innerText || '';
          if (pTxt.includes('Use another account') || pTxt.includes('Manage accounts') || pTxt.includes('Privacy Policy')) {
            targetCard = curr;
            break;
          }
          curr = parent;
        }
      }

      // 3. Fallback: element immediately preceding "Use another account" container
      if (!targetCard) {
        const useAnother = allElements.find(el => (el.innerText || '').trim() === 'Use another account');
        if (useAnother) {
          let curr = useAnother;
          while (curr && curr !== document.body) {
            const parent = curr.parentElement;
            if (!parent) break;
            const sibs = Array.from(parent.children);
            const idx = sibs.indexOf(curr);
            if (idx > 0) {
              for (let i = idx - 1; i >= 0; i--) {
                const s = sibs[i];
                const sTxt = (s.innerText || '').trim();
                if (sTxt && sTxt !== 'or' && !sTxt.includes('Welcome back')) {
                  targetCard = s;
                  break;
                }
              }
            }
            if (targetCard) break;
            curr = parent;
          }
        }
      }

      // 4. Fallback: item between "Welcome back" and "or"
      if (!targetCard) {
        const heading = allElements.find(el => (el.innerText || '').trim() === 'Welcome back');
        const orDivider = allElements.find(el => (el.innerText || '').trim() === 'or');
        if (heading && orDivider) {
          const common = heading.closest('div');
          if (common) {
            const items = Array.from(common.querySelectorAll('div, button, a, li, [role="button"]')).filter(el => {
              const rect = el.getBoundingClientRect();
              const t = (el.innerText || '').trim();
              return rect.width > 120 && rect.height > 30 && rect.height < 150 && t !== 'or' && !t.includes('Welcome back');
            });
            if (items.length > 0) targetCard = items[0];
          }
        }
      }

      if (targetCard) {
        window.__claimrWelcomeClickedAt = Date.now();
        targetCard.scrollIntoView({ block: 'center', behavior: 'instant' });
        const clickable = targetCard.matches('button, a, [role="button"]')
          ? targetCard
          : (targetCard.querySelector('button, a, [role="button"]') || targetCard);
        const rect = clickable.getBoundingClientRect();

        // Fire a SINGLE click on the clickable target (never fire multiple clicks or we break CSRF rotation)
        if (typeof clickable.click === 'function') {
          clickable.click();
        }

        return {
          found: true,
          text: (targetCard.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      }

      return null;
    })()
  `;

  try {
    // 1. Try main frame
    let res = await win.webContents.executeJavaScript(script).catch(() => null);

    // 2. Try sub-frames if not found in main frame
    if (!res?.found && !res?.alreadyClicked) {
      for (const frame of win.webContents.mainFrame.frames) {
        try {
          res = await frame.executeJavaScript(script);
          if (res?.found || res?.alreadyClicked) break;
        } catch (_) {}
      }
    }

    if (res?.alreadyClicked) {
      return true;
    }

    if (res?.found) {
      logger(`👉 Detected Epic "Welcome back" screen ("${res.text}"). Auto-confirming account...`);
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Opens a native Electron BrowserWindow for Epic Games authentication.
 * 
 * Benefits over Playwright/Selenium:
 * 1. 100% authentic Chromium runtime without automation flags or CDP remote pipes.
 * 2. Arkose Labs (CAPTCHA) runs in an untampered environment, passing challenges cleanly.
 * 3. Supports all sign-in methods: Email/Password, 2FA, and 1-click OAuth (Google, Steam, Apple, Xbox, PSN).
 * 4. Extracts session cookies via session.cookies.get() and saves them to cookies.json
 *    so headless background claimers inherit the authenticated session seamlessly.
 */
async function openEpicLoginWindow({ accountId, relPath, fullPath, isNew = false } = {}) {
  if (activeEpicLoginWindow && !activeEpicLoginWindow.isDestroyed()) {
    activeEpicLoginWindow.show();
    activeEpicLoginWindow.focus();
    return { success: false, error: 'Login window is already active' };
  }

  const targetId = accountId || `acc_${Date.now()}`;
  const targetRelPath = relPath || path.join('.profiles', 'epic', targetId);
  const targetFullPath = fullPath || getFullProfileDir(targetRelPath, 'epic');
  fs.mkdirSync(targetFullPath, { recursive: true });

  const partitionName = `persist:epic_${targetId}`;
  const ses = session.fromPartition(partitionName);

  configureSessionStealth(ses);

  // If registering a new account, clear old partition storage to start completely fresh
  if (isNew) {
    try {
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'cache'],
      });
    } catch {}
  }

  return new Promise((resolve) => {
    let resolved = false;
    let pollTimer = null;
    let timeoutTimer = null;

    const loginWin = new BrowserWindow({
      width: 540,
      height: 740,
      minWidth: 440,
      minHeight: 600,
      title: 'Sign In to Epic Games',
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition: partitionName,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    activeEpicLoginWindow = loginWin;

    // Handle OAuth popups (Google, Steam, Apple, Xbox, PlayStation, Nintendo)
    loginWin.webContents.setWindowOpenHandler(() => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            partition: partitionName,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      activeEpicLoginWindow = null;
    };

    loginWin.once('ready-to-show', () => {
      loginWin.show();
      loginWin.focus();
    });

    loginWin.on('closed', () => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'Login window was closed before completing sign in.' });
      }
    });

    // Timeout after 5 minutes
    timeoutTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        try { loginWin.close(); } catch {}
        resolve({ success: false, error: 'Sign in timed out after 5 minutes.' });
      }
    }, 300000);

    let storeHomeTicks = 0;
    let capturedLoginName = null;

    const extractEpicAccountFromCookies = (cookies) => {
      for (const c of cookies) {
        const val = c?.value || '';
        if (!val.includes('.')) continue;
        const parts = val.split('.');
        if (parts.length < 2) continue;
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
          if (payload?.dn && typeof payload.dn === 'string') return { displayName: payload.dn };
          if (payload?.displayName && typeof payload.displayName === 'string') return { displayName: payload.displayName };
          if (payload?.name && typeof payload.name === 'string') return { displayName: payload.name };
          if (payload?.sub && typeof payload.sub === 'string') return { sub: payload.sub };
        } catch (_) {}
      }
      return null;
    };

    const checkLoginStatus = async () => {
      if (resolved || loginWin.isDestroyed()) return;

      try {
        const currentUrl = loginWin.webContents.getURL() || '';
        const title = loginWin.getTitle() || '';

        // Capture any typed email or "Welcome back" display name while on the login screen
        if (currentUrl.includes('/id/login') || currentUrl.includes('accounts.epicgames.com')) {
          try {
            const seen = await loginWin.webContents.executeJavaScript(`
              (() => {
                const emailInput = document.querySelector('input[type="email"], input[name="email"]');
                if (emailInput && emailInput.value && emailInput.value.includes('@')) {
                  return emailInput.value.split('@')[0].trim();
                }
                const allEls = Array.from(document.querySelectorAll('*'));
                const emailEl = allEls.find(el => el.children.length === 0 && /@.*\\./.test((el.innerText || '').trim()));
                if (emailEl && emailEl.parentElement) {
                  const lines = (emailEl.parentElement.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                  const nameLine = lines.find(l => !l.includes('@') && l.length > 1 && l !== 'Welcome back');
                  if (nameLine) return nameLine;
                }
                return null;
              })()
            `).catch(() => null);
            if (seen) capturedLoginName = seen;
          } catch (_) {}
        }

        // Auto-click "Welcome back" card if present during sign in flow
        const isWelcomeBack = currentUrl.includes('/id/login') ||
                              currentUrl.includes('accounts.epicgames.com') ||
                              title.includes('Confirm Your Account') ||
                              title.includes('Welcome back');
        if (isWelcomeBack) {
          const clicked = await tryClickWelcomeBackAccount(loginWin, '', console.log);
          if (clicked) return;
        }

        // If the user is still on any login, account, or password page, they are still completing sign in.
        const isAuthFlow = currentUrl.includes('/id/login') ||
                           currentUrl.includes('/id/api') ||
                           currentUrl.includes('accounts.epicgames.com');
        if (isAuthFlow) return;

        // Check if user has redirected to the store or home page
        const isStoreHome = currentUrl.includes('store.epicgames.com') ||
                            (currentUrl.includes('epicgames.com') && !isAuthFlow);
        if (!isStoreHome) return;

        const cookies = await ses.cookies.get({});
        const hasAuth = cookies.some((c) =>
          c.name === 'EPIC_BEARER_TOKEN' ||
          c.name === 'EPIC_SSO' ||
          c.name === 'EPIC_EG1' ||
          c.name === 'REFRESH_EPIC_EG1' ||
          c.name === 'EPIC_SSO_RM' ||
          c.name === 'EPIC_SESSION_AP' ||
          (c.name && c.name.startsWith('EPIC_RECEIPT_')) ||
          (c.name && c.name.startsWith('EPIC_AUTH_'))
        );

        if (!hasAuth) return;

        storeHomeTicks++;

        // Allow storefront SPA 1 tick (~1.5s) after redirect to finish background SSO handshake
        if (storeHomeTicks < 2) return;

        // 1. Try to fetch authentic Epic display name from DOM (including Shadow DOM & egs-navigation properties)
        let displayName = null;
        let domLoggedIn = false;
        try {
          const domInfo = await loginWin.webContents.executeJavaScript(`
            (() => {
              const nav = document.querySelector('egs-navigation');
              if (nav) {
                const loggedInAttr = nav.getAttribute('isloggedin') === 'true' || nav.isLoggedIn === true;
                const name = nav.getAttribute('displayname') || nav.getAttribute('data-displayname') || nav.displayName;
                if (name && name !== 'null' && name !== 'undefined' && String(name).trim()) {
                  return { displayName: String(name).trim(), isLoggedIn: true };
                }
                if (nav.shadowRoot) {
                  const shadowUser = nav.shadowRoot.querySelector('[data-testid="user-dropdown"], .user-name, [class*="displayName"], [class*="user"]');
                  if (shadowUser && (shadowUser.textContent || '').trim()) {
                    const txt = shadowUser.textContent.trim();
                    if (txt.toLowerCase() !== 'sign in' && txt.toLowerCase() !== 'download') {
                      return { displayName: txt, isLoggedIn: true };
                    }
                  }
                }
                if (loggedInAttr) {
                  return { displayName: null, isLoggedIn: true };
                }
              }
              const dropdown = document.querySelector('[data-testid="user-dropdown"]');
              if (dropdown && dropdown.innerText.trim()) {
                return { displayName: dropdown.innerText.trim(), isLoggedIn: true };
              }
              return null;
            })()
          `).catch(() => null);
          if (domInfo?.displayName) displayName = domInfo.displayName;
          if (domInfo?.isLoggedIn) domLoggedIn = true;
        } catch {}

        // 2. Use main-process ses.fetch (bypasses CORS between store.epicgames.com and www.epicgames.com!)
        if (!displayName) {
          try {
            const accRes = await ses.fetch('https://www.epicgames.com/id/api/account', {
              headers: { Accept: 'application/json' },
            });
            if (accRes.ok) {
              const accData = await accRes.json().catch(() => null);
              if (accData?.displayName?.trim()) {
                displayName = accData.displayName.trim();
              } else if (accData?.email?.trim()) {
                displayName = accData.email.split('@')[0].trim();
              }
            }
          } catch {}
        }

        // 3. Fallback: try /id/api/authenticate then /id/api/account via ses.fetch
        if (!displayName) {
          try {
            await ses.fetch('https://www.epicgames.com/id/api/authenticate', {
              headers: { Accept: 'application/json' },
            }).catch(() => {});
            const accRes2 = await ses.fetch('https://www.epicgames.com/id/api/account', {
              headers: { Accept: 'application/json' },
            });
            if (accRes2.ok) {
              const accData2 = await accRes2.json().catch(() => null);
              if (accData2?.displayName?.trim()) {
                displayName = accData2.displayName.trim();
              } else if (accData2?.email?.trim()) {
                displayName = accData2.email.split('@')[0].trim();
              }
            }
          } catch {}
        }

        // 4. Fallback: check JWT claims on REFRESH_EPIC_EG1 / EPIC_RECEIPT_* / EPIC_EG1 cookies
        const hasStoreToken = cookies.some((c) =>
          c.name === 'REFRESH_EPIC_EG1' ||
          c.name === 'EPIC_EG1' ||
          c.name === 'EPIC_BEARER_TOKEN' ||
          c.name === 'EPIC_SSO' ||
          (c.name && c.name.startsWith('EPIC_RECEIPT_'))
        );
        const jwtInfo = extractEpicAccountFromCookies(cookies);
        if (!displayName && jwtInfo?.displayName) {
          displayName = jwtInfo.displayName;
        }

        // 5. If confirmed on store with store tokens (or DOM logged in) after 2+ ticks, use captured login name or account ID
        if (!displayName && (hasStoreToken || domLoggedIn) && storeHomeTicks >= 2) {
          displayName =
            capturedLoginName ||
            (jwtInfo?.sub ? `Epic_${jwtInfo.sub.slice(0, 6)}` : 'Epic Account');
        }

        // Complete once confirmed on store page with user identity
        if (displayName) {
          resolved = true;
          cleanup();

          const freshCookies = await ses.cookies.get({});
          const username = displayName;
          console.log(`✅ Epic Games authentication confirmed for: ${username}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claim:log', `✅ Epic Games authentication confirmed for: ${username}`);
          }

          // Format cookies for Playwright persistent context
          const playwrightCookies = freshCookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
          }));

          fs.writeFileSync(
            path.join(targetFullPath, 'cookies.json'),
            JSON.stringify(playwrightCookies, null, 2),
            'utf-8'
          );

          const registered = registerAccount('epic', {
            id: targetId,
            username,
            profileDir: targetRelPath,
          });

          // Post-login library sync in background
          try {
            const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
            if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
              await syncEpicLibraryForAccount(currentFreeGames, registered).catch(() => {});
            }
          } catch (e) {
            console.warn('Post-login library sync error:', e.message);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }

          try {
            await ses.cookies.flushStore();
          } catch {}

          try {
            loginWin.close();
          } catch {}

          showFloatingNotification('Account Connected', `Signed in to Epic Games as ${username}`);
          resolve({ success: true, account: registered, username });
        }
      } catch (err) {
        console.warn('Login status check error:', err.message);
      }
    };

    pollTimer = setInterval(checkLoginStatus, 1500);

    const loginUrl = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https%3A%2F%2Fstore.epicgames.com%2F%3Flang%3Den-US';
    loginWin.loadURL(loginUrl).catch((err) => {
      console.warn('Login window load URL warning:', err.message);
    });
  });
}

ipcMain.handle('accounts:add', async (_event, { store }) => {
  console.log(`➕ Initiating new ${store} account login...`);
  if (store === 'epic') {
    const { id, relPath, fullPath } = createNewProfileDir('epic');
    const res = await openEpicLoginWindow({ accountId: id, relPath, fullPath, isNew: true });
    if (res && res.success) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:updated');
      }
    }
    return { ...res, accounts: loadAccounts() };
  } else {
    const { id, relPath, fullPath } = createNewProfileDir('gog');
    const res = await openGogLoginWindow({ accountId: id, relPath, fullPath, isNew: true });
    if (res && res.success) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:updated');
      }
    }
    return { ...res, accounts: loadAccounts() };
  }
});

ipcMain.handle('accounts:remove', async (_event, { store, accountId }) => {
  console.log(`🗑️ Removing ${store} account: ${accountId}`);
  const ok = removeAccount(store, accountId);
  return { success: ok, accounts: loadAccounts() };
});

ipcMain.handle('store:login-epic', async () => {
  console.log('🔑 Opening Epic Games login window...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claim:log', '🔑 Opening Epic Games login window...');
  }
  const activeEpic = getActiveAccount('epic');
  const accountId = activeEpic ? activeEpic.id : `acc_${Date.now()}`;
  const relPath = activeEpic?.profileDir || path.join('.profiles', 'epic', accountId);
  const fullPath = getFullProfileDir(relPath, 'epic');
  return await openEpicLoginWindow({ accountId, relPath, fullPath, isNew: !activeEpic });
});

let activeGogLoginWindow = null;

async function hydrateGogSession(ses, account) {
  configureSessionStealth(ses);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    await ses.cookies.set({
      url: 'https://www.gog.com/',
      name: 'CookieConsent',
      value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}',
      path: '/',
      expirationDate: nowSec + 31536000,
    }).catch(() => {});

    const profileDir = account?.profileDir ? getFullProfileDir(account.profileDir, 'gog') : null;
    const cookiesPath = profileDir ? path.join(profileDir, 'cookies.json') : null;
    if (cookiesPath && fs.existsSync(cookiesPath)) {
      const existingCookies = await ses.cookies.get({});
      // Note: gog_lc is merely locale/currency (set for guests too) — only check genuine auth cookies!
      const hasAuth = existingCookies.some(
        c =>
          (c.name === 'gog_us' || c.name === 'gog-al' || c.name === 'galaxy-login-s' || c.name === 'galaxy-login-al' || c.name === 'login-token') &&
          (!c.expirationDate || c.expirationDate > nowSec)
      );
      if (!hasAuth) {
        const raw = fs.readFileSync(cookiesPath, 'utf-8');
        const diskCookies = JSON.parse(raw);
        for (const c of diskCookies) {
          if (!c.name) continue;
          if (c.expires && c.expires > 0 && c.expires < nowSec) continue;

          const isDomainCookie = c.domain && c.domain.startsWith('.');
          const cookieDomain = c.domain ? (isDomainCookie ? c.domain.slice(1) : c.domain) : 'gog.com';
          const cookieUrl = `${c.secure ? 'https' : 'http'}://${cookieDomain}${c.path || '/'}`;
          const details = {
            url: cookieUrl,
            name: c.name,
            value: c.value,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite === 'Strict' ? 'strict' : (c.sameSite === 'None' || c.sameSite === 'no_restriction' ? 'no_restriction' : 'lax'),
            expirationDate: c.expires > 0 ? c.expires : (nowSec + 31536000),
          };
          if (isDomainCookie) {
            details.domain = c.domain;
          }
          await ses.cookies.set(details).catch(() => {});
        }
        await ses.cookies.flushStore().catch(() => {});
      }
    }
  } catch (_) {}
  return ses;
}

async function isGameInGogLibraryNative(gameTitle, account) {
  if (!gameTitle) return false;
  try {
    const targetId = account?.id || 'default';
    const ses = session.fromPartition(`persist:gog_${targetId}`);
    await hydrateGogSession(ses, account);
    const url = `https://www.gog.com/account/getFilteredProducts?mediaType=1&search=${encodeURIComponent(gameTitle)}`;
    const res = await ses.fetch(url);
    if (res.ok) {
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
    console.warn('GOG native library check error:', err.message);
  }
  return false;
}

/**
 * Opens a native Electron BrowserWindow for GOG.com authentication.
 * Avoids Playwright CDP debugging pipes so Cloudflare Turnstile passes cleanly.
 */
async function openGogLoginWindow({ accountId, relPath, fullPath, isNew = false } = {}) {
  if (activeGogLoginWindow && !activeGogLoginWindow.isDestroyed()) {
    activeGogLoginWindow.show();
    activeGogLoginWindow.focus();
    return { success: false, error: 'GOG login window is already active' };
  }

  const targetId = accountId || 'default';
  const targetRelPath = relPath || (targetId === 'default' ? '.profile-gog' : path.join('.profiles', 'gog', targetId));
  const targetFullPath = fullPath || getFullProfileDir(targetRelPath, 'gog');
  fs.mkdirSync(targetFullPath, { recursive: true });

  const partitionName = `persist:gog_${targetId}`;
  const ses = session.fromPartition(partitionName);

  configureSessionStealth(ses);

  if (isNew) {
    try {
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'cache'],
      });
    } catch {}
  } else {
    await hydrateGogSession(ses, { id: targetId, profileDir: targetRelPath });
  }

  return new Promise((resolve) => {
    let resolved = false;
    let pollTimer = null;
    let timeoutTimer = null;

    const loginWin = new BrowserWindow({
      width: 540,
      height: 740,
      minWidth: 440,
      minHeight: 600,
      title: 'Sign In to GOG.com',
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition: partitionName,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    activeGogLoginWindow = loginWin;

    // Handle OAuth popups (Google, Steam, Discord, Xbox)
    loginWin.webContents.setWindowOpenHandler(() => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            partition: partitionName,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
          },
        },
      };
    });

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      activeGogLoginWindow = null;
    };

    loginWin.once('ready-to-show', () => {
      loginWin.show();
      loginWin.focus();
    });

    loginWin.on('closed', () => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'GOG login window was closed before completing sign in.' });
      }
    });

    timeoutTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        try { loginWin.close(); } catch {}
        resolve({ success: false, error: 'GOG sign in timed out after 5 minutes.' });
      }
    }, 300000);

    const checkLoginStatus = async () => {
      if (resolved || loginWin.isDestroyed()) return;

      try {
        const currentUrl = loginWin.webContents.getURL() || '';
        const isLoginFlow = currentUrl.includes('login.gog.com') || currentUrl.includes('/auth?');
        if (isLoginFlow) return;

        const res = await ses.fetch('https://www.gog.com/userData.json');
        if (!res.ok) return;

        const data = await res.json().catch(() => null);
        if (data && data.isLoggedIn && data.username) {
          resolved = true;
          cleanup();

          const username = data.username.trim();
          console.log(`✅ GOG.com authentication confirmed for: ${username}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claim:log', `✅ GOG.com authentication confirmed for: ${username}`);
          }

          const cookies = await ses.cookies.get({});
          const formattedCookies = cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
          }));

          fs.writeFileSync(
            path.join(targetFullPath, 'cookies.json'),
            JSON.stringify(formattedCookies, null, 2),
            'utf-8'
          );

          const registered = registerAccount('gog', {
            id: targetId,
            username,
            profileDir: targetRelPath,
          });

          try {
            const gogGiveaway = await getGogGiveawayFastOrBrowser().catch(() => null);
            if (gogGiveaway?.active && gogGiveaway?.title) {
              const isOwned = await isGameInGogLibraryNative(gogGiveaway.title, registered);
              if (isOwned) {
                const h = loadHistory();
                recordClaim(h, { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' }, 'in_library', registered.id, registered.username);
              }
            }
          } catch (_) {}

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }

          try {
            await ses.cookies.flushStore();
          } catch {}

          try {
            loginWin.close();
          } catch {}

          showFloatingNotification('Account Connected', `Signed in to GOG.com as ${username}`);
          resolve({ success: true, account: registered, username });
        }
      } catch (_) {}
    };

    pollTimer = setInterval(checkLoginStatus, 1500);

    const gogLoginUrl = 'https://login.gog.com/auth?client_id=46755278331571209&layout=default&brand=gog&response_type=code&redirect_uri=https%3A%2F%2Fwww.gog.com%2Fon_login_success%3FreturnTo%3D%2Fen';
    loginWin.loadURL(gogLoginUrl).catch((err) => {
      console.warn('GOG login window load URL warning:', err.message);
    });
  });
}

/**
 * Claims current active GOG giveaway using native Electron session & BrowserWindow.
 * Automatically refreshes expired 24h gog_us sessions via login.gog.com SSO or prompts
 * sign-in directly inside the native window if the profile session expired.
 */
async function claimGogNative(account, { headless = true, logger = console.log } = {}) {
  logger('\n========================================');
  logger('🎮 [GOG.COM] Checking for Giveaways...');

  const targetId = account?.id || 'default';
  const targetRelPath = account?.profileDir || (targetId === 'default' ? '.profile-gog' : path.join('.profiles', 'gog', targetId));
  const targetFullPath = getFullProfileDir(targetRelPath, 'gog');
  fs.mkdirSync(targetFullPath, { recursive: true });

  const partitionName = `persist:gog_${targetId}`;
  const ses = session.fromPartition(partitionName);
  await hydrateGogSession(ses, { id: targetId, profileDir: targetRelPath, username: account?.username });

  const giveaway = await getGogGiveawayFastOrBrowser().catch(() => ({ active: false }));
  if (!giveaway?.active) {
    logger('ℹ️ No active time-limited giveaway on GOG right now.');
    return { status: 'no_giveaway' };
  }

  logger(`🎁 Active GOG Giveaway detected: "${giveaway.title}"`);

  // 1. Check fast session auth via userData.json
  let gogUsername = null;
  try {
    const userRes = await ses.fetch('https://www.gog.com/userData.json');
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData && userData.isLoggedIn && userData.username) {
        gogUsername = userData.username;
      }
    }
  } catch (_) {}

  // 2. If fast userData.json reports logged out (e.g. 24h gog_us cookie expired or legacy Playwright profile),
  // open a native BrowserWindow to auto-exchange gog-al / galaxy-login-al on login.gog.com or let the user sign in.
  if (!gogUsername) {
    logger(`🔄 Verifying / refreshing GOG session for "${account?.username || targetId}"...`);
    gogUsername = await new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      let timeoutTimer = null;
      let ticks = 0;
      let promptedUser = false;

      const gogWin = new BrowserWindow({
        width: 560,
        height: 740,
        minWidth: 440,
        minHeight: 600,
        title: `GOG.com Session (${account?.username || targetId}) - Claimr`,
        show: !headless,
        autoHideMenuBar: true,
        webPreferences: {
          partition: partitionName,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });

      const cleanupWin = () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (activeClaimWindow === gogWin) activeClaimWindow = null;
        if (activeClaimFinish === finishWin) activeClaimFinish = null;
      };

      const finishWin = (usernameResult) => {
        if (settled) return;
        settled = true;
        cleanupWin();
        try {
          if (!gogWin.isDestroyed()) {
            gogWin.close();
          }
        } catch (_) {}
        resolve(typeof usernameResult === 'string' ? usernameResult : null);
      };

      activeClaimWindow = gogWin;
      activeClaimFinish = () => finishWin(null);

      gogWin.on('closed', () => {
        cleanupWin();
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });

      timeoutTimer = setTimeout(() => {
        finishWin(null);
      }, 180000);

      pollTimer = setInterval(async () => {
        if (settled || gogWin.isDestroyed() || isClaimAbortRequested) {
          return finishWin(null);
        }
        ticks++;

        try {
          const currentUrl = gogWin.webContents.getURL() || '';
          const isLoginPage = currentUrl.includes('login.gog.com') || currentUrl.includes('/auth?');

          // Check if userData.json now reports logged in
          if (!isLoginPage) {
            const res = await ses.fetch('https://www.gog.com/userData.json');
            if (res.ok) {
              const data = await res.json().catch(() => null);
              if (data && data.isLoggedIn && data.username) {
                const uname = data.username.trim();
                const cookies = await ses.cookies.get({});
                const formatted = cookies.map((c) => ({
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path,
                  expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
                  httpOnly: !!c.httpOnly,
                  secure: !!c.secure,
                  sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
                }));
                fs.writeFileSync(path.join(targetFullPath, 'cookies.json'), JSON.stringify(formatted, null, 2), 'utf-8');
                await ses.cookies.flushStore().catch(() => {});
                registerAccount('gog', {
                  id: targetId,
                  username: uname,
                  profileDir: targetRelPath,
                });
                return finishWin(uname);
              }
            }
          }

          // If still on login.gog.com after 2 ticks (~3s), the auto-login token expired — show the window so the user can log in right now!
          if (isLoginPage && ticks >= 2 && !promptedUser) {
            promptedUser = true;
            if (!gogWin.isVisible()) {
              gogWin.show();
              gogWin.focus();
            }
            logger(`🔑 GOG session for "${account?.username || targetId}" requires sign-in. Please sign in to the GOG window to claim "${giveaway.title}"...`);
            sendNotification('Claimr - GOG Sign-In Needed 🔑', `Please sign into GOG (${account?.username || 'account'}) in the window to claim "${giveaway.title}".`);
          }
        } catch (_) {}
      }, 1500);

      const gogLoginUrl = 'https://login.gog.com/auth?client_id=46755278331571209&layout=default&brand=gog&response_type=code&redirect_uri=https%3A%2F%2Fwww.gog.com%2Fon_login_success%3FreturnTo%3D%2Fen';
      gogWin.loadURL(gogLoginUrl).catch(() => finishWin(null));
    });
  }

  if (isClaimAbortRequested) {
    logger('🛑 GOG claim stopped by user.');
    return { status: 'cancelled', title: giveaway.title };
  }

  if (!gogUsername) {
    logger('⚠️ GOG sign-in was not completed.');
    return { status: 'unauthorized', title: giveaway.title };
  }

  logger(`👤 Signed into GOG as: ${gogUsername}`);

  // Check if already in library after authenticating
  const alreadyOwned = giveaway.isAlreadyClaimed || await isGameInGogLibraryNative(giveaway.title, { id: targetId, profileDir: targetRelPath, username: gogUsername });
  if (alreadyOwned) {
    logger(`✅ "${giveaway.title}" is already in your GOG library!`);
    const history = loadHistory();
    recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'in_library', targetId, gogUsername);
    return { status: 'already_claimed', title: giveaway.title };
  }

  logger(`👉 Claiming GOG giveaway "${giveaway.title}"...`);

  try {
    let claimRes = await ses.fetch('https://www.gog.com/giveaway/claim', {
      method: 'GET',
      headers: {
        Referer: 'https://www.gog.com/en',
      },
    });
    if (!claimRes.ok && claimRes.status === 405) {
      claimRes = await ses.fetch('https://www.gog.com/giveaway/claim', {
        method: 'POST',
        headers: {
          Referer: 'https://www.gog.com/en',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
    }
    const bodyText = (await claimRes.text()).trim();
    let resultJson = {};
    try {
      resultJson = JSON.parse(bodyText);
    } catch {}

    const history = loadHistory();
    if (claimRes.ok && (bodyText === '{}' || bodyText === '')) {
      logger(`🎉 SUCCESS: Successfully claimed "${giveaway.title}" on GOG!`);
      recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'claimed', targetId, gogUsername);
      sendNotification('GOG Freebie Claimed! 🎁', `Successfully claimed "${giveaway.title}" on GOG!`);
      return { status: 'claimed', title: giveaway.title };
    } else if (resultJson.message === 'Already claimed') {
      logger(`✅ "${giveaway.title}" is already in your GOG library!`);
      recordClaim(history, { id: `gog_${giveaway.title}`, title: giveaway.title, slug: 'gog' }, 'in_library', targetId, gogUsername);
      return { status: 'already_claimed', title: giveaway.title };
    } else if (resultJson.message === 'Unauthorized') {
      logger('❌ GOG reported Unauthorized. Please re-authenticate.');
      return { status: 'unauthorized', title: giveaway.title };
    } else {
      logger(`ℹ️ GOG claim response: ${bodyText}`);
      return { status: 'response', message: bodyText, title: giveaway.title };
    }
  } catch (err) {
    logger(`❌ GOG claim error: ${err.message}`);
    return { status: 'error', error: err.message };
  }
}

ipcMain.handle('store:login-gog', async () => {
  console.log('🔑 Opening GOG login window...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claim:log', '🔑 Opening GOG.com login window...');
  }
  const activeGog = getActiveAccount('gog');
  const accountId = activeGog ? activeGog.id : 'default';
  const relPath = activeGog?.profileDir || (accountId === 'default' ? '.profile-gog' : path.join('.profiles', 'gog', accountId));
  const fullPath = getFullProfileDir(relPath, 'gog');
  return await openGogLoginWindow({ accountId, relPath, fullPath, isNew: !activeGog });
});

ipcMain.handle('store:claim-all', async () => {
  if (isClaimingInProgress) {
    return { error: 'Claiming process is already running.' };
  }
  isClaimAbortRequested = false;
  await executeAutoClaimInBackground();
  return { success: true };
});

ipcMain.handle('store:stop-claim', async () => {
  isClaimAbortRequested = true;
  const sendLog = (msg) => {
    console.log(`[Claim Engine] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claim:log', msg);
    }
  };

  sendLog('🛑 Stopping active automation...');

  if (activeClaimFinish) {
    try {
      await activeClaimFinish({ status: 'cancelled', message: 'Automation stopped by user.' });
    } catch (_) {}
  } else if (activeClaimWindow && !activeClaimWindow.isDestroyed()) {
    try {
      activeClaimWindow.destroy();
    } catch (_) {}
    activeClaimWindow = null;
  }

  isClaimingInProgress = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claim:stopped');
  }
  return { success: true };
});

/**
 * Claims an Epic Games Store free promotion using a native Electron BrowserWindow.
 * 
 * Why this is immune to Cloudflare Turnstile:
 * 1. Playwright / Puppeteer uses Chrome DevTools Protocol (--remote-debugging-pipe / Runtime.enable).
 *    Cloudflare Turnstile detects CDP automation flags and rejects manual and automated clicks alike.
 * 2. Electron BrowserWindow runs the system Chromium engine without any CDP debugging pipes or flags.
 * 3. Session cookies and credentials persist in partition 'persist:epic_${account.id}',
 *    shared with the login window.
 */
async function claimEpicGameNative(game, account, { logger = console.log, isHeadless = false } = {}) {
  const targetId = account?.id || 'default';
  const partitionName = `persist:epic_${targetId}`;
  const ses = session.fromPartition(partitionName);

  configureSessionStealth(ses);

  // Hydrate session cookies from cookies.json if session cookies were purged,
  // while stripping stale/poisoned CSRF or ephemeral flow cookies
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const allExisting = await ses.cookies.get({});
    for (const ec of allExisting) {
      if (
        ec.name === 'XSRF-TOKEN' ||
        ec.name === 'EPIC_CLIENT_SESSION' ||
        ec.name === '__cf_bm' ||
        (ec.expirationDate && ec.expirationDate < nowSec)
      ) {
        const dom = ec.domain.startsWith('.') ? ec.domain.slice(1) : ec.domain;
        const u = `${ec.secure ? 'https' : 'http'}://${dom}${ec.path || '/'}`;
        await ses.cookies.remove(u, ec.name).catch(() => {});
      }
    }

    const profileDir = account?.profileDir ? getFullProfileDir(account.profileDir, 'epic') : null;
    const cookiesPath = profileDir ? path.join(profileDir, 'cookies.json') : null;
    if (cookiesPath && fs.existsSync(cookiesPath)) {
      const existingCookies = await ses.cookies.get({ domain: 'epicgames.com' });
      const hasAuth = existingCookies.some((c) =>
        c.name === 'EPIC_BEARER_TOKEN' ||
        c.name === 'EPIC_SSO' ||
        c.name === 'EPIC_EG1' ||
        c.name === 'REFRESH_EPIC_EG1' ||
        c.name === 'EPIC_SSO_RM' ||
        (c.name && c.name.startsWith('EPIC_RECEIPT_'))
      );
      if (!hasAuth) {
        const raw = fs.readFileSync(cookiesPath, 'utf-8');
        const diskCookies = JSON.parse(raw);
        const skipNames = new Set(['XSRF-TOKEN', 'EPIC_CLIENT_SESSION', '__cf_bm', '_cfuvid']);
        for (const c of diskCookies) {
          if (!c.name || skipNames.has(c.name)) continue;
          if (c.expires && c.expires > 0 && c.expires < nowSec) continue;

          const isDomainCookie = c.domain && c.domain.startsWith('.');
          const cookieDomain = c.domain ? (isDomainCookie ? c.domain.slice(1) : c.domain) : 'epicgames.com';
          const cookieUrl = `${c.secure ? 'https' : 'http'}://${cookieDomain}${c.path || '/'}`;
          const cookieDetails = {
            url: cookieUrl,
            name: c.name,
            value: c.value,
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite === 'Strict' ? 'strict' : (c.sameSite === 'None' || c.sameSite === 'no_restriction' ? 'no_restriction' : 'lax'),
            expirationDate: c.expires > 0 ? c.expires : (nowSec + 31536000),
          };
          if (isDomainCookie) {
            cookieDetails.domain = c.domain;
          }
          await ses.cookies.set(cookieDetails).catch(() => {});
        }
        await ses.cookies.flushStore().catch(() => {});
        logger(`🔑 Restored session cookies for Epic account "${account?.username || account?.id}"`);
      }
    }
  } catch (err) {
    logger(`⚠️ Cookie hydration notice: ${err.message}`);
  }

  return new Promise((resolve) => {
    let resolved = false;
    let pollInterval = null;
    let timeoutTimer = null;
    let welcomeBackClickAttempts = 0;

    const claimWin = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 900,
      minHeight: 650,
      title: `Claiming ${game.title} - Claimr`,
      show: !isHeadless,
      autoHideMenuBar: true,
      webPreferences: {
        partition: partitionName,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    claimWin.webContents.setWindowOpenHandler(() => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            partition: partitionName,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    });

    const cleanup = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (activeClaimWindow === claimWin) activeClaimWindow = null;
      if (activeClaimFinish === finish) activeClaimFinish = null;
    };

    const finish = async (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        if (result?.status === 'claimed') {
          const profileDir = account?.profileDir ? getFullProfileDir(account.profileDir, 'epic') : null;
          if (profileDir && fs.existsSync(profileDir)) {
            const updatedCookies = await ses.cookies.get({});
            const formatted = updatedCookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
              httpOnly: !!c.httpOnly,
              secure: !!c.secure,
              sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite === 'strict' ? 'Strict' : 'Lax'),
            }));
            fs.writeFileSync(path.join(profileDir, 'cookies.json'), JSON.stringify(formatted, null, 2), 'utf-8');
          }
          await ses.cookies.flushStore().catch(() => {});
        }
      } catch (_) {}
      try {
        if (!claimWin.isDestroyed()) {
          claimWin.close();
        }
      } catch (_) {}
      resolve(result);
    };

    activeClaimWindow = claimWin;
    activeClaimFinish = finish;

    claimWin.on('closed', () => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ status: 'cancelled', message: 'Claim window was closed.' });
      }
    });

    // 3-minute safety timeout (allows ample time if user needs to complete a security check)
    timeoutTimer = setTimeout(() => {
      finish({ status: 'failed', error: 'Claim process timed out after 3 minutes.' });
    }, 180000);

    let stage = 'loading'; // 'loading' | 'clicked_get' | 'checkout'
    let getClickedAt = 0;
    let placeOrderAttempts = 0;
    let lastPlaceOrderClickAt = 0;
    let captchaActive = false;
    let captchaNotified = false;
    let captchaResolvedAt = 0;
    let postCaptchaClicked = false;

    const getAllFrames = () => {
      try {
        const main = claimWin.webContents.mainFrame;
        if (Array.isArray(main.framesInSubtree) && main.framesInSubtree.length > 0) {
          return main.framesInSubtree;
        }
        const collected = [main];
        const visit = (f) => {
          if (!f || !Array.isArray(f.frames)) return;
          for (const child of f.frames) {
            collected.push(child);
            visit(child);
          }
        };
        visit(main);
        return collected;
      } catch (_) {
        return [claimWin.webContents.mainFrame];
      }
    };

    const detectActiveCaptcha = async () => {
      // A checkout captcha challenge only triggers AFTER "Place Order" has been clicked at least once.
      // Before clicking "Place Order", any arkose/hcaptcha/turnstile iframes in the checkout DOM are
      // invisible preloaded background token frames.
      if (placeOrderAttempts === 0) return false;
      if (Date.now() - lastPlaceOrderClickAt < 1500) return false;

      const allFrames = getAllFrames();
      for (const frame of allFrames) {
        try {
          const hasVisibleCaptcha = await frame.executeJavaScript(`
            (() => {
              const isElementTrulyVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                // Interactive challenge modals/widgets are at least 200x60 inside the viewport
                if (rect.width < 200 || rect.height < 60) return false;
                if (rect.bottom <= 0 || rect.right <= 0) return false;
                if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;

                let curr = el;
                while (curr && curr !== document.documentElement) {
                  const style = window.getComputedStyle(curr);
                  if (
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    parseFloat(style.opacity || '1') <= 0.1
                  ) {
                    return false;
                  }
                  curr = curr.parentElement;
                }
                return true;
              };

              const selectors = [
                'iframe[src*="hcaptcha.html#frame=challenge"]',
                'iframe[src*="arkose"]',
                'iframe[src*="funcaptcha"]',
                'iframe[src*="octocaptcha"]',
                'iframe[src*="challenges.cloudflare.com"]',
                'iframe[src*="turnstile"]',
                'iframe[title*="challenge" i]',
                'div#challenge-stage'
              ];
              for (const sel of selectors) {
                const els = Array.from(document.querySelectorAll(sel));
                for (const el of els) {
                  if (isElementTrulyVisible(el)) {
                    return true;
                  }
                }
              }

              if (window.innerWidth >= 200 && window.innerHeight >= 60 && document.body) {
                const bodyText = document.body.innerText || '';
                if (
                  bodyText.includes('Verify you are human') ||
                  bodyText.includes('complete a security check') ||
                  bodyText.includes('Please solve this puzzle')
                ) {
                  return true;
                }
              }
              return false;
            })()
          `).catch(() => false);

          if (hasVisibleCaptcha) return true;
        } catch (_) {}
      }
      return false;
    };

    const checkStep = async () => {
      if (resolved || claimWin.isDestroyed()) return;

      try {
        const title = claimWin.getTitle() || '';
        const currentUrl = claimWin.webContents.getURL() || '';

        // If Cloudflare or Turnstile interstitial appears, ensure window is visible
        if (title.includes('Just a moment') || title.includes('One more step')) {
          if (!claimWin.isVisible()) {
            claimWin.show();
            claimWin.focus();
            logger('🛡️ Security verification required. Showing browser window...');
          }
          return;
        }

        // Check for Epic "Welcome back" / "Confirm Your Account" screen
        const isWelcomeBack = title.includes('Confirm Your Account') ||
                              title.includes('Welcome back') ||
                              currentUrl.includes('/id/login') ||
                              currentUrl.includes('accounts.epicgames.com');

        if (isWelcomeBack) {
          const clicked = await tryClickWelcomeBackAccount(claimWin, account?.username || '', logger);
          if (clicked) {
            welcomeBackClickAttempts++;
            return;
          }

          // Check if 2FA code is explicitly requested
          const needs2FA = await claimWin.webContents.executeJavaScript(`
            (() => {
              const body = (document.body ? document.body.innerText : '').toLowerCase();
              const is2FA = body.includes('security code') || body.includes('two-factor') || body.includes('verification code');
              const hasInput = !!document.querySelector('input[type="text"], input[type="tel"], input[name*="code"], input[name*="otp"]');
              return is2FA && hasInput;
            })()
          `).catch(() => false);

          if (needs2FA) {
            if (!claimWin.isVisible()) {
              claimWin.show();
              claimWin.focus();
            }
            logger('🔐 Epic Games 2FA required. Please enter the verification code in the window...');
            sendNotification('Claimr - 2FA Required', 'Please enter your Epic Games two-factor code to continue.');
            return;
          }
        }

        // Stage 1: Store page loading & button check
        if (stage === 'loading') {
          // Handle age verification / mature content dialogs on the store page
          await claimWin.webContents.executeJavaScript(`
            (() => {
              const btn = Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').trim();
                return ['Continue', 'CONTINUE', 'Accept', 'ACCEPT', 'Yes', 'YES', 'Yes, buy now', 'I Understand', 'Dismiss', 'OK'].includes(t);
              });
              if (btn) btn.click();
            })()
          `).catch(() => {});

          const pageState = await claimWin.webContents.executeJavaScript(`
            (() => {
              const buttons = Array.from(document.querySelectorAll('button'));

              // 1. Check if already owned
              const ownedBtn = buttons.find(b => {
                const t = (b.innerText || '').trim().toLowerCase();
                return t === 'in library' || t === 'owned' || t === 'view in library';
              });
              if (ownedBtn) return { type: 'owned' };

              // 2. Check for "Get" CTA button
              const ctaBtn = document.querySelector('button[data-testid="purchase-cta-button"]') ||
                             buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'get');
              if (ctaBtn) {
                const txt = (ctaBtn.innerText || '').trim().toLowerCase();
                if (txt === 'in library' || txt === 'owned') return { type: 'owned' };
                if (txt === 'get') {
                  ctaBtn.click();
                  return { type: 'clicked_get' };
                }
              }

              return null;
            })()
          `).catch(() => null);

          if (pageState?.type === 'owned') {
            logger(`🎉 "${game.title}" is already in your Epic Games library!`);
            const history = loadHistory();
            recordClaim(history, game, 'in_library', account?.id, account?.username);
            return finish({ status: 'in_library' });
          }

          if (pageState?.type === 'clicked_get') {
            logger('👉 Found "Get" button. Initiating checkout...');
            stage = 'clicked_get';
            getClickedAt = Date.now();
            return;
          }
        }

        // Stage 2: Checkout flow
        if (stage === 'clicked_get' || stage === 'checkout') {
          stage = 'checkout';

          // 1. Check order confirmation across main document and all checkout iframes
          const allFrames = getAllFrames();
          for (const frame of allFrames) {
            try {
              const isConfirmed = await frame.executeJavaScript(`
                (() => {
                  const body = document.body ? document.body.innerText : '';
                  if (
                    body.includes('Thank you for buying') ||
                    body.includes('Thanks for your order') ||
                    body.includes('Thank you!') ||
                    body.includes('Order Confirmed')
                  ) {
                    return true;
                  }
                  const launcherPrompt = Array.from(document.querySelectorAll('div, h1, h2, h3, p')).find(el => {
                    return (el.innerText || '').includes('Is Epic Games Launcher installed?');
                  });
                  return !!launcherPrompt;
                })()
              `).catch(() => false);

              if (isConfirmed) {
                logger(`🎉 Order Confirmed! Successfully claimed "${game.title}".`);
                const history = loadHistory();
                recordClaim(history, game, 'claimed', account?.id, account?.username);
                sendNotification('Game Claimed! 🎮', `"${game.title}" has been successfully claimed on Epic Games Store!`);
                return finish({ status: 'claimed' });
              }
            } catch (_) {}
          }

          // 2. If 12+ seconds have elapsed since clicking Place Order, check if store page now shows "In Library"
          if (placeOrderAttempts > 0 && Date.now() - (lastPlaceOrderClickAt || getClickedAt) > 12000) {
            const isNowOwned = await claimWin.webContents.executeJavaScript(`
              (() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.some(b => {
                  const t = (b.innerText || '').trim().toLowerCase();
                  return t === 'in library' || t === 'owned';
                });
              })()
            `).catch(() => false);

            if (isNowOwned) {
              logger(`🎉 Verified in library! Successfully claimed "${game.title}".`);
              const history = loadHistory();
              recordClaim(history, game, 'claimed', account?.id, account?.username);
              sendNotification('Game Claimed! 🎮', `"${game.title}" has been successfully claimed on Epic Games Store!`);
              return finish({ status: 'claimed' });
            }
          }

          // 3. Check for Captcha / Cloudflare / Arkose verification BEFORE touching any checkout buttons!
          // Clicking "Place Order" while a captcha is loading or active forces Epic to regenerate a new captcha.
          const hasCaptcha = await detectActiveCaptcha();
          if (hasCaptcha) {
            captchaActive = true;
            captchaResolvedAt = 0;
            if (!claimWin.isVisible()) {
              claimWin.show();
              claimWin.focus();
            }
            if (!captchaNotified) {
              captchaNotified = true;
              logger('🛡️ Security verification required in checkout. Auto-clicker paused — please complete verification in the window...');
              sendNotification('Claimr - Verification Required 🛡️', 'Epic Games requires verification to complete your order.');
            }
            return;
          }

          if (captchaActive) {
            captchaActive = false;
            captchaResolvedAt = Date.now();
            logger('✅ Security verification completed! Waiting for order confirmation...');
          }

          // 4. Accept "Device not supported", EULA, or consent dialogs if present in main document or checkout iframes
          let eulaJustClicked = false;
          for (const frame of allFrames) {
            try {
              const dialogRes = await frame.executeJavaScript(`
                (() => {
                  let acted = null;
                  const eula = document.querySelector('input#agree, input#eula, input[name="agree"]');
                  if (eula && !eula.checked) {
                    eula.click();
                    acted = 'checkbox';
                  }
                  const acceptBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
                    const t = (b.innerText || b.textContent || '').trim().toLowerCase();
                    if (!['continue', 'i accept', 'i agree', 'accept', 'yes, buy now', 'i understand'].includes(t)) {
                      return false;
                    }
                    const rect = b.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && !b.disabled;
                  });
                  if (acceptBtn) {
                    const label = (acceptBtn.innerText || acceptBtn.textContent || '').trim();
                    acceptBtn.click();
                    acted = label || 'button';
                  }
                  return acted;
                })()
              `).catch(() => null);
              if (dialogRes) {
                eulaJustClicked = true;
                logger(`👉 Confirmed store dialog ("${dialogRes}")...`);
              }
            } catch (_) {}
          }

          // 5. Click "Place Order" ONCE (never spam-click it on every poll tick!)
          // Only allow a second click if a captcha was solved 8+ seconds ago and Epic didn't auto-submit,
          // or if an EULA modal was just accepted after the initial click.
          const canClickInitial = placeOrderAttempts === 0;
          const canClickPostCaptcha =
            placeOrderAttempts === 1 &&
            !postCaptchaClicked &&
            captchaResolvedAt > 0 &&
            Date.now() - captchaResolvedAt > 8000;
          const canClickPostEula =
            placeOrderAttempts === 1 &&
            eulaJustClicked &&
            Date.now() - lastPlaceOrderClickAt > 3000;

          if (canClickInitial || canClickPostCaptcha || canClickPostEula) {
            for (const frame of allFrames) {
              try {
                const clickedPlaceOrder = await frame.executeJavaScript(`
                  (() => {
                    const placeBtn = Array.from(document.querySelectorAll('button')).find(b => {
                      if (b.getAttribute('data-testid') === 'purchase-cta-button') return false;
                      const txt = (b.innerText || '').toLowerCase().trim();
                      const isMatch =
                        txt === 'place order' ||
                        txt === 'add to library' ||
                        b.classList.contains('payment-btn--primary') ||
                        b.classList.contains('payment-order-confirm__btn');
                      if (!isMatch) return false;
                      const cls = (b.className || '').toLowerCase();
                      const isDisabled =
                        b.disabled ||
                        b.getAttribute('aria-disabled') === 'true' ||
                        cls.includes('disabled') ||
                        cls.includes('loading');
                      return !isDisabled;
                    });
                    if (placeBtn) {
                      placeBtn.click();
                      return true;
                    }
                    return false;
                  })()
                `).catch(() => false);

                if (clickedPlaceOrder) {
                  placeOrderAttempts++;
                  lastPlaceOrderClickAt = Date.now();
                  if (canClickPostCaptcha) postCaptchaClicked = true;
                  logger(`👉 Clicked "Place Order" in checkout. Waiting for confirmation...`);
                  break;
                }
              } catch (_) {}
            }
          }
        }
      } catch (err) {
        logger(`Claim step notice: ${err.message}`);
      }
    };

    pollInterval = setInterval(checkStep, 1500);

    const storeUrl = game.storeUrl ||
      (game.slug ? `https://store.epicgames.com/en-US/p/${game.slug}` : `https://store.epicgames.com/en-US/p/${game.id}`);

    logger(`🌐 Opening store page in native window: ${storeUrl}`);
    claimWin.loadURL(storeUrl).catch((err) => {
      logger(`⚠️ Failed to load store URL: ${err.message}`);
      finish({ status: 'failed', error: err.message });
    });
  });
}

ipcMain.handle('store:claim-game', async (_event, { store, gameId, gameTitle, storeUrl }) => {
  if (isClaimingInProgress) {
    return { error: 'Claiming process is already running.' };
  }

  isClaimingInProgress = true;
  isClaimAbortRequested = false;
  const sendLog = (msg) => {
    console.log(`[Claim Engine] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claim:log', msg);
    }
  };

  const settings = loadSettings();
  const isHeadless = settings.headless !== false;

  try {
    const isEpic = (store || '').toUpperCase() === 'EPIC';

    if (isEpic) {
      sendLog('\n========================================');
      sendLog(`🚀 [START] Single-game claim automator for: ${gameTitle}`);
      sendLog('🎮 Platform: Epic Games Store (Native Engine)');
      sendLog(`⚙️ Browser Mode: ${isHeadless ? 'Headless (Silent background)' : 'Headed (Visible window)'}`);

      const activeEpic = getActiveAccount('epic');
      sendLog(`👤 Active Epic Profile: ${activeEpic?.username || 'Default'} (${activeEpic?.id || 'default'})`);
      sendLog(`🔗 Target: ${storeUrl || gameTitle}`);

      const game = { id: gameId, title: gameTitle, storeUrl };
      const result = await claimEpicGameNative(game, activeEpic, {
        logger: sendLog,
        isHeadless,
      });

      sendLog(`✨ [COMPLETE] Automator finished for: ${gameTitle}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:updated');
      }
      return { success: true, result };
    } else {
      // GOG
      sendLog('\n========================================');
      sendLog(`🚀 [START] Single-game claim automator for: ${gameTitle}`);
      sendLog('👾 Platform: GOG.com');
      sendLog(`⚙️ Browser Mode: ${isHeadless ? 'Headless (Silent background)' : 'Headed (Visible window)'}`);

      const activeGog = getActiveAccount('gog');
      sendLog(`👤 Active GOG Profile: ${activeGog?.username || 'Default'} (${activeGog?.id || 'default'})`);

      const result = await claimGogNative(activeGog, {
        headless: isHeadless,
        logger: sendLog,
      });
      sendLog(`✨ [COMPLETE] Automator finished for: ${gameTitle}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:updated');
      }
      return { success: true, result };
    }
  } catch (err) {
    sendLog(`❌ Automator error: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    isClaimingInProgress = false;
  }
});

ipcMain.handle('store:get-history', async () => {
  return loadHistory();
});

// -------------------------------------------------------------
// Cross-Platform Auto-Claim Settings & Tray Scheduler
// -------------------------------------------------------------

function getSettingsPath() {
  const dataDir = process.env.CLAIMR_DATA_DIR || ROOT_DIR;
  return path.join(dataDir, 'settings.json');
}

function loadSettings() {
  try {
    const file = getSettingsPath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed.autoClaim === undefined) parsed.autoClaim = true;
      if (parsed.headless === undefined) parsed.headless = true;
      return parsed;
    }
  } catch {}
  return { autoClaim: true, headless: true, lastCheckSlot: null, lastCheckDate: null };
}

function saveSettings(settings) {
  try {
    const file = getSettingsPath();
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

let schedulerInterval = null;

async function executeAutoClaimInBackground() {
  if (isClaimingInProgress) return;
  isClaimingInProgress = true;

  const sendLog = (msg) => {
    console.log(`[Auto-Claim] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claim:log', msg);
    }
  };

  const settings = loadSettings();
  const isHeadless = settings.headless !== false;

  sendLog('\n========================================');
  sendLog('⏰ [Auto-Claim] Automated claim engine started...');
  sendLog(`🖥️ Platform: ${process.platform} • Multi-Account Auto Engine`);
  sendLog(`⚙️ Browser Mode: ${isHeadless ? 'Headless (Silent background)' : 'Headed (Visible window)'}`);

  const claimedGames = [];

  try {
    const accountsData = loadAccounts();

    // 1. Epic Games Store (Multi-Account)
    const epicAccounts = accountsData.epic?.accounts?.length > 0
      ? accountsData.epic.accounts
      : [getActiveAccount('epic')].filter(Boolean);

    sendLog(`\n--- 🎮 [EPIC GAMES STORE] (${epicAccounts.length} account(s) configured) ---`);
    const { currentFreeGames } = await getPromotions().catch(e => {
      sendLog(`⚠️ Could not fetch Epic promotions: ${e.message}`);
      return { currentFreeGames: [] };
    });

    if (currentFreeGames.length > 0 && epicAccounts.length > 0) {
      for (const acc of epicAccounts) {
        if (isClaimAbortRequested) break;
        const freshHistory = loadHistory();
        const unclaimed = currentFreeGames.filter(g => !isGameClaimed(freshHistory, g, acc.id));
        if (unclaimed.length === 0) {
          sendLog(`✅ All Epic promotions already claimed/owned for ${acc.username || acc.id}.`);
          continue;
        }

        sendLog(`\n👉 Processing ${unclaimed.length} game(s) for Epic account: ${acc.username || acc.id}`);
        for (const game of unclaimed) {
          if (isClaimAbortRequested) {
            sendLog('🛑 Automation stopped by user.');
            break;
          }
          try {
            const res = await claimEpicGameNative(game, acc, {
              logger: sendLog,
              isHeadless,
            });

            if (res && res.status === 'claimed') {
              claimedGames.push(`${game.title} (${acc.username || 'Epic'})`);
            }
          } catch (err) {
            sendLog(`❌ Error claiming "${game.title}" for Epic account ${acc.username || acc.id}: ${err.message}`);
          }
        }
      }
    }

    if (isClaimAbortRequested) {
      sendLog('\n🛑 [Auto-Claim] Automation aborted by user.');
      return;
    }

    // 2. GOG.com (Multi-Account)
    const gogAccounts = accountsData.gog?.accounts?.length > 0
      ? accountsData.gog.accounts
      : [getActiveAccount('gog')].filter(Boolean);

    sendLog(`\n--- 👾 [GOG.COM] (${gogAccounts.length} account(s) configured) ---`);
    const gogGiveaway = await getGogGiveawayFastOrBrowser().catch(() => null);

    if (gogGiveaway?.active && gogGiveaway?.title && gogAccounts.length > 0) {
      const gameObj = { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' };
      for (const acc of gogAccounts) {
        const freshHistory = loadHistory();
        if (isGameClaimed(freshHistory, gameObj, acc.id)) {
          sendLog(`✅ GOG giveaway "${gogGiveaway.title}" already claimed for ${acc.username || acc.id}.`);
          continue;
        }

        sendLog(`\n👉 Claiming GOG giveaway "${gogGiveaway.title}" for account: ${acc.username || acc.id}`);
        const gogRes = await claimGogNative(acc, {
          headless: isHeadless,
          logger: sendLog,
        });
        if (gogRes && gogRes.status === 'claimed') {
          claimedGames.push(`${gogGiveaway.title} (${acc.username || 'GOG'})`);
        }
      }
    }

    sendLog('\n✨ [Auto-Claim] Background processing completed.');

    // Native Cross-Platform System Notification
    if (claimedGames.length > 0) {
      sendNotification(
        'Claimr - Free Games Auto-Claimed! 🎁',
        `Successfully claimed: ${claimedGames.join(', ')}`
      );
    } else if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
      const titles = currentFreeGames.map(g => g.title).join(' & ');
      sendNotification(
        'Claimr - Library Verified ✅',
        `All active offers (${titles}) are verified in your library!`
      );
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:updated');
    }
  } catch (err) {
    sendLog(`❌ [Auto-Claim] Error during scheduled claim: ${err.message}`);
  } finally {
    isClaimingInProgress = false;
  }
}

/**
 * Smart, lightweight checker.
 * Runs in ~300ms via HTTP API without opening Chromium.
 * Launches headless browser only if genuine unclaimed freebies are found.
 */
async function checkForNewUnclaimedFreebies(verbose = false) {
  const settings = loadSettings();
  if (!settings.autoClaim) return;
  if (isClaimingInProgress) return;

  const sendLog = (msg) => {
    console.log(msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claim:log', msg);
    }
  };

  if (verbose) {
    sendLog('🔍 [Auto-Claim] Checking active giveaways on Epic Games & GOG...');
  }

  try {
    const history = loadHistory();
    const accountsData = loadAccounts();
    const epicAccounts = accountsData.epic?.accounts?.length > 0
      ? accountsData.epic.accounts
      : [getActiveAccount('epic')].filter(Boolean);
    const gogAccounts = accountsData.gog?.accounts?.length > 0
      ? accountsData.gog.accounts
      : [getActiveAccount('gog')].filter(Boolean);

    let hasUnclaimed = false;

    // 1. Check Epic promotions
    const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
    if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0 && epicAccounts.length > 0) {
      for (const game of currentFreeGames) {
        for (const acc of epicAccounts) {
          if (!isGameClaimed(history, game, acc.id)) {
            sendLog(`🎁 [Auto-Claim] Detected unclaimed game: "${game.title}" on Epic for ${acc.username || acc.id}!`);
            hasUnclaimed = true;
            break;
          }
        }
        if (hasUnclaimed) break;
      }
    }

    // 2. Check GOG promotions
    if (!hasUnclaimed && gogAccounts.length > 0) {
      const gogGiveaway = await getGogGiveawayFastOrBrowser().catch(() => null);
      if (gogGiveaway?.active && gogGiveaway?.title) {
        const gameObj = { id: `gog_${gogGiveaway.title}`, title: gogGiveaway.title, slug: 'gog' };
        for (const acc of gogAccounts) {
          if (!isGameClaimed(history, gameObj, acc.id)) {
            sendLog(`🎁 [Auto-Claim] Detected unclaimed giveaway: "${gogGiveaway.title}" on GOG for ${acc.username || acc.id}!`);
            hasUnclaimed = true;
            break;
          }
        }
      }
    }

    if (hasUnclaimed) {
      sendLog('🚀 [Auto-Claim] Launching autonomous background claimer...');
      await executeAutoClaimInBackground();
    } else {
      if (verbose) {
        sendLog('✨ [Auto-Claim] All promotions are already claimed across your accounts. Monitoring in the background!');
      } else {
        console.log('✨ [Auto-Claim] All promotions are up-to-date across all accounts.');
      }
    }
  } catch (err) {
    sendLog(`❌ [Auto-Claim] Background check error: ${err.message}`);
  }
}

function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  // Smart polling: Lightweight background check every 45 minutes
  schedulerInterval = setInterval(() => checkForNewUnclaimedFreebies(false), 45 * 60 * 1000);

  // Listen for system resume from sleep / screen unlock (macOS & Windows)
  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      console.log('⚡ [Auto-Claim] System resumed from sleep. Checking for new games in background...');
      setTimeout(() => checkForNewUnclaimedFreebies(false), 3000);
    });
    powerMonitor.on('unlock-screen', () => {
      console.log('⚡ [Auto-Claim] Screen unlocked. Checking for new games in background...');
      setTimeout(() => checkForNewUnclaimedFreebies(false), 3000);
    });
  }
}

ipcMain.handle('service:get-status', async () => {
  const settings = loadSettings();
  return { active: !!settings.autoClaim };
});

ipcMain.handle('headless:get-status', async () => {
  const settings = loadSettings();
  return { active: settings.headless !== false };
});

ipcMain.handle('headless:toggle', async (_event, shouldEnable) => {
  const settings = loadSettings();
  settings.headless = !!shouldEnable;
  saveSettings(settings);

  console.log(`⚙️ Headless Mode is now: ${settings.headless ? 'ENABLED' : 'DISABLED'}`);
  return { active: settings.headless };
});

ipcMain.handle('service:toggle', async (_event, shouldEnable) => {
  const settings = loadSettings();
  settings.autoClaim = !!shouldEnable;
  saveSettings(settings);

  console.log(`⚙️ Cross-Platform Auto-Claim is now: ${settings.autoClaim ? 'ENABLED' : 'DISABLED'}`);

  // Configure auto-launch at login across macOS & Windows
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.autoClaim,
      openAsHidden: true,
    });
  } catch (e) {
    console.warn('Could not set login item settings:', e.message);
  }

  // Synchronize with OS-level macOS LaunchAgent
  if (process.platform === 'darwin') {
    try {
      const scriptPath = path.join(ROOT_DIR, 'scripts', 'service.js');
      if (settings.autoClaim) {
        execSync(`node "${scriptPath}" install`, { stdio: 'ignore' });
      } else {
        execSync(`node "${scriptPath}" uninstall`, { stdio: 'ignore' });
      }
    } catch (e) {
      console.warn('Could not sync LaunchAgent:', e.message);
    }
  }

  return { active: settings.autoClaim };
});

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------

app.whenReady().then(async () => {
  if (process.argv.includes('--login:epic') || (process.argv.includes('--login') && !process.argv.includes('--login:gog'))) {
    console.log('\n========================================');
    console.log('🔑 EPIC GAMES LOGIN (NATIVE WINDOW)');
    console.log('Opening native login window. Please complete sign in...');
    console.log('========================================\n');
    const activeEpic = getActiveAccount('epic');
    const accountId = activeEpic ? activeEpic.id : `acc_${Date.now()}`;
    const relPath = activeEpic?.profileDir || path.join('.profiles', 'epic', accountId);
    const fullPath = getFullProfileDir(relPath, 'epic');
    const result = await openEpicLoginWindow({ accountId, relPath, fullPath, isNew: !activeEpic });
    if (result && result.success) {
      console.log(`\n🎉 Successfully logged in as: ${result.username}`);
      app.quit();
    } else {
      console.error(`\n❌ Login incomplete: ${result?.error || 'Cancelled'}`);
      app.quit();
    }
    return;
  }

  console.log('\n========================================');
  console.log('🎮 CLAIMR DESKTOP APP IS STARTING');
  console.log('========================================');

  createWindow();
  createTray();
  startScheduler();

  // Background readiness check for browser engine on first launch
  ensurePlaywrightBrowser((msg) => {
    console.log(`[Browser Engine] ${msg}`);
  }).catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
