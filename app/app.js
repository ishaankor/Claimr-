// app/app.js - Claimr Frontend Controller

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const epicStatusText = document.getElementById('epicStatusText');
  const gogStatusText = document.getElementById('gogStatusText');

  const epicAccountBtn = document.getElementById('epicAccountBtn');
  const epicAccountBtnText = document.getElementById('epicAccountBtnText');
  const epicAccountChevron = document.getElementById('epicAccountChevron');
  const epicAccountMenu = document.getElementById('epicAccountMenu');
  const epicAccountList = document.getElementById('epicAccountList');
  const epicAddAccountBtn = document.getElementById('epicAddAccountBtn');

  const gogAccountBtn = document.getElementById('gogAccountBtn');
  const gogAccountBtnText = document.getElementById('gogAccountBtnText');
  const gogAccountChevron = document.getElementById('gogAccountChevron');
  const gogAccountMenu = document.getElementById('gogAccountMenu');
  const gogAccountList = document.getElementById('gogAccountList');
  const gogAddAccountBtn = document.getElementById('gogAddAccountBtn');

  const currentGamesGrid = document.getElementById('currentGamesGrid');
  const upcomingGamesGrid = document.getElementById('upcomingGamesGrid');
  const currentCountText = document.getElementById('currentCountText');

  const timerDays = document.getElementById('timerDays');
  const timerHours = document.getElementById('timerHours');
  const timerMinutes = document.getElementById('timerMinutes');
  const timerSeconds = document.getElementById('timerSeconds');

  const claimAllBtn = document.getElementById('claimAllBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  const terminalToggleBtn = document.getElementById('terminalToggleBtn');
  const terminalDrawer = document.getElementById('terminalDrawer');
  const terminalOutput = document.getElementById('terminalOutput');
  const clearConsoleBtn = document.getElementById('clearConsoleBtn');
  const closeConsoleBtn = document.getElementById('closeConsoleBtn');

  const serviceCheckbox = document.getElementById('serviceCheckbox');
  const historyBtn = document.getElementById('historyBtn');
  const historyModal = document.getElementById('historyModal');
  const closeHistoryModal = document.getElementById('closeHistoryModal');
  const historyList = document.getElementById('historyList');

  let nextDropDate = null;
  let countdownInterval = null;
  let currentAuth = null;
  let cachedStoreData = null;
  let isAutomatorRunning = false;

  const CACHE_KEY = 'claimr_cached_promotions_v1';

  function savePromotionsToCache(data) {
    try {
      if (data && (data.epic?.currentFreeGames?.length || data.epic?.upcomingFreeGames?.length || data.gog?.title)) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      }
    } catch {}
  }

  function loadPromotionsFromCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.epic || parsed.gog)) {
          return parsed;
        }
      }
    } catch {}
    return null;
  }

  // Instant 0ms render from cache if available
  cachedStoreData = loadPromotionsFromCache();

  // -------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------

  function logToTerminal(msg) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = msg;

    if (msg.includes('SUCCESS') || msg.includes('claimed')) {
      line.style.color = '#4ade80';
      line.style.fontWeight = '500';
    } else if (msg.includes('Error') || msg.includes('❌')) {
      line.style.color = '#f87171';
    } else if (msg.includes('👉') || msg.includes('🎮') || msg.includes('🔄')) {
      line.style.color = '#60a5fa';
    }

    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function openTerminal() {
    terminalDrawer.classList.add('open');
  }

  function closeTerminal() {
    terminalDrawer.classList.remove('open');
  }

  function closeAllAccountMenus() {
    if (epicAccountMenu) {
      epicAccountMenu.classList.remove('visible');
      epicAccountBtn.classList.remove('open');
    }
    if (gogAccountMenu) {
      gogAccountMenu.classList.remove('visible');
      gogAccountBtn.classList.remove('open');
    }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#epicAccountCard') && !e.target.closest('#gogAccountCard')) {
      closeAllAccountMenus();
    }
  });

  // -------------------------------------------------------------
  // Account List Rendering & Management
  // -------------------------------------------------------------

  function renderAccountItems(store, accounts, activeId, container) {
    if (!container) return;
    container.innerHTML = '';

    if (!accounts || accounts.length === 0) {
      container.innerHTML = '<div style="font-size:0.75rem;color:var(--text-dim);padding:6px 8px;">No saved accounts</div>';
      return;
    }

    accounts.forEach((acc) => {
      const item = document.createElement('div');
      item.className = `account-item ${acc.id === activeId ? 'active' : ''}`;

      const left = document.createElement('div');
      left.className = 'account-item-left';

      const dot = document.createElement('span');
      dot.className = 'account-item-dot';
      left.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'account-item-name';
      name.textContent = acc.username || 'User';
      left.appendChild(name);

      item.appendChild(left);

      const right = document.createElement('div');
      right.className = 'account-item-right';

      if (acc.id === activeId) {
        const badge = document.createElement('span');
        badge.className = 'account-active-badge';
        badge.textContent = 'Active';
        right.appendChild(badge);
      } else {
        const swapBtn = document.createElement('button');
        swapBtn.className = 'account-swap-btn';
        swapBtn.textContent = 'Swap';
        swapBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          swapBtn.disabled = true;
          swapBtn.textContent = '...';
          try {
            await window.claimrAPI.swapAccount(store, acc.id);
            logToTerminal(`🔄 Swapped active ${store.toUpperCase()} account to: ${acc.username}`);
            await refreshAuthStatus({ fast: true });
            closeAllAccountMenus();
            await renderGames();
          } catch (err) {
            logToTerminal(`❌ Error swapping account: ${err.message}`);
          }
        });
        right.appendChild(swapBtn);
      }

      if (accounts.length > 1) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'account-item-remove';
        removeBtn.title = 'Remove account';
        removeBtn.innerHTML = '✕';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Remove account "${acc.username}"?`)) {
            await window.claimrAPI.removeAccount(store, acc.id);
            logToTerminal(`🗑️ Removed ${store.toUpperCase()} account: ${acc.username}`);
            await refreshAuthStatus({ fast: true });
            await renderGames();
          }
        });
        right.appendChild(removeBtn);
      }

      item.appendChild(right);
      container.appendChild(item);
    });
  }

  // -------------------------------------------------------------
  // Authentication Checks & Event Listeners
  // -------------------------------------------------------------

  async function refreshAuthStatus({ fast = false } = {}) {
    try {
      const auth = await window.claimrAPI.checkAuth({ fast });
      currentAuth = auth;

      // Epic
      if (auth.epic) {
        epicStatusText.textContent = `Signed in as ${auth.epicUsername || 'Active'}`;
        epicStatusText.classList.add('status-connected');
        epicAccountBtnText.textContent = 'Swap Account';
        epicAccountChevron.style.display = 'inline-block';
      } else {
        epicStatusText.textContent = 'Not signed in';
        epicStatusText.classList.remove('status-connected');
        epicAccountBtnText.textContent = 'Connect';
        epicAccountChevron.style.display = 'none';
      }
      renderAccountItems('epic', auth.epicAccounts, auth.epicActiveId, epicAccountList);

      // GOG
      if (auth.gog) {
        gogStatusText.textContent = `Signed in as ${auth.gogUsername || 'Active'}`;
        gogStatusText.classList.add('status-connected');
        gogAccountBtnText.textContent = 'Swap Account';
        gogAccountChevron.style.display = 'inline-block';
      } else {
        gogStatusText.textContent = 'Not signed in';
        gogStatusText.classList.remove('status-connected');
        gogAccountBtnText.textContent = 'Connect';
        gogAccountChevron.style.display = 'none';
      }
      renderAccountItems('gog', auth.gogAccounts, auth.gogActiveId, gogAccountList);

      return auth;
    } catch (e) {
      console.error('Failed to check auth:', e);
    }
  }

  epicAccountBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (epicAccountBtnText.textContent === 'Connect') {
      epicAccountBtn.disabled = true;
      epicAccountBtnText.textContent = 'Opening...';
      openTerminal();
      logToTerminal('🔑 Opening browser for Epic Games login...');
      try {
        const res = await window.claimrAPI.loginEpic();
        if (res && res.error) {
          logToTerminal(`⚠️ Epic login notice: ${res.error}`);
        }
        await refreshAuthStatus();
      } catch (err) {
        logToTerminal(`❌ Epic login error: ${err.message}`);
      } finally {
        epicAccountBtn.disabled = false;
        if (!currentAuth || !currentAuth.epic) {
          epicAccountBtnText.textContent = 'Connect';
        }
      }
    } else {
      const isVisible = epicAccountMenu.classList.contains('visible');
      closeAllAccountMenus();
      if (!isVisible) {
        epicAccountMenu.classList.add('visible');
        epicAccountBtn.classList.add('open');
      }
    }
  });

  gogAccountBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (gogAccountBtnText.textContent === 'Connect') {
      gogAccountBtn.disabled = true;
      gogAccountBtnText.textContent = 'Opening...';
      openTerminal();
      logToTerminal('🔑 Opening browser for GOG login...');
      try {
        const res = await window.claimrAPI.loginGog();
        if (res && res.error) {
          logToTerminal(`⚠️ GOG login notice: ${res.error}`);
        }
        await refreshAuthStatus();
      } catch (err) {
        logToTerminal(`❌ GOG login error: ${err.message}`);
      } finally {
        gogAccountBtn.disabled = false;
        if (!currentAuth || !currentAuth.gog) {
          gogAccountBtnText.textContent = 'Connect';
        }
      }
    } else {
      const isVisible = gogAccountMenu.classList.contains('visible');
      closeAllAccountMenus();
      if (!isVisible) {
        gogAccountMenu.classList.add('visible');
        gogAccountBtn.classList.add('open');
      }
    }
  });

  epicAddAccountBtn.addEventListener('click', async () => {
    epicAddAccountBtn.disabled = true;
    epicAddAccountBtn.textContent = 'Opening browser login...';
    try {
      openTerminal();
      logToTerminal('🔑 Opening browser to connect a new Epic Games account...');
      const res = await window.claimrAPI.addAccount('epic');
      if (res && res.success) {
        logToTerminal(`🎉 New Epic account connected: ${res.account?.username}`);
        await refreshAuthStatus({ fast: true });
        closeAllAccountMenus();
        await renderGames();
      } else {
        logToTerminal(`⚠️ Epic login incomplete: ${res?.error || 'Cancelled'}`);
      }
    } finally {
      epicAddAccountBtn.disabled = false;
      epicAddAccountBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>Add Another Account</span>`;
    }
  });

  gogAddAccountBtn.addEventListener('click', async () => {
    gogAddAccountBtn.disabled = true;
    gogAddAccountBtn.textContent = 'Opening browser login...';
    try {
      openTerminal();
      logToTerminal('Opening browser to connect a new GOG account...');
      const res = await window.claimrAPI.addAccount('gog');
      if (res && res.success) {
        logToTerminal(`New GOG account connected: ${res.account?.username}`);
        await refreshAuthStatus({ fast: true });
        closeAllAccountMenus();
        await renderGames();
      } else {
        logToTerminal(`GOG login incomplete: ${res?.error || 'Cancelled'}`);
      }
    } finally {
      gogAddAccountBtn.disabled = false;
      gogAddAccountBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>Add Another Account</span>`;
    }
  });

  // -------------------------------------------------------------
  // Load Games & Promotions
  // -------------------------------------------------------------

  async function loadGames({ forceFetch = false } = {}) {
    // Only display loading spinner if we have NO cached games to display
    const hasExistingContent = !!(
      cachedStoreData?.epic?.currentFreeGames?.length ||
      cachedStoreData?.epic?.upcomingFreeGames?.length ||
      cachedStoreData?.gog?.active
    );

    if (!hasExistingContent) {
      currentGamesGrid.innerHTML = '<div class="loading-state">Fetching active store offers...</div>';
      upcomingGamesGrid.innerHTML = '<div class="loading-state">Fetching upcoming games...</div>';
    }

    try {
      // 1. Fetch Epic Games (blazing fast ~120ms REST API)
      const epicPromise = window.claimrAPI.getEpicGames
        ? window.claimrAPI.getEpicGames()
        : window.claimrAPI.getAllGames().then(res => res.epic);

      // 2. Fetch GOG Giveaway in parallel (~400ms fast SSR check)
      const gogPromise = window.claimrAPI.getGogGame
        ? window.claimrAPI.getGogGame()
        : Promise.resolve({ active: false });

      // Progressive render: Render Epic games the instant they arrive (~120ms)
      const epicResolvePromise = epicPromise.then(async (epicPromos) => {
        if (epicPromos && (Array.isArray(epicPromos.currentFreeGames) || Array.isArray(epicPromos.upcomingFreeGames))) {
          cachedStoreData = {
            epic: epicPromos,
            gog: cachedStoreData?.gog || { active: false },
          };
          savePromotionsToCache(cachedStoreData);
          await renderGames();
        }
      }).catch(err => {
        console.warn('Epic promotions notice:', err);
      });

      // Progressive render: When GOG resolves (~400ms), update current grid seamlessly
      const gogResolvePromise = gogPromise.then(async (gogGiveaway) => {
        if (gogGiveaway) {
          cachedStoreData = {
            epic: cachedStoreData?.epic || { currentFreeGames: [], upcomingFreeGames: [] },
            gog: gogGiveaway,
          };
          savePromotionsToCache(cachedStoreData);
          await renderGames();
        }
      }).catch(err => {
        console.warn('GOG giveaway notice:', err);
      });

      // Await both settling
      await Promise.allSettled([epicResolvePromise, gogResolvePromise]);
    } catch (e) {
      if (!hasExistingContent && !cachedStoreData) {
        currentGamesGrid.innerHTML = `<div class="loading-state">Failed to load games: ${e.message}</div>`;
        upcomingGamesGrid.innerHTML = '';
      }
    }
  }

  async function renderGames() {
    if (!cachedStoreData) return;
    const data = cachedStoreData;

    try {
      const history = await window.claimrAPI.getHistory();
      const claimedMap = history.claimed || {};

      const currentGames = [];

      // Helper: Determines if a game is claimed/owned for the active account of the specified store
      function isGameOwned(store, gameId, slug, title) {
        const isEpic = store === 'EPIC';
        const accountId = isEpic ? currentAuth?.epicActiveId : currentAuth?.gogActiveId;
        const candidateKeys = [gameId, slug, title].filter(Boolean);

        if (accountId) {
          // Check for account-prefixed key
          for (const key of candidateKeys) {
            if (claimedMap[`${accountId}:${key}`]) return true;
          }

          // If default account, check legacy un-prefixed records as well
          if (accountId === 'default') {
            for (const key of candidateKeys) {
              if (claimedMap[key]) return true;
            }
            if (!isEpic && data.gog?.isAlreadyClaimed) {
              return true;
            }
          }
          return false;
        }

        // Fallback when no account ID is set
        for (const key of candidateKeys) {
          if (claimedMap[key]) return true;
        }
        return false;
      }

      // Epic Current Games
      (data.epic?.currentFreeGames || []).forEach(g => {
        const isOwned = isGameOwned('EPIC', g.id, g.slug, g.title);
        currentGames.push({
          id: g.id || g.slug,
          title: g.title,
          store: 'EPIC',
          thumbnail: g.thumbnail,
          url: g.storeUrl,
          endDate: g.endDate,
          isOwned,
          activeUser: currentAuth?.epicUsername || 'Epic Account',
        });
      });

      // GOG Giveaway
      if (data.gog?.active) {
        const isOwned = isGameOwned('GOG', `gog_${data.gog.title}`, 'gog', data.gog.title);
        currentGames.push({
          id: `gog_${data.gog.title}`,
          title: data.gog.title,
          store: 'GOG',
          thumbnail: data.gog.thumbnail || 'https://images.gog-statics.com/948360d0e110622fdbdab367732dc1a3004fd51bad991bada0e95a1f9acb8ccf_giveaway_465w.jpg',
          url: data.gog.url || 'https://www.gog.com/en',
          endDate: null,
          isOwned,
          activeUser: currentAuth?.gogUsername || 'GOG Account',
        });
      }

      const unclaimedGames = currentGames.filter(g => !g.isOwned);
      const ownedGames = currentGames.filter(g => g.isOwned);


      // Section Header Meta Text
      if (currentGames.length === 0) {
        currentCountText.textContent = '0 available';
      } else if (unclaimedGames.length === 0) {
        currentCountText.textContent = `All in library (${currentGames.length})`;
      } else if (ownedGames.length === 0) {
        currentCountText.textContent = `${unclaimedGames.length} available to claim`;
      } else {
        currentCountText.textContent = `${unclaimedGames.length} to claim • ${ownedGames.length} in library`;
      }

      // Update Primary Claim Button
      if (unclaimedGames.length === 0) {
        claimAllBtn.disabled = true;
        claimAllBtn.classList.add('all-claimed');
        claimAllBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <span class="btn-text">All Free Games Claimed</span>`;
      } else {
        claimAllBtn.disabled = false;
        claimAllBtn.classList.remove('all-claimed');
        claimAllBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span class="btn-text">Claim ${unclaimedGames.length === 1 ? '1 Free Game' : `${unclaimedGames.length} Free Games`}</span>`;
      }

      // Render Current Games Grid
      if (currentGames.length === 0) {
        currentGamesGrid.innerHTML = '<div class="loading-state">No free giveaways active right now. Check back soon!</div>';
      } else {
        currentGamesGrid.innerHTML = currentGames.map((g, idx) => `
          <div class="game-card clickable" data-index="${idx}" title="Click to run claim automator for ${g.title}">
            <div class="game-thumb-container">
              <span class="store-badge store-tag-badge ${g.store === 'EPIC' ? 'store-epic' : 'store-gog'}">${g.store === 'EPIC' ? 'Epic' : 'GOG'}</span>
              <span class="status-badge ${g.isOwned ? 'badge-in-library' : 'badge-free'}">
                ${g.isOwned ? 'In Library' : 'Free to Claim'}
              </span>
              <div class="game-action-overlay">
                <span class="game-action-pill">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  <span>${g.isOwned ? 'Re-run Automator' : 'Claim with Automator'}</span>
                </span>
              </div>
              <img class="game-thumb" src="${g.thumbnail || 'https://via.placeholder.com/300x150/1e2438/94a3b8?text=' + encodeURIComponent(g.title)}" alt="${g.title}" onerror="this.src='https://via.placeholder.com/300x150/1e2438/94a3b8?text=Free+Game'">
            </div>
            <div class="game-info">
              <div class="game-title">${g.title}</div>
              <div class="game-dates">${g.endDate ? 'Free until ' + new Date(g.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Limited time giveaway'}</div>
              <div class="game-account-status ${g.isOwned ? 'owned' : 'unclaimed'}">
                <span class="account-dot ${g.isOwned ? 'dot-owned' : 'dot-unclaimed'}"></span>
                <span>${g.isOwned ? `In ${g.activeUser}'s library` : `Ready to claim for ${g.activeUser}`}</span>
              </div>
            </div>
          </div>
        `).join('');

        // Clicking on a game card starts the claim automator for that specific game
        currentGamesGrid.querySelectorAll('.game-card.clickable').forEach(card => {
          card.addEventListener('click', async () => {
            const idx = parseInt(card.dataset.index, 10);
            const g = currentGames[idx];
            if (!g) return;

            if (isAutomatorRunning) {
              openTerminal();
              logToTerminal('⚠️ An automator task is already running. Please wait for it to complete.');
              return;
            }

            isAutomatorRunning = true;
            card.classList.add('claiming');
            openTerminal();
            logToTerminal('\n========================================');
            logToTerminal(`🚀 Starting automator for "${g.title}" on ${g.store}...`);

            try {
              const res = await window.claimrAPI.claimGame({
                store: g.store,
                gameId: g.id,
                gameTitle: g.title,
                storeUrl: g.url,
              });
              if (res && res.error) {
                logToTerminal(`⚠️ ${res.error}`);
              }
            } catch (err) {
              logToTerminal(`❌ Claiming failed: ${err.message}`);
            } finally {
              isAutomatorRunning = false;
              card.classList.remove('claiming');
              await renderGames();
            }
          });
        });
      }

      // Render Upcoming Games Grid
      const upcomingGames = data.epic?.upcomingFreeGames || [];
      if (upcomingGames.length === 0) {
        upcomingGamesGrid.innerHTML = '<div class="loading-state">No upcoming giveaways announced yet.</div>';
      } else {
        if (upcomingGames[0]?.startDate) {
          nextDropDate = new Date(upcomingGames[0].startDate);
        }

        upcomingGamesGrid.innerHTML = upcomingGames.map(g => `
          <div class="game-card">
            <div class="game-thumb-container">
              <span class="store-badge store-tag-badge store-epic">Epic</span>
              <span class="status-badge badge-upcoming">Upcoming</span>
              <img class="game-thumb" src="${g.thumbnail || 'https://via.placeholder.com/300x150/1e2438/94a3b8?text=' + encodeURIComponent(g.title)}" alt="${g.title}" onerror="this.src='https://via.placeholder.com/300x150/1e2438/94a3b8?text=Upcoming'">
            </div>
            <div class="game-info">
              <div class="game-title">${g.title}</div>
              <div class="game-dates">Unlocks ${new Date(g.startDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        `).join('');
      }

      startCountdown();
    } catch (e) {
      currentGamesGrid.innerHTML = `<div class="loading-state">Failed to load games: ${e.message}</div>`;
      upcomingGamesGrid.innerHTML = '';
    }
  }

  // -------------------------------------------------------------
  // Countdown Timer
  // -------------------------------------------------------------

  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    // Default to next Thursday at 11:00 AM EST if no explicit date
    if (!nextDropDate) {
      const now = new Date();
      const nextThursday = new Date();
      const dayOffset = (4 - now.getDay() + 7) % 7 || 7;
      nextThursday.setDate(now.getDate() + dayOffset);
      nextThursday.setHours(11, 0, 0, 0);
      nextDropDate = nextThursday;
    }

    function updateTimer() {
      const now = new Date().getTime();
      const distance = nextDropDate.getTime() - now;

      if (distance <= 0) {
        timerDays.textContent = '00';
        timerHours.textContent = '00';
        timerMinutes.textContent = '00';
        timerSeconds.textContent = '00';
        return;
      }

      const days = Math.floor(distance / (1000 * 60 * 60 * 24));
      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);

      timerDays.textContent = String(days).padStart(2, '0');
      timerHours.textContent = String(hours).padStart(2, '0');
      timerMinutes.textContent = String(minutes).padStart(2, '0');
      timerSeconds.textContent = String(seconds).padStart(2, '0');
    }

    updateTimer();
    countdownInterval = setInterval(updateTimer, 1000);
  }

  // -------------------------------------------------------------
  // Claim All Action
  // -------------------------------------------------------------

  claimAllBtn.addEventListener('click', async () => {
    if (isAutomatorRunning) {
      openTerminal();
      logToTerminal('⚠️ An automator task is already running. Please wait for it to complete.');
      return;
    }

    isAutomatorRunning = true;
    claimAllBtn.disabled = true;
    claimAllBtn.classList.remove('all-claimed');
    claimAllBtn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 14 14"></polyline>
      </svg>
      <span class="btn-text">Checking Offers...</span>`;
    openTerminal();
    logToTerminal('\n========================================');
    logToTerminal('Checking store giveaways and processing claims...');

    try {
      await window.claimrAPI.claimAll();
    } catch (err) {
      logToTerminal(`❌ Claiming failed: ${err.message}`);
    } finally {
      isAutomatorRunning = false;
      await renderGames();
    }
  });

  // Listen to live logs from main process
  window.claimrAPI.onClaimLog((line) => {
    logToTerminal(line);
  });

  // Listen to background real-library updates from store
  if (window.claimrAPI.onLibraryUpdated) {
    window.claimrAPI.onLibraryUpdated(() => {
      renderGames();
    });
  }

  // -------------------------------------------------------------
  // Background Service Automation Switch
  // -------------------------------------------------------------

  async function checkServiceStatus() {
    try {
      const res = await window.claimrAPI.getServiceStatus();
      serviceCheckbox.checked = !!res.active;
    } catch (e) {
      console.warn('Could not read service status:', e);
    }
  }

  serviceCheckbox.addEventListener('change', async () => {
    const checked = serviceCheckbox.checked;
    serviceCheckbox.disabled = true;
    logToTerminal(`\n⚙️ [Auto-Claim] Setting background daemon: ${checked ? 'ENABLED' : 'DISABLED'}...`);

    try {
      const res = await window.claimrAPI.toggleService(checked);
      if (res && res.error) {
        logToTerminal(`❌ [Auto-Claim] Error: ${res.error}`);
      }
      serviceCheckbox.checked = !!(res && res.active);
      logToTerminal(`⚙️ [Auto-Claim] Background service is now ${serviceCheckbox.checked ? 'ACTIVE (Hourly, On Wake & At Startup)' : 'DISABLED'}.`);
    } catch (err) {
      logToTerminal(`❌ [Auto-Claim] Failed to change service status: ${err.message}`);
    } finally {
      serviceCheckbox.disabled = false;
    }
  });

  // -------------------------------------------------------------
  // History Modal
  // -------------------------------------------------------------

  historyBtn.addEventListener('click', async () => {
    historyModal.classList.add('open');
    historyList.innerHTML = '<div class="loading-state">Loading history...</div>';

    try {
      const history = await window.claimrAPI.getHistory();
      const claimed = Object.values(history.claimed || {});

      if (claimed.length === 0) {
        historyList.innerHTML = '<div class="loading-state">No games claimed yet.</div>';
      } else {
        historyList.innerHTML = claimed.map(item => `
          <div class="history-item">
            <div>
              <div class="history-title">
                ${item.title}
                ${item.accountName ? `<span style="font-size:0.68rem;color:var(--accent-cyan);margin-left:6px;font-weight:600;">(${item.accountName})</span>` : ''}
              </div>
              <div class="history-time">${new Date(item.claimedAt).toLocaleString()}</div>
            </div>
            <span class="status-badge badge-in-library">${item.status || 'claimed'}</span>
          </div>
        `).join('');
      }
    } catch (e) {
      historyList.innerHTML = `<div class="loading-state">Failed to load history: ${e.message}</div>`;
    }
  });

  closeHistoryModal.addEventListener('click', () => {
    historyModal.classList.remove('open');
  });

  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) historyModal.classList.remove('open');
  });

  // -------------------------------------------------------------
  // UI Controls
  // -------------------------------------------------------------

  terminalToggleBtn.addEventListener('click', () => {
    terminalDrawer.classList.toggle('open');
  });

  closeConsoleBtn.addEventListener('click', closeTerminal);
  clearConsoleBtn.addEventListener('click', () => {
    terminalOutput.innerHTML = '';
  });

  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('spinning')) return;
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    try {
      await refreshAuthStatus({ fast: true });
      await loadGames({ forceFetch: true });
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  });



  // Initial Load
  (async () => {
    // 1. Instant 0ms render from cache if available
    if (cachedStoreData) {
      renderGames();
    }

    // 2. Fast auth status check (reads accounts.json in ~5ms)
    await refreshAuthStatus({ fast: true });

    // 3. Re-render account badges with active account names
    if (cachedStoreData) {
      renderGames();
    }

    // 4. Progressively fetch fresh promotions (Epic in ~120ms, GOG in ~400ms)
    await loadGames({ forceFetch: false });
    checkServiceStatus();

    // 5. Request native system notification permission if not yet determined
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  })();
});
