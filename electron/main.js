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
        c.name === 'EPIC_EG1'
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

  // GOG check
  try {
    const gogContext = await launchGogBrowser({ headless: true });
    const gogPage = gogContext.pages().length > 0 ? gogContext.pages()[0] : await gogContext.newPage();
    await gogPage.goto('https://www.gog.com/userData.json', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const bodyText = await gogPage.innerText('body');
    try {
      const data = JSON.parse(bodyText);
      if (data.isLoggedIn && data.username) {
        gogUser = data.username;
        const active = getActiveAccount('gog');
        if (active) registerAccount('gog', { ...active, username: data.username });
      }
    } catch {}
    await gogContext.close();
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
          const isOwned = await isGameInGogLibrary(gogGiveaway.title, { profileDir: target.profileDir });
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
        const isOwned = await isGameInGogLibrary(title, { profileDir: activeGog.profileDir });
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
        const isOwned = gogGiveaway.isAlreadyClaimed || await isGameInGogLibrary(gogGiveaway.title, { profileDir: activeGog.profileDir });
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

  // Remove "Electron/X.X" and "Claimr/X.X" from User-Agent so Google OAuth and Arkose Labs
  // see a 100% genuine consumer Google Chrome / Chromium browser.
  const rawUa = ses.getUserAgent();
  const cleanUa = rawUa
    .replace(/\s*Electron\/[0-9\.]+/g, '')
    .replace(/\s*Claimr\/[0-9\.]+/g, '');
  ses.setUserAgent(cleanUa);

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

    const checkLoginStatus = async () => {
      if (resolved || loginWin.isDestroyed()) return;

      try {
        const cookies = await ses.cookies.get({});
        const hasAuth = cookies.some((c) =>
          c.name === 'EPIC_BEARER_TOKEN' ||
          c.name === 'EPIC_SSO' ||
          c.name === 'EPIC_EG1'
        );

        if (!hasAuth) return;

        const currentUrl = loginWin.webContents.getURL() || '';
        // If the user is still on any login, account, or password page, they are still completing sign in.
        const isAuthFlow = currentUrl.includes('/id/login') ||
                           currentUrl.includes('/id/api') ||
                           currentUrl.includes('accounts.epicgames.com');
        if (isAuthFlow) return;

        // Check if user has redirected to the store or home page
        const isStoreHome = currentUrl.includes('store.epicgames.com') ||
                            (currentUrl.includes('epicgames.com') && !isAuthFlow);
        if (!isStoreHome) return;

        // Try to fetch authentic Epic display name from DOM or session
        let displayName = null;
        try {
          displayName = await loginWin.webContents.executeJavaScript(`
            (() => {
              const nav = document.querySelector('egs-navigation');
              if (nav) {
                const loggedIn = nav.getAttribute('isloggedin') === 'true';
                const name = nav.getAttribute('displayname');
                if (loggedIn && name && name !== 'null') return name;
              }
              const dropdown = document.querySelector('[data-testid="user-dropdown"]');
              if (dropdown && dropdown.innerText.trim()) return dropdown.innerText.trim();
              return null;
            })()
          `);
        } catch {}

        if (!displayName) {
          try {
            const accData = await loginWin.webContents.executeJavaScript(`
              fetch('https://www.epicgames.com/id/api/account', { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
            `);
            if (accData && accData.displayName && accData.displayName.trim()) {
              displayName = accData.displayName.trim();
            }
          } catch {}
        }

        // Only complete once confirmed on store page with genuine user identity
        if (displayName) {
          resolved = true;
          cleanup();

          const username = displayName;
          console.log(`✅ Epic Games authentication confirmed for: ${username}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claim:log', `✅ Epic Games authentication confirmed for: ${username}`);
          }

          // Format cookies for Playwright persistent context
          const playwrightCookies = cookies.map((c) => ({
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
    const res = await loginNewGogAccount();
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

ipcMain.handle('store:login-gog', async () => {
  console.log('🔑 Opening GOG login window...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claim:log', '🔑 Opening browser for GOG login...');
  }
  try {
    const res = await loginGog();
    if (res && res.success) {
      const active = getActiveAccount('gog');
      if (active) {
        registerAccount('gog', { ...active, username: res.username });
      } else {
        registerAccount('gog', { id: 'default', username: res.username, profileDir: '.profile-gog' });
      }
    }
    return res;
  } catch (err) {
    console.error('GOG login error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('store:claim-all', async () => {
  if (isClaimingInProgress) {
    return { error: 'Claiming process is already running.' };
  }
  await executeAutoClaimInBackground();
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

  // Clean User-Agent matching standard Chrome
  const rawUa = ses.getUserAgent();
  const cleanUa = rawUa
    .replace(/\s*Electron\/[0-9\.]+/g, '')
    .replace(/\s*Claimr\/[0-9\.]+/g, '');
  ses.setUserAgent(cleanUa);

  return new Promise((resolve) => {
    let resolved = false;
    let pollInterval = null;
    let timeoutTimer = null;

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
    };

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        if (!claimWin.isDestroyed()) {
          claimWin.close();
        }
      } catch (_) {}
      resolve(result);
    };

    claimWin.on('closed', () => {
      cleanup();
      if (!resolved) {
        resolved = true;
        resolve({ status: 'cancelled', message: 'Claim window was closed.' });
      }
    });

    // 2-minute safety timeout
    timeoutTimer = setTimeout(() => {
      finish({ status: 'failed', error: 'Claim process timed out after 2 minutes.' });
    }, 120000);

    let stage = 'loading'; // 'loading' | 'clicked_get' | 'checkout'
    let getClickedAt = 0;
    let placeOrderAttempts = 0;

    const checkStep = async () => {
      if (resolved || claimWin.isDestroyed()) return;

      try {
        const title = claimWin.getTitle() || '';

        // If Cloudflare or Turnstile interstitial appears, ensure window is visible
        if (title.includes('Just a moment') || title.includes('One more step')) {
          if (!claimWin.isVisible()) {
            claimWin.show();
            claimWin.focus();
            logger('🛡️ Security verification required. Showing browser window...');
          }
          return;
        }

        // Handle age verification / mature content dialogs
        await claimWin.webContents.executeJavaScript(`
          (() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => {
              const t = (b.innerText || '').trim();
              return ['Continue', 'CONTINUE', 'Accept', 'ACCEPT', 'Yes', 'YES', 'Yes, buy now', 'I Understand', 'Dismiss', 'OK'].includes(t);
            });
            if (btn) btn.click();
          })()
        `).catch(() => {});

        // Stage 1: Store page loading & button check
        if (stage === 'loading') {
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

          // 1. Check order confirmation in main document
          const isConfirmed = await claimWin.webContents.executeJavaScript(`
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

              // Check if "Is Epic Games Launcher installed?" post-purchase modal appeared
              const launcherPrompt = Array.from(document.querySelectorAll('div, h1, h2, h3, p')).find(el => {
                return (el.innerText || '').includes('Is Epic Games Launcher installed?');
              });
              if (launcherPrompt) return true;

              return false;
            })()
          `).catch(() => false);

          if (isConfirmed) {
            logger(`🎉 Order Confirmed! Successfully claimed "${game.title}".`);
            const history = loadHistory();
            recordClaim(history, game, 'claimed', account?.id, account?.username);
            sendNotification('Game Claimed! 🎮', `"${game.title}" has been successfully claimed on Epic Games Store!`);
            return finish({ status: 'claimed' });
          }

          // 2. Accept EULA or consent checkboxes if present
          await claimWin.webContents.executeJavaScript(`
            (() => {
              const eula = document.querySelector('input#agree, input#eula, input[name="agree"]');
              if (eula && !eula.checked) eula.click();
              const acceptBtn = Array.from(document.querySelectorAll('button')).find(b => {
                const t = (b.innerText || '').trim().toLowerCase();
                return t === 'i accept' || t === 'i agree' || t === 'accept';
              });
              if (acceptBtn) acceptBtn.click();
            })()
          `).catch(() => {});

          // 3. Scan main document for Place Order button
          const mainClick = await claimWin.webContents.executeJavaScript(`
            (() => {
              const placeBtn = Array.from(document.querySelectorAll('button')).find(b => {
                if (b.getAttribute('data-testid') === 'purchase-cta-button') return false;
                const txt = (b.innerText || '').toLowerCase().trim();
                return txt === 'place order' || txt === 'add to library' || b.classList.contains('payment-btn--primary') || b.classList.contains('payment-order-confirm__btn');
              });
              if (placeBtn) {
                placeBtn.click();
                return true;
              }
              return false;
            })()
          `).catch(() => false);

          if (mainClick) {
            placeOrderAttempts++;
            logger(`👉 Clicked "Place Order" button in checkout (attempt ${placeOrderAttempts})...`);
          }

          // 4. Scan checkout iframes
          for (const frame of claimWin.webContents.mainFrame.frames) {
            try {
              const frameResult = await frame.executeJavaScript(`
                (() => {
                  const body = document.body ? document.body.innerText : '';
                  if (body.includes('Thank you for buying') || body.includes('Thanks for your order') || body.includes('Order Confirmed')) {
                    return 'confirmed';
                  }

                  const eula = document.querySelector('input#agree, input#eula, input[name="agree"]');
                  if (eula && !eula.checked) eula.click();

                  const placeBtn = Array.from(document.querySelectorAll('button')).find(b => {
                    const txt = (b.innerText || '').toLowerCase().trim();
                    return txt === 'place order' || txt === 'add to library' || b.classList.contains('payment-btn--primary') || b.classList.contains('payment-order-confirm__btn');
                  });
                  if (placeBtn) {
                    placeBtn.click();
                    return 'clicked';
                  }
                  return null;
                })()
              `);

              if (frameResult === 'confirmed') {
                logger(`🎉 Order Confirmed in iframe! Successfully claimed "${game.title}".`);
                const history = loadHistory();
                recordClaim(history, game, 'claimed', account?.id, account?.username);
                sendNotification('Game Claimed! 🎮', `"${game.title}" has been successfully claimed on Epic Games Store!`);
                return finish({ status: 'claimed' });
              }

              if (frameResult === 'clicked') {
                placeOrderAttempts++;
                logger(`👉 Clicked "Place Order" in checkout iframe (attempt ${placeOrderAttempts})...`);
              }
            } catch (_) {}
          }

          // 5. If 15+ seconds have elapsed since clicking Get, verify if the game is now "In Library"
          if (placeOrderAttempts > 0 && Date.now() - getClickedAt > 15000) {
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

          // 6. Check for Captcha in window
          const hasCaptcha = await claimWin.webContents.executeJavaScript(`
            (() => {
              return !!document.querySelector('iframe[src*="challenge"], iframe[src*="arkose"], iframe[src*="hcaptcha"], div#challenge-stage');
            })()
          `).catch(() => false);

          if (hasCaptcha && !claimWin.isVisible()) {
            claimWin.show();
            claimWin.focus();
            logger('🛡️ Security verification required. Please complete it in the window...');
            sendNotification('Claimr - Verification Required 🛡️', 'Epic Games requires verification to complete order.');
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

      const result = await claimGog({
        headless: isHeadless,
        logger: sendLog,
        accountId: activeGog?.id || 'default',
        username: activeGog?.username,
        profileDir: getFullProfileDir(activeGog?.profileDir, 'gog'),
      });
      sendLog(`✨ [COMPLETE] Automator finished for: ${gameTitle}`);
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
        const freshHistory = loadHistory();
        const unclaimed = currentFreeGames.filter(g => !isGameClaimed(freshHistory, g, acc.id));
        if (unclaimed.length === 0) {
          sendLog(`✅ All Epic promotions already claimed/owned for ${acc.username || acc.id}.`);
          continue;
        }

        sendLog(`\n👉 Processing ${unclaimed.length} game(s) for Epic account: ${acc.username || acc.id}`);
        for (const game of unclaimed) {
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
        const gogRes = await claimGog({
          headless: isHeadless,
          logger: sendLog,
          accountId: acc.id,
          username: acc.username,
          profileDir: getFullProfileDir(acc.profileDir, 'gog'),
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
