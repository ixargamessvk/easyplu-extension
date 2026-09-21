// popup.js

const STORAGE_KEY = 'easyplu_map';
const DEBUG_KEY   = 'easyplu_debug';
const STOP_KEY    = 'easyplu_stop';
const HINT_KEY    = 'easyplu_hint';

const statusBadge    = document.getElementById('statusBadge');
const countDisplay   = document.getElementById('countDisplay');
const expectedRow    = document.getElementById('expectedRow');
const progressWrap   = document.getElementById('progressWrap');
const progressFill   = document.getElementById('progressFill');
const queryIndicator = document.getElementById('queryIndicator');
const autofillDot    = document.getElementById('autofillDot');
const autofillText   = document.getElementById('autofillText');
const rescrapeBtn    = document.getElementById('rescrapeBtn');
const stopBtn        = document.getElementById('stopBtn');
const clearBtn       = document.getElementById('clearBtn');
const debugToggle    = document.getElementById('debugToggle');
const debugPanel     = document.getElementById('debugPanel');
const hintToggle     = document.getElementById('hintToggle');

// ── Debug log panel ──────────────────────────────────────────────────────────

const MAX_DEBUG_LINES = 50;

function addDebugLine(text, type = '') {
  const line = document.createElement('div');
  line.className = 'debug-line' + (type ? ' ' + type : '');
  line.textContent = text;
  debugPanel.appendChild(line);
  // Trim old lines
  while (debugPanel.children.length > MAX_DEBUG_LINES) {
    debugPanel.removeChild(debugPanel.firstChild);
  }
  debugPanel.scrollTop = debugPanel.scrollHeight;
}

// ── State tracking ───────────────────────────────────────────────────────────

let isScraping = false;
let expectedTotal = null;

function setScrapingState(scraping) {
  isScraping = scraping;
  stopBtn.disabled = !scraping;
  rescrapeBtn.disabled = scraping;
}

// ── Refresh UI from storage ──────────────────────────────────────────────────

async function refreshUI() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const pluMap = stored[STORAGE_KEY] || {};
  const count  = Object.keys(pluMap).length;

  countDisplay.textContent = count.toLocaleString();

  if (count === 0) {
    statusBadge.textContent  = 'Empty';
    statusBadge.className    = 'status-badge badge-empty';
    expectedRow.className    = 'expected-row';
  } else if (!isScraping) {
    statusBadge.textContent  = 'Ready';
    statusBadge.className    = 'status-badge badge-ready';
    updateExpectedRow(count);
  }

  // Check active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = tab.url.toLowerCase();
      const isTest  = url.includes('testmodus-plu-view') || url.includes('testmodus');
      const isSite  = url.includes('easy-plu.knowledge-hero.com');

      if (isSite && isTest && count > 0) {
        autofillDot.className = 'dot dot-green';
        autofillText.textContent = 'AutoFill is ACTIVE on this page';
      } else if (isSite && isTest && count === 0) {
        autofillDot.className = 'dot dot-gray';
        autofillText.textContent = 'AutoFill ready but database is empty';
      } else if (isSite) {
        autofillDot.className = isScraping ? 'dot dot-amber' : 'dot dot-gray';
        autofillText.textContent = isScraping ? 'Scraping database…' : 'On EasyPLU — scraping if needed';
      } else {
        autofillDot.className = 'dot dot-gray';
        autofillText.textContent = 'Not on EasyPLU site';
      }
    }
  } catch (_) {}
}

function updateExpectedRow(count) {
  if (!expectedTotal) { expectedRow.className = 'expected-row'; return; }
  const diff = expectedTotal - count;
  if (diff === 0) {
    expectedRow.textContent  = `✅ ${count} / ${expectedTotal} — complete`;
    expectedRow.className    = 'expected-row visible expected-ok';
  } else if (diff > 0) {
    expectedRow.textContent  = `⚠️ ${count} / ${expectedTotal} — missing ${diff}`;
    expectedRow.className    = 'expected-row visible expected-warn';
  } else {
    expectedRow.textContent  = `ℹ️ ${count} scraped (expected ${expectedTotal})`;
    expectedRow.className    = 'expected-row visible';
  }
}

