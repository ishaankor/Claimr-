import fs from 'fs';
import path from 'path';
import { getDataDir } from './config.js';

const getAccountsFile = () => path.join(getDataDir(), 'accounts.json');

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
  const file = getAccountsFile();
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Ensure required structure exists
      if (!data.epic) data.epic = { activeId: null, accounts: [] };
      if (!data.gog) data.gog = { activeId: null, accounts: [] };

      // Automatically deduplicate accounts with identical usernames
      let modified = false;
      for (const store of ['epic', 'gog']) {
        if (Array.isArray(data[store].accounts)) {
          const seen = new Map();
          const unique = [];
          for (const acc of data[store].accounts) {
            const key = (acc.username || acc.id || '').trim().toLowerCase();
            if (seen.has(key)) {
              // Found duplicate account! Keep the newest lastUsed time and profileDir
              const prior = seen.get(key);
              if (acc.lastUsed && (!prior.lastUsed || acc.lastUsed > prior.lastUsed)) {
                prior.profileDir = acc.profileDir || prior.profileDir;
                prior.lastUsed = acc.lastUsed;
              }
              if (data[store].activeId === acc.id) {
                data[store].activeId = prior.id;
              }
              modified = true;
            } else {
              seen.set(key, acc);
              unique.push(acc);
            }
          }
          data[store].accounts = unique;
          if (data[store].accounts.length > 0 && !data[store].accounts.some((a) => a.id === data[store].activeId)) {
            data[store].activeId = data[store].accounts[0].id;
            modified = true;
          }
        }
      }

      if (modified) {
        saveAccounts(data);
      }

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
    fs.writeFileSync(getAccountsFile(), JSON.stringify(accountsData, null, 2), 'utf-8');
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
 * Resolves a profile directory path into an absolute path guaranteed to be
 * located within the app data directory.
 * Strips any accidental leading root slashes (e.g. '/.profiles' -> '<DATA_DIR>/.profiles').
 * 
 * @param {string} [profileDir] - Stored profile path or relative path
 * @param {string} [store='epic'] - Target store identifier ('epic' | 'gog')
 * @returns {string} Fully qualified absolute directory path
 */
export function getFullProfileDir(profileDir, store = 'epic') {
  if (!profileDir) {
    return path.join(getDataDir(), store === 'epic' ? '.profile' : '.profile-gog');
  }
  let cleanDir = profileDir;
  if (typeof cleanDir === 'string' && (cleanDir.startsWith('/.profile') || cleanDir.startsWith('\\.profile'))) {
    cleanDir = cleanDir.replace(/^[/\\]+/, '');
  }
  if (path.isAbsolute(cleanDir)) {
    return cleanDir;
  }
  return path.resolve(getDataDir(), cleanDir);
}

/**
 * Gets absolute directory path for the active account of a store.
 */
export function getActiveProfileDir(store) {
  const active = getActiveAccount(store);
  return getFullProfileDir(active?.profileDir, store);
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
 * Prevents duplicate accounts with the same username from being registered multiple times.
 */
export function registerAccount(store, { id, username, profileDir }) {
  const data = loadAccounts();
  if (!data[store]) {
    data[store] = { activeId: null, accounts: [] };
  }

  // 1. Check if matching by explicit ID
  let existingIndex = data[store].accounts.findIndex((a) => a.id === id);

  // 2. Prevent duplicate entries for the same username
  if (existingIndex === -1 && username && username !== 'User' && username !== 'Epic User') {
    const existingByNameIndex = data[store].accounts.findIndex((a) =>
      a.username && a.username.trim().toLowerCase() === username.trim().toLowerCase()
    );
    if (existingByNameIndex !== -1) {
      existingIndex = existingByNameIndex;
    }
  }

  const effectiveId = existingIndex !== -1 ? data[store].accounts[existingIndex].id : id;
  const accountRecord = {
    id: effectiveId,
    username: username || 'User',
    profileDir: profileDir || (existingIndex !== -1 ? data[store].accounts[existingIndex].profileDir : null),
    lastUsed: Date.now(),
  };

  if (existingIndex !== -1) {
    data[store].accounts[existingIndex] = {
      ...data[store].accounts[existingIndex],
      ...accountRecord,
    };
    data[store].activeId = effectiveId;
  } else {
    data[store].accounts.push({
      ...accountRecord,
      createdAt: Date.now(),
    });
    data[store].activeId = id;
  }

  saveAccounts(data);
  return data[store].accounts[existingIndex !== -1 ? existingIndex : data[store].accounts.length - 1];
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
  if (targetAccount && targetAccount.profileDir && targetAccount.profileDir.includes('.profile')) {
    const fullPath = getFullProfileDir(targetAccount.profileDir, store);
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
  const fullPath = path.join(getDataDir(), relPath);
  fs.mkdirSync(fullPath, { recursive: true });
  return { id, relPath, fullPath };
}
