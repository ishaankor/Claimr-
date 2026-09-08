import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function getDataDir() {
  if (process.env.CLAIMR_DATA_DIR) {
    return process.env.CLAIMR_DATA_DIR;
  }
  // If running inside packaged Electron app (app.asar)
  if (ROOT_DIR.includes('app.asar')) {
    let userData;
    if (process.platform === 'darwin') {
      userData = path.join(os.homedir(), 'Library', 'Application Support', 'Claimr');
    } else if (process.platform === 'win32') {
      userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claimr');
    } else {
      userData = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claimr');
    }
    if (!fs.existsSync(userData)) {
      try {
        fs.mkdirSync(userData, { recursive: true });
      } catch {}
    }
    return userData;
  }
  return ROOT_DIR;
}

export const CONFIG = {
  ROOT_DIR,
  get DATA_DIR() {
    return getDataDir();
  },
  get PROFILE_DIR() {
    return path.join(getDataDir(), '.profile');
  },
  get HISTORY_FILE() {
    return path.join(getDataDir(), 'history.json');
  },
  LOCALE: 'en-US',
  COUNTRY: 'US',
  EPIC_FREE_PROMOTIONS_URL: 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions',
  EPIC_STORE_URL: 'https://store.epicgames.com',
  LOGIN_URL: 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https://store.epicgames.com/en-US/free-games',
  GOG_HOME_URL: 'https://www.gog.com/en',
  GOG_LOGIN_URL: 'https://login.gog.com/login',
  GOG_CLAIM_URL: 'https://www.gog.com/giveaway/claim',
  DEFAULT_TIMEOUT: 30000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};