// ── Message handler from content script ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  const count = msg.count || 0;

  if (msg.type === 'SCRAPE_STARTED') {
    setScrapingState(true);
    statusBadge.textContent = 'Scraping…';
    statusBadge.className   = 'status-badge badge-loading';
    progressWrap.className  = 'progress-wrap visible';
    progressFill.style.width = '0%';
    addDebugLine('▶ Scrape started', 'ok');
  }

  if (msg.type === 'SCRAPE_PROGRESS') {
    countDisplay.textContent = count.toLocaleString();
    statusBadge.textContent  = 'Scraping…';
    statusBadge.className    = 'status-badge badge-loading';
    // Progress bar: search order is randomized, so use explicit processed/total counts
    if (msg.query && msg.totalLetters) {
      const pct = Math.round((msg.processed / msg.totalLetters) * 100);
      progressFill.style.width  = pct + '%';
      queryIndicator.textContent = `Searching "${msg.query}" — ${msg.processed}/${msg.totalLetters} letters (${pct}%)`;
      queryIndicator.className   = 'query-indicator visible';
    }
    addDebugLine(`"${msg.query}" → ${count} stored (💾 saved)`);
  }

  if (msg.type === 'SCRAPE_DONE') {
    setScrapingState(false);
    progressWrap.className   = 'progress-wrap';
    queryIndicator.className = 'query-indicator';
    if (msg.expected) expectedTotal = msg.expected;
    addDebugLine(`✅ Done — ${count} products`, 'ok');
    refreshUI();
  }

  if (msg.type === 'SCRAPE_STOPPED') {
    setScrapingState(false);
    statusBadge.textContent  = 'Stopped';
    statusBadge.className    = 'status-badge badge-stopped';
    progressWrap.className   = 'progress-wrap';
    queryIndicator.className = 'query-indicator';
    countDisplay.textContent = count.toLocaleString();
    addDebugLine(`⏹ Stopped — ${count} saved`, 'warn');
  }

  if (msg.type === 'SCRAPE_ERROR') {
    // Don't stop scraping on per-query errors — content.js continues
    const detail = msg.reason ? ` (${msg.reason})` : '';
    const queryInfo = msg.query ? ` on "${msg.query}"` : '';
    addDebugLine(`⚠️ Error${queryInfo}${detail}`, 'err');
    // If it's a fatal error (no query = startup failure), update badge
    if (!msg.query) {
      setScrapingState(false);
      statusBadge.textContent = 'Error';
      statusBadge.className   = 'status-badge badge-error';
    }
  }
});

// ── Buttons ──────────────────────────────────────────────────────────────────

rescrapeBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove([STORAGE_KEY, STOP_KEY]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    addDebugLine('🔄 Re-scraping — reloading tab…');
    chrome.tabs.reload(tab.id);
    window.close();
  }
});

stopBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ [STOP_KEY]: true });
  stopBtn.disabled = true;
  statusBadge.textContent = 'Stopping…';
  addDebugLine('⏹ Stop requested…', 'warn');
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove([STORAGE_KEY, STOP_KEY]);
  expectedTotal = null;
  expectedRow.className = 'expected-row';
  addDebugLine('🗑️ Data cleared');
  await refreshUI();
});

// ── Hint mode toggle ─────────────────────────────────────────────────────────

hintToggle.addEventListener('change', async () => {
  const on = hintToggle.checked;
  await chrome.storage.local.set({ [HINT_KEY]: on });
  addDebugLine(on ? '💡 Hint mode ON — showing answers, not filling them' : '💡 Hint mode OFF — autofill active');
});

// ── Debug toggle ─────────────────────────────────────────────────────────────

debugToggle.addEventListener('change', async () => {
  const on = debugToggle.checked;
  await chrome.storage.local.set({ [DEBUG_KEY]: on });
  debugPanel.className = on ? 'debug-panel visible' : 'debug-panel';
  if (on) addDebugLine('Debug mode ON');
});

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Restore debug toggle state
  const dbgStored = await chrome.storage.local.get(DEBUG_KEY);
  const dbgOn = !!dbgStored[DEBUG_KEY];
  debugToggle.checked  = dbgOn;
  debugPanel.className = dbgOn ? 'debug-panel visible' : 'debug-panel';

  // Restore hint mode toggle state
  const hintStored = await chrome.storage.local.get(HINT_KEY);
  hintToggle.checked = !!hintStored[HINT_KEY];

  // If the stop flag is absent and badge shows scraping, we're mid-scrape
  // Ask the active tab's content script for current state
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('easy-plu.knowledge-hero.com')) {
      const stopStored = await chrome.storage.local.get('easyplu_stop');
      // Check badge text — if it's '...' or a number with amber color we're scraping
      const badge = await chrome.action.getBadgeText({ tabId: tab.id });
      const badgeBg = await chrome.action.getBadgeBackgroundColor({ tabId: tab.id });
      // amber = [245, 158, 11, 255]
      const isAmber = badgeBg && badgeBg[0] > 200 && badgeBg[1] > 100 && badgeBg[2] < 50;
      if (isAmber || badge === '...') {
        setScrapingState(true);
        statusBadge.textContent = 'Scraping…';
        statusBadge.className   = 'status-badge badge-loading';
      }
    }
  } catch (_) {}

  await refreshUI();
}

init();
