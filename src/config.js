import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAIMR_DATA_DIR || ROOT_DIR;

export const CONFIG = {
  ROOT_DIR,
  DATA_DIR,
  PROFILE_DIR: path.join(DATA_DIR, '.profile'),
  HISTORY_FILE: path.join(DATA_DIR, 'history.json'),
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
