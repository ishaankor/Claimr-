import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getPromotions } from '../src/api.js';
import { loadHistory, isGameClaimed, recordClaim } from '../src/history.js';
import { launchBrowser, ensureLoggedIn, claimGame, getEpicUsername, loginNewEpicAccount, isGameInEpicLibrary, syncEpicLibraryForAccount } from '../src/claimer.js';
import { claimGog, loginGog, launchGogBrowser, isGogLoggedIn, checkGogGiveaway, loginNewGogAccount, isGameInGogLibrary, getGogGiveawayFastOrBrowser } from '../src/gog.js';
import { loadAccounts, getActiveAccount, setActiveAccount, removeAccount, registerAccount } from '../src/accounts.js';
import { setCustomNotifier } from '../src/notify.js';

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

setCustomNotifier((title, message) => {
  if (Notification.isSupported()) {
    const iconPath = path.join(ROOT_DIR, 'assets', 'icon.png');
    new Notification({
      title,
      body: message,
      icon: iconPath,
    }).show();
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
    const epicContext = await launchBrowser({ headless: true });
    const epicPage = epicContext.pages().length > 0 ? epicContext.pages()[0] : await epicContext.newPage();
    const user = await getEpicUsername(epicPage);
    if (user) {
      epicUser = user;
      const active = getActiveAccount('epic');
      if (active) registerAccount('epic', { ...active, username: user });
    }
    await epicContext.close();
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
        const isOwned = await isGameInEpicLibrary(gameObj, { profileDir: activeEpic.profileDir });
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

ipcMain.handle('accounts:add', async (_event, { store }) => {
  console.log(`➕ Initiating new ${store} account login...`);
  if (store === 'epic') {
    const res = await loginNewEpicAccount();
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
    mainWindow.webContents.send('claim:log', '🔑 Opening browser for Epic Games login...');
  }
  const context = await launchBrowser({ headless: false });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  try {
    const ok = await ensureLoggedIn(page, {
      interactive: true,
      logger: (msg) => {
        console.log(msg);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('claim:log', msg);
        }
      },
    });
    if (ok) {
      const username = (await getEpicUsername(page)) || 'Epic User';
      let active = getActiveAccount('epic');
      if (active) {
        active = registerAccount('epic', { ...active, username });
      } else {
        active = registerAccount('epic', { id: 'default', username, profileDir: '.profile' });
      }
      try {
        const { currentFreeGames } = await getPromotions().catch(() => ({ currentFreeGames: [] }));
        if (Array.isArray(currentFreeGames) && currentFreeGames.length > 0) {
          const newlyOwned = await syncEpicLibraryForAccount(currentFreeGames, active, { page });
          if (newlyOwned.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:updated');
          }
        }
      } catch (e) {
        console.warn('Post-login library sync error:', e.message);
      }
    }
    return { success: !!ok };
  } catch (err) {
    console.error('Epic login error:', err);
    return { success: false, error: err.message };
  } finally {
    await context.close();
  }
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

  isClaimingInProgress = true;
  const sendLog = (msg) => {
    console.log(`[Claim Engine] ${msg}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claim:log', msg);
    }
  };

  try {
    sendLog('🚀 [START] Multi-store claiming session initialized.');

    // 1. Epic Games
    sendLog('\n--- 🎮 EPIC GAMES STORE ---');
    const activeEpic = getActiveAccount('epic');
    sendLog(`👤 Active Epic Profile: ${activeEpic?.username || 'Default'} (${activeEpic?.id || 'default'})`);
    sendLog('📡 Fetching active promotions...');
    const { currentFreeGames } = await getPromotions();
    sendLog(`Found ${currentFreeGames.length} active giveaway(s) on Epic.`);

    if (currentFreeGames.length > 0) {
      const epicContext = await launchBrowser({ headless: true, profileDir: activeEpic?.profileDir });
      const epicPage = epicContext.pages().length > 0 ? epicContext.pages()[0] : await epicContext.newPage();

      try {
        const loggedIn = await ensureLoggedIn(epicPage, { interactive: false, logger: sendLog });
        if (!loggedIn) {
          sendLog('❌ Epic authentication required. Click "Connect" to log in.');
        } else {
          const history = loadHistory();
          for (const game of currentFreeGames) {
            await claimGame(epicPage, game, history, {
              force: false,
              logger: sendLog,
              accountId: activeEpic?.id || 'default',
              username: activeEpic?.username,
            });
          }
        }
      } finally {
        await epicContext.close();
      }
    }

    // 2. GOG.com
    sendLog('\n--- 👾 GOG.COM ---');
    const activeGog = getActiveAccount('gog');
    sendLog(`👤 Active GOG Profile: ${activeGog?.username || 'Default'} (${activeGog?.id || 'default'})`);
    await claimGog({
      headless: true,
      logger: sendLog,
      accountId: activeGog?.id || 'default',
      username: activeGog?.username,
    });

    sendLog('\n✨ [COMPLETE] All store giveaways checked and processed!');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:updated');
    }
    return { success: true };
  } catch (err) {
    sendLog(`❌ Error during claim: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    isClaimingInProgress = false;
  }
});

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

  try {
    const isEpic = (store || '').toUpperCase() === 'EPIC';

    if (isEpic) {
      sendLog('\n========================================');
      sendLog(`🚀 [START] Single-game claim automator for: ${gameTitle}`);
      sendLog('🎮 Platform: Epic Games Store');

      const activeEpic = getActiveAccount('epic');
      sendLog(`👤 Active Epic Profile: ${activeEpic?.username || 'Default'} (${activeEpic?.id || 'default'})`);
      sendLog(`🔗 Target: ${storeUrl || gameTitle}`);

      const epicContext = await launchBrowser({ headless: true, profileDir: activeEpic?.profileDir });
      const epicPage = epicContext.pages().length > 0 ? epicContext.pages()[0] : await epicContext.newPage();

      try {
        const loggedIn = await ensureLoggedIn(epicPage, { interactive: false, logger: sendLog });
        if (!loggedIn) {
          sendLog('❌ Epic authentication required. Click "Connect" to log in.');
          return { success: false, error: 'Authentication required' };
        }

        const history = loadHistory();
        const game = { id: gameId, title: gameTitle, storeUrl };
        const result = await claimGame(epicPage, game, history, {
          force: true,
          logger: sendLog,
          accountId: activeEpic?.id || 'default',
          username: activeEpic?.username,
        });
        sendLog(`✨ [COMPLETE] Automator finished for: ${gameTitle}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('library:updated');
        }
        return { success: true, result };
      } finally {
        await epicContext.close();
      }
    } else {
      // GOG
      sendLog('\n========================================');
      sendLog(`🚀 [START] Single-game claim automator for: ${gameTitle}`);
      sendLog('👾 Platform: GOG.com');

      const activeGog = getActiveAccount('gog');
      sendLog(`👤 Active GOG Profile: ${activeGog?.username || 'Default'} (${activeGog?.id || 'default'})`);

      const result = await claimGog({
        headless: true,
        logger: sendLog,
        accountId: activeGog?.id || 'default',
        username: activeGog?.username,
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
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}
  return { autoClaim: false, lastCheckSlot: null, lastCheckDate: null };
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

  sendLog('\n========================================');
  sendLog('⏰ [Auto-Claim] Scheduled background check started...');
  sendLog(`🖥️ Platform: ${process.platform} • Active Stores: Epic Games & GOG`);

  const claimedGames = [];

  try {
    // 1. Epic Games Store
    sendLog('\n--- 🎮 [EPIC GAMES STORE] ---');
    const activeEpic = getActiveAccount('epic');
    sendLog(`👤 Active Epic Profile: ${activeEpic?.username || 'Default'} (${activeEpic?.id || 'default'})`);
    const { currentFreeGames } = await getPromotions();
    sendLog(`Found ${currentFreeGames.length} active Epic promotion(s).`);

    if (currentFreeGames.length > 0) {
      const epicContext = await launchBrowser({ headless: true });
      const epicPage = epicContext.pages().length > 0 ? epicContext.pages()[0] : await epicContext.newPage();
      try {
        const loggedIn = await ensureLoggedIn(epicPage, { interactive: false, logger: sendLog });
        if (loggedIn) {
          const history = loadHistory();
          for (const game of currentFreeGames) {
            const res = await claimGame(epicPage, game, history, {
              force: false,
              logger: sendLog,
              accountId: activeEpic?.id || 'default',
              username: activeEpic?.username,
            });
            if (res && res.status === 'claimed') {
              claimedGames.push(`${game.title} (Epic)`);
            }
          }
        } else {
          sendLog('⚠️ Epic login session expired. Please open Claimr to reconnect.');
        }
      } finally {
        await epicContext.close();
      }
    }

    // 2. GOG.com
    sendLog('\n--- 👾 [GOG.COM] ---');
    const activeGog = getActiveAccount('gog');
    sendLog(`👤 Active GOG Profile: ${activeGog?.username || 'Default'} (${activeGog?.id || 'default'})`);
    const gogRes = await claimGog({
      headless: true,
      logger: sendLog,
      accountId: activeGog?.id || 'default',
      username: activeGog?.username,
    });
    if (gogRes && gogRes.status === 'claimed') {
      claimedGames.push(`${gogRes.title} (GOG)`);
    }

    sendLog('✨ [Auto-Claim] Scheduled run completed.');

    // Native Cross-Platform System Notification
    if (claimedGames.length > 0 && Notification.isSupported()) {
      new Notification({
        title: 'Claimr - Free Games Claimed! 🎁',
        body: `Successfully claimed: ${claimedGames.join(', ')}`,
        icon: path.join(ROOT_DIR, 'assets', 'icon.png'),
      }).show();
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

function checkAndRunScheduledAutoClaim() {
  const settings = loadSettings();
  if (!settings.autoClaim) return;
  if (isClaimingInProgress) return;

  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const todayDateStr = now.toISOString().slice(0, 10);

  // Target slots:
  // Slot 1: 11:15 AM (11:15 to 11:45)
  // Slot 2: 8:15 PM  (20:15 to 20:45)
  let slot = null;
  if (currentHour === 11 && currentMin >= 15 && currentMin <= 45) {
    slot = `${todayDateStr}_11AM`;
  } else if (currentHour === 20 && currentMin >= 15 && currentMin <= 45) {
    slot = `${todayDateStr}_8PM`;
  }

  if (slot && settings.lastCheckSlot !== slot) {
    console.log(`⏰ [Auto-Claim Scheduler] Triggering scheduled check for slot: ${slot}`);
    settings.lastCheckSlot = slot;
    settings.lastCheckDate = now.toISOString();
    saveSettings(settings);
    executeAutoClaimInBackground();
  }
}

function startScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(checkAndRunScheduledAutoClaim, 30 * 1000);
  setTimeout(checkAndRunScheduledAutoClaim, 5000);
}

ipcMain.handle('service:get-status', async () => {
  const settings = loadSettings();
  return { active: !!settings.autoClaim };
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

  // Clean up legacy LaunchAgent on macOS if present
  if (process.platform === 'darwin') {
    try {
      execSync(`launchctl bootout gui/$(id -u)/com.user.epic-game-claimer 2>/dev/null || true`);
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.user.epic-game-claimer.plist');
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    } catch {}
  }

  return { active: settings.autoClaim };
});

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------

app.whenReady().then(() => {
  console.log('\n========================================');
  console.log('🎮 CLAIMR DESKTOP APP IS STARTING');
  console.log('========================================');

  createWindow();
  createTray();
  startScheduler();

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
