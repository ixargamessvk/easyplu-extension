// content.js — EasyPLU AutoFill

(async function () {
  const STORAGE_KEY = 'easyplu_map';
  const DEBUG_KEY   = 'easyplu_debug';
  const STOP_KEY    = 'easyplu_stop';

  function normalizeName(name) {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sendMsg(type, extra = {}) {
    try { chrome.runtime.sendMessage({ type, ...extra }); } catch (_) {}
  }

  async function isDebug() {
    const r = await chrome.storage.local.get(DEBUG_KEY);
    return !!r[DEBUG_KEY];
  }

  async function isStopped() {
    const r = await chrome.storage.local.get(STOP_KEY);
    return !!r[STOP_KEY];
  }

  async function dbg(...args) {
    if (await isDebug()) console.log('[EasyPLU DBG]', ...args);
  }

  function pressEnter(el) {
    el.dispatchEvent(new KeyboardEvent('keydown',  { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup',    { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }

  // Wait for old rows to clear, then new rows to appear (or confirm empty)
  async function waitForFreshResults(previousCount) {
    const TIMEOUT = 8000;
    const start = Date.now();

    if (previousCount > 0) {
      while (Date.now() - start < TIMEOUT) {
        if (document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length === 0) break;
        await sleep(80);
      }
    }

    const start2 = Date.now();
    while (Date.now() - start2 < TIMEOUT) {
      const rows = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;
      if (rows > 0) return true;
      const tbody = document.querySelector('tbody.p-datatable-tbody');
      if (tbody && tbody.children.length === 0) {
        await sleep(300);
        if (document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length === 0) return false;
      }
      await sleep(80);
    }
    return false;
  }

  async function waitForMoreRows(previousCount) {
    const TIMEOUT = 5000;
    const start = Date.now();
    while (Date.now() - start < TIMEOUT) {
      if (document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length > previousCount) return true;
      await sleep(100);
    }
    return false;
  }

  async function expandAllResults() {
    while (true) {
      const moreBtn = Array.from(document.querySelectorAll('button')).find(
        btn => btn.textContent.includes('viac') || btn.textContent.includes('Viac')
      );
      if (!moreBtn || moreBtn.disabled || moreBtn.getAttribute('aria-disabled') === 'true') break;
      const rowsBefore = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;
      moreBtn.click();
      const grew = await waitForMoreRows(rowsBefore);
      if (!grew) break;
    }
  }

  // ─── Parse rows — skip dupes, respect 4-digit PLU limit ──────────────────

  async function parseVisibleRows(pluMap) {
    let added = 0, skipped = 0, invalid = 0;
    const rows = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]');
    const debug = await isDebug();

    if (debug) console.log(`[EasyPLU DBG] parseVisibleRows: ${rows.length} rows found`);

    rows.forEach((row, rowIdx) => {
      const cells = row.querySelectorAll('td[role="cell"]');

      if (debug && rowIdx === 0) {
        // Log full breakdown of first row so we can see the real structure
        console.log(`[EasyPLU DBG] First row: ${cells.length} cells`);
        cells.forEach((c, i) => {
          console.log(`[EasyPLU DBG]   cell[${i}] text="${c.textContent.trim().substring(0, 80)}"`);
          console.log(`[EasyPLU DBG]   cell[${i}] html="${c.innerHTML.substring(0, 200)}"`);
        });
      }

      if (cells.length < 4) {
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx}: skipped — only ${cells.length} cells`);
        return;
      }

      // Cell[1] = Názov — text node after the label span
      const nameCell = cells[1];
      let name = '';
      nameCell.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) name += node.textContent;
      });
      name = name.trim();

      if (!name) {
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx}: empty name, cell html="${nameCell.innerHTML.substring(0, 150)}"`);
        return;
      }

      // Cell[3] = Číslo PLU — find the span containing only digits (skip the "Číslo PLU" label span)
      const pluCell = cells[3];
      const pluSpan = Array.from(pluCell.querySelectorAll('span')).find(
        s => /^\d{1,4}$/.test(s.textContent.trim())
      );

      if (!pluSpan) {
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx} "${name}": no pluSpan, cell html="${pluCell.innerHTML.substring(0, 150)}"`);
        return;
      }

      const plu = pluSpan.textContent.trim();

      if (!plu || !/^\d{1,4}$/.test(plu)) {
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx} "${name}": invalid PLU="${plu}"`);
        invalid++;
        return;
      }

      const key = normalizeName(name);
      if (pluMap[key]) {
        skipped++;
      } else {
        pluMap[key] = plu;
        added++;
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx}: stored "${name}" → ${plu}`);
      }
    });

    if (debug) console.log(`[EasyPLU DBG] parse result: +${added} new, ${skipped} dupes, ${invalid} invalid`);
    return { added, skipped, invalid };
  }

  // ─── Save incrementally to storage ───────────────────────────────────────

  async function saveProgress(pluMap) {
    const count = Object.keys(pluMap).length;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: pluMap });
      console.log(`[EasyPLU] 💾 Saved ${count} items to storage`);
    } catch (err) {
      console.error('[EasyPLU] ❌ Storage write FAILED:', err);
      sendMsg('SCRAPE_ERROR', { reason: 'Storage write failed: ' + String(err) });
    }
    return count;
  }

  // ─── Fetch expected total ─────────────────────────────────────────────────

  async function fetchExpectedTotal() {
    try {
      const resp = await fetch('https://easy-plu.knowledge-hero.com/lernmodus-auswahl-warengruppen',
        { credentials: 'include' });
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const allBtn = doc.querySelector('#execute-all-articles');
      if (allBtn) {
        const match = allBtn.textContent.match(/\((\d+)\)/);
        if (match) return { total: parseInt(match[1]), source: 'Všetky artikle button' };
      }

      const bars = doc.querySelectorAll('.bar-name .text-nowrap');
      if (bars.length > 0) {
        let sum = 0;
        bars.forEach(el => { const m = el.textContent.match(/(\d+)/); if (m) sum += parseInt(m[1]); });
        if (sum > 0) return { total: sum, source: 'Sum of categories' };
      }
      return null;
    } catch (err) {
      console.warn('[EasyPLU] Could not fetch expected total:', err);
      return null;
    }
  }

  // ─── PHASE 1 — Scrape ────────────────────────────────────────────────────

  async function scrapeDatabase() {
    // Clear stop flag from any previous run
    await chrome.storage.local.remove(STOP_KEY);

    const existing = await chrome.storage.local.get(STORAGE_KEY);
    if (existing[STORAGE_KEY] && Object.keys(existing[STORAGE_KEY]).length > 0) {
      const count = Object.keys(existing[STORAGE_KEY]).length;
      console.log('[EasyPLU] Using cached PLU map:', count, 'products');
      sendMsg('SCRAPE_DONE', { count });
      return;
    }

    console.log('[EasyPLU] Starting scrape...');
    sendMsg('SCRAPE_STARTED');

    let searchInput = null;
    for (let i = 0; i < 20; i++) {
      searchInput = document.querySelector('input#search');
      if (searchInput) break;
      await sleep(500);
    }

    if (!searchInput) {
      console.error('[EasyPLU] Search input not found. Are you logged in?');
      sendMsg('SCRAPE_ERROR', { reason: 'Search input not found' });
      return;
    }

    const pluMap = {};
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;

    const queries = 'abcdefghijklmnopqrstuvwxyz'.split('');

    for (const query of queries) {
      // Check stop flag
      if (await isStopped()) {
        console.log('[EasyPLU] Scrape stopped by user.');
        const count = await saveProgress(pluMap);
        sendMsg('SCRAPE_STOPPED', { count });
        return;
      }

      try {
        const prevRowCount = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;

        nativeSetter.call(searchInput, query);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        pressEnter(searchInput);

        await dbg(`Searching "${query}"...`);
        const hasResults = await waitForFreshResults(prevRowCount);

        if (hasResults) {
          await expandAllResults();
          const { added, skipped, invalid } = await parseVisibleRows(pluMap);
          const rowCount = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;

          // Save incrementally after every successful query
          const total = await saveProgress(pluMap);

          console.log(`[EasyPLU] "${query}" — ${rowCount} rows | +${added} new, ${skipped} dupes, ${invalid} invalid | total saved: ${total}`);
          sendMsg('SCRAPE_PROGRESS', { count: total, query });
        } else {
          await dbg(`"${query}" — no results`);
        }

      } catch (err) {
        console.error('[EasyPLU] Error on query:', query, err);
        sendMsg('SCRAPE_ERROR', { reason: String(err), query });
        // Save whatever we have so far and continue
        await saveProgress(pluMap);
      }
    }

    const count = Object.keys(pluMap).length;
    console.log(`[EasyPLU] ── Scrape complete: ${count} unique products ──`);

    // Completeness check
    const expected = await fetchExpectedTotal();
    if (expected) {
      const diff = expected.total - count;
      if (diff === 0)       console.log(`[EasyPLU] ✅ COMPLETE: ${count} / ${expected.total} (${expected.source})`);
      else if (diff > 0)    console.warn(`[EasyPLU] ⚠️ INCOMPLETE: ${count} / ${expected.total}, missing ${diff} (${expected.source})`);
      else                  console.log(`[EasyPLU] ℹ️ ${count} scraped, ${expected.total} expected, ${Math.abs(diff)} extra (${expected.source})`);
      sendMsg('SCRAPE_DONE', { count, expected: expected.total });
    } else {
      sendMsg('SCRAPE_DONE', { count });
    }
  }

  // ─── PHASE 2 — Auto-fill PLU during test ─────────────────────────────────

  async function autoFillTest() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const pluMap = stored[STORAGE_KEY];

    if (!pluMap || Object.keys(pluMap).length === 0) {
      console.warn('[EasyPLU] No PLU data. Visit the search page first to scrape.');
      return;
    }

    console.log('[EasyPLU] AutoFill active —', Object.keys(pluMap).length, 'products loaded');

    let lastFilledName = null;
    let filling = false;

    function findPLU(productName) {
      // 1. Exact match
      if (pluMap[productName]) return pluMap[productName];
      // 2. Stored name is substring of displayed name (e.g. "Banány" in "Banány BIO")
      for (const [stored, plu] of Object.entries(pluMap)) {
        if (productName === stored) return plu;
      }
      // 3. Partial match
      for (const [stored, plu] of Object.entries(pluMap)) {
        if (productName.includes(stored) || stored.includes(productName)) return plu;
      }
      return null;
    }

    async function tryFill() {
      if (filling) return;

      // Product name selector
      const nameEl = document.querySelector('.stage-title h1[data-test="clamped-text"]')
                  || document.querySelector('h1[data-test="clamped-text"]');
      if (!nameEl) {
        console.log('[EasyPLU] nameEl not found');
        return;
      }

      const productName = normalizeName(nameEl.textContent);
      if (!productName) return;

      // Find the PLU input
      const pluInput = document.querySelector('input[name="plu-number"]')
                    || document.querySelector('input[data-testid="plu-number-input"]');
      if (!pluInput) {
        console.log('[EasyPLU] pluInput not found');
        return;
      }

      // Skip if already filled for this product
      if (productName === lastFilledName && pluInput.value.trim() !== '') return;

      const foundPLU = findPLU(productName);
      if (!foundPLU) {
        console.log('[EasyPLU] No match for:', productName);
        lastFilledName = productName;
        return;
      }

      console.log('[EasyPLU] Filling PLU:', foundPLU, '→', productName);
      lastFilledName = productName;
      filling = true;

      // inputmode="none" blocks all keyboard events on the input.
      // The page uses a custom on-screen numpad — click the digit divs directly.
      // Digit buttons: #numpad-0 … #numpad-9
      // Confirm button: [data-testid="numpad_plu"]
      // Clear button:   #numpad-reset

      // Clear any existing value first
      const resetBtn = document.querySelector('#numpad-reset');
      if (resetBtn) { resetBtn.click(); await sleep(80); }

      // Click each digit
      for (const digit of foundPLU.split('')) {
        const btn = document.querySelector(`#numpad-${digit}`);
        if (btn) {
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
          btn.click();
        } else {
          console.warn('[EasyPLU] Numpad button not found for digit:', digit);
        }
        await sleep(120);
      }

      await sleep(150);

      // Click the green PLU confirm button
      const pluBtn = document.querySelector('[data-testid="numpad_plu"]');
      if (pluBtn) {
        pluBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        pluBtn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
        pluBtn.click();
        console.log('[EasyPLU] Submitted PLU:', foundPLU);
      } else {
        console.warn('[EasyPLU] PLU confirm button not found');
      }

      await sleep(600);
      filling = false;
    }

    // Watch for product name changes between questions
    const observer = new MutationObserver(() => {
      if (!filling) tryFill();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Try immediately — cursor is already in the input on page load
    await sleep(500);
    await tryFill();
  }

  // ─── Router ───────────────────────────────────────────────────────────────

  await sleep(1500);

  const url = window.location.href;
  const isTestPage = url.includes('testmodus-plu-view') ||
                     url.includes('testmodus') ||
                     !!document.querySelector('[data-testid="numpad_plu"]') ||
                     !!document.querySelector('input[name="plu-number"]');

  console.log('[EasyPLU] Page:', url);
  console.log('[EasyPLU] Mode:', isTestPage ? 'TEST/AUTOFILL' : 'SCRAPE');

  if (isTestPage) {
    await autoFillTest();
  } else {
    await scrapeDatabase();
  }

})();
