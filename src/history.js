import fs from 'fs';
import { CONFIG } from './config.js';

export function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.HISTORY_FILE)) {
      const data = fs.readFileSync(CONFIG.HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('⚠️ Warning: Could not read history file, starting fresh:', err.message);
  }
  return { claimed: {} };
}

export function saveHistory(history) {
  try {
    fs.writeFileSync(CONFIG.HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (err) {
    console.error('❌ Failed to save history file:', err.message);
  }
}

export function isGameClaimed(history, game, accountId = null) {
  if (!history?.claimed) return false;
  const candidateKeys = [game.id, game.slug, game.title].filter(Boolean);

  if (accountId) {
    // If this specific account has claimed the game under any candidate key
    for (const key of candidateKeys) {
      if (history.claimed[`${accountId}:${key}`]) return true;
    }

    // For the original 'default' account, also accept legacy records without account prefix
    if (accountId === 'default') {
      for (const key of candidateKeys) {
        if (history.claimed[key]) return true;
      }
    }

    // Swapped/secondary accounts are NOT blocked by another account's legacy claim!
    return false;
  }

  for (const key of candidateKeys) {
    if (history.claimed[key]) return true;
  }
  return false;
}

export function recordClaim(history, game, status = 'claimed', accountId = null, username = null) {
  if (!history.claimed) history.claimed = {};
  const gameKey = game.id || game.slug || game.title;
  const key = accountId ? `${accountId}:${gameKey}` : gameKey;
  history.claimed[key] = {
    title: game.title,
    slug: game.slug,
    id: game.id,
    accountId,
    accountName: username,
    claimedAt: new Date().toISOString(),
    status,
  };
  saveHistory(history);
}
