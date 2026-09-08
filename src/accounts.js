import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CLAIMR_DATA_DIR || ROOT_DIR;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

/**
 * Default structure if accounts.json doesn't exist.
 */
function getDefaultStructure() {
  return {
    epic: {
      activeId: null,
      accounts: [],
    },
    gog: {
      activeId: null,
      accounts: [],
    },
  };
}

/**
 * Loads accounts registry from disk.
 */
export function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
      // Ensure required structure exists
      if (!data.epic) data.epic = { activeId: null, accounts: [] };
      if (!data.gog) data.gog = { activeId: null, accounts: [] };
      return data;
    }
  } catch (err) {
    console.warn('⚠️ Could not load accounts.json, using default structure:', err.message);
  }

  const defaults = getDefaultStructure();
  saveAccounts(defaults);
  return defaults;
}

/**
 * Saves accounts registry to disk.
 */
export function saveAccounts(accountsData) {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), 'utf-8');
  } catch (err) {
    console.error('❌ Failed to save accounts.json:', err.message);
  }
}

/**
 * Gets the active account object for a store.
 */
export function getActiveAccount(store) {
  const data = loadAccounts();
  const storeData = data[store];
  if (!storeData || !storeData.accounts || storeData.accounts.length === 0) {
    return null;
  }
  const active = storeData.accounts.find((a) => a.id === storeData.activeId);
  return active || storeData.accounts[0] || null;
}

/**
 * Gets absolute directory path for the active account of a store.
 */
export function getActiveProfileDir(store) {
  const active = getActiveAccount(store);
  if (!active || !active.profileDir) {
    return path.join(DATA_DIR, store === 'epic' ? '.profile' : '.profile-gog');
  }
  return path.isAbsolute(active.profileDir)
    ? active.profileDir
    : path.join(DATA_DIR, active.profileDir);
}

/**
 * Sets the active account for a store.
 */
export function setActiveAccount(store, accountId) {
  const data = loadAccounts();
  if (!data[store]) return null;

  const target = data[store].accounts.find((a) => a.id === accountId);
  if (!target) {
    throw new Error(`Account ID ${accountId} not found for store ${store}`);
  }

  data[store].activeId = accountId;
  target.lastUsed = Date.now();
  saveAccounts(data);
  return target;
}

/**
 * Registers or updates an account in the registry.
 */
export function registerAccount(store, { id, username, profileDir }) {
  const data = loadAccounts();
  if (!data[store]) {
    data[store] = { activeId: null, accounts: [] };
  }

  const existingIndex = data[store].accounts.findIndex((a) => a.id === id);
  const accountRecord = {
    id,
    username: username || 'User',
    profileDir,
    lastUsed: Date.now(),
  };

  if (existingIndex !== -1) {
    data[store].accounts[existingIndex] = {
      ...data[store].accounts[existingIndex],
      ...accountRecord,
    };
  } else {
    data[store].accounts.push({
      ...accountRecord,
      createdAt: Date.now(),
    });
  }

  // Set newly added or updated account as active
  data[store].activeId = id;
  saveAccounts(data);
  return accountRecord;
}

/**
 * Removes an account from the registry.
 */
export function removeAccount(store, accountId) {
  const data = loadAccounts();
  if (!data[store] || !data[store].accounts) return false;

  const initialCount = data[store].accounts.length;
  const targetAccount = data[store].accounts.find((a) => a.id === accountId);
  
  data[store].accounts = data[store].accounts.filter((a) => a.id !== accountId);

  // If deleted account was active, pick the next available or set null
  if (data[store].activeId === accountId) {
    data[store].activeId = data[store].accounts.length > 0 ? data[store].accounts[0].id : null;
  }

  saveAccounts(data);

  // If profile was in a custom subfolder under .profiles, delete it
  if (targetAccount && targetAccount.profileDir && targetAccount.profileDir.includes('.profiles')) {
    const fullPath = path.isAbsolute(targetAccount.profileDir)
      ? targetAccount.profileDir
      : path.join(DATA_DIR, targetAccount.profileDir);
    try {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.warn(`Could not delete profile folder ${fullPath}:`, e.message);
    }
  }

  return data[store].accounts.length < initialCount;
}

/**
 * Generates an isolated profile path for a new account.
 */
export function createNewProfileDir(store) {
  const id = `acc_${Date.now()}`;
  const relPath = path.join('.profiles', store, id);
  const fullPath = path.join(DATA_DIR, relPath);
  fs.mkdirSync(fullPath, { recursive: true });
  return { id, relPath, fullPath };
}
