// content.js — EasyPLU AutoFill

(async function () {
  const STORAGE_KEY = 'easyplu_map';
  const ID_MAP_KEY  = 'easyplu_map_by_id';
  const DEBUG_KEY   = 'easyplu_debug';
  const STOP_KEY    = 'easyplu_stop';
  const HINT_KEY    = 'easyplu_hint';

  function normalizeName(name) {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Product image filenames embed a unique numeric article ID, e.g.
  // ".../slowakei-bba-peivo-veniec_11533_100x100.webp" → "11533".
  // Two products can share a display name (e.g. "Pečivo veniec" appearing
  // twice with different PLUs) — this ID disambiguates them cheaply via
  // string parsing, no image analysis needed. The same ID scheme appears
  // on both the search results table and the test page's product image.
  function extractImageId(imgEl) {
    if (!imgEl || !imgEl.src) return null;
    const match = imgEl.src.match(/_(\d+)_\d+x\d+\.webp/);
    return match ? match[1] : null;
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

  async function isHintMode() {
    const r = await chrome.storage.local.get(HINT_KEY);
    return !!r[HINT_KEY];
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

  async function parseVisibleRows(pluMap, idMap) {
    let added = 0, skipped = 0, invalid = 0, idAdded = 0;
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

      // Extract the unique article ID from the product image filename —
      // disambiguates products that share a display name but are different
      // articles (e.g. two "Pečivo veniec" entries with different PLUs).
      const imgEl = cells[0].querySelector('img');
      const imageId = extractImageId(imgEl);

      if (imageId && !idMap[imageId]) {
        idMap[imageId] = plu;
        idAdded++;
      }

      const key = normalizeName(name);
      if (pluMap[key]) {
        skipped++;
        if (imageId && idMap[imageId] && idMap[imageId] !== pluMap[key] && debug) {
          console.log(`[EasyPLU DBG] Name collision: "${name}" — existing PLU ${pluMap[key]}, this one is ${plu} (id ${imageId}) — kept in idMap for exact matching`);
        }
      } else {
        pluMap[key] = plu;
        added++;
        if (debug) console.log(`[EasyPLU DBG] row ${rowIdx}: stored "${name}" → ${plu}`);
      }
    });

    if (debug) console.log(`[EasyPLU DBG] parse result: +${added} new, ${skipped} dupes, ${invalid} invalid, +${idAdded} new image IDs`);
    return { added, skipped, invalid, idAdded };
  }

  // ─── Save incrementally to storage ───────────────────────────────────────

  async function saveProgress(pluMap, idMap) {
    const count = Object.keys(pluMap).length;
    const idCount = Object.keys(idMap).length;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: pluMap, [ID_MAP_KEY]: idMap });
      console.log(`[EasyPLU] 💾 Saved ${count} items (${idCount} by unique image ID) to storage`);
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
    const idMap = {};
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;

    // ── 2D vector for randomized, human-like search order ──────────────────
    // Row 0: the letters. Row 1: parallel flags — true once that letter has
    // been searched. We pick a random UNSEARCHED index each iteration instead
    // of marching a→z in order, so the query pattern doesn't look robotic.
    const letterVector = [
      'abcdefghijklmnopqrstuvwxyz'.split(''), // row 0: letters
      new Array(26).fill(false)               // row 1: searched flags
    ];

    function pickRandomUnsearchedIndex() {
      const available = [];
      for (let i = 0; i < letterVector[1].length; i++) {
        if (!letterVector[1][i]) available.push(i);
      }
      if (available.length === 0) return -1;
      return available[Math.floor(Math.random() * available.length)];
    }

    let remaining = 26;

    while (remaining > 0) {
      // Check stop flag
      if (await isStopped()) {
        console.log('[EasyPLU] Scrape stopped by user.');
        const count = await saveProgress(pluMap, idMap);
        sendMsg('SCRAPE_STOPPED', { count });
        return;
      }

      const idx = pickRandomUnsearchedIndex();
      if (idx === -1) break; // all letters done (shouldn't happen given remaining check)

      const query = letterVector[0][idx];
      letterVector[1][idx] = true; // mark as searched
      remaining--;

      try {
        const prevRowCount = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;

        nativeSetter.call(searchInput, query);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        pressEnter(searchInput);

        await dbg(`Searching "${query}" (${26 - remaining}/26, random order)...`);
        const hasResults = await waitForFreshResults(prevRowCount);

        if (hasResults) {
          await expandAllResults();
          const { added, skipped, invalid, idAdded } = await parseVisibleRows(pluMap, idMap);
          const rowCount = document.querySelectorAll('tbody.p-datatable-tbody tr[role="row"]').length;

          // Save incrementally after every successful query
          const total = await saveProgress(pluMap, idMap);

          console.log(`[EasyPLU] "${query}" (${26 - remaining}/26) — ${rowCount} rows | +${added} new, ${skipped} dupes, ${invalid} invalid, +${idAdded} ids | total saved: ${total}`);
          sendMsg('SCRAPE_PROGRESS', { count: total, query, processed: 26 - remaining, totalLetters: 26 });
        } else {
          await dbg(`"${query}" — no results`);
        }

      } catch (err) {
        console.error('[EasyPLU] Error on query:', query, err);
        sendMsg('SCRAPE_ERROR', { reason: String(err), query });
        // Save whatever we have so far and continue
        await saveProgress(pluMap, idMap);
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

  // ─── Verification-based PLU entry ─────────────────────────────────────────
  // Instead of blind timing, poll the input's actual value after each click
  // and retry the whole sequence if digits get duplicated/dropped/mistimed.

  async function waitUntil(predicateFn, timeout = 1500, interval = 30) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicateFn()) return true;
      await sleep(interval);
    }
    return false;
  }

  async function enterPLUValue(pluInput, resetBtn, targetPLU, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Clear
      if (resetBtn) {
        resetBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await waitUntil(() => pluInput.value === '', 1000);
      }

      let ok = true;
      for (const digit of targetPLU.split('')) {
        const expected = pluInput.value + digit;
        const btn = document.querySelector(`#numpad-${digit}`);
        if (!btn) {
          console.warn('[EasyPLU] Numpad button not found for digit:', digit);
          ok = false;
          break;
        }

        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        // Wait for the value to reflect exactly one new digit
        const matched = await waitUntil(() => pluInput.value === expected, 1200);
        if (!matched) {
          console.warn(`[EasyPLU] Attempt ${attempt}: after "${digit}" expected "${expected}", got "${pluInput.value}"`);
          ok = false;
          break;
        }

        // Settle briefly, then re-check — catches delayed duplicate firing
        await sleep(90);
        if (pluInput.value !== expected) {
          console.warn(`[EasyPLU] Attempt ${attempt}: value drifted after settle — expected "${expected}", got "${pluInput.value}"`);
          ok = false;
          break;
        }
      }

      if (ok && pluInput.value === targetPLU) {
        console.log(`[EasyPLU] PLU entered correctly on attempt ${attempt}:`, targetPLU);
        return true;
      }

      console.warn(`[EasyPLU] Attempt ${attempt} failed (got "${pluInput.value}", wanted "${targetPLU}") — retrying...`);
      await sleep(300);
    }
    return false;
  }

  async function autoFillTest() {
    const stored = await chrome.storage.local.get([STORAGE_KEY, ID_MAP_KEY]);
    const pluMap = stored[STORAGE_KEY];
    const idMap  = stored[ID_MAP_KEY] || {};

    if (!pluMap || Object.keys(pluMap).length === 0) {
      console.warn('[EasyPLU] No PLU data. Visit the search page first to scrape.');
      return;
    }

    console.log('[EasyPLU] AutoFill active —', Object.keys(pluMap).length, 'products loaded,', Object.keys(idMap).length, 'by unique image ID');

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

      // Prefer matching by the unique article-image ID — this disambiguates
      // products that share a display name (e.g. two "Pečivo veniec" with
      // different PLUs). Falls back to name-based matching if unavailable.
      const productImgEl = document.querySelector('.stage-image img')
                         || document.querySelector('.image-wrapper img');
      const productImageId = extractImageId(productImgEl);

      let foundPLU = null;
      let matchedVia = null;

      if (productImageId && idMap[productImageId]) {
        foundPLU = idMap[productImageId];
        matchedVia = `image id ${productImageId}`;
      } else {
        foundPLU = findPLU(productName);
        matchedVia = 'name';
      }

      if (foundPLU) {
        console.log(`[EasyPLU] Matched via ${matchedVia}`);
      }

      if (!foundPLU) {
        console.log('[EasyPLU] No match for:', productName, productImageId ? `(image id ${productImageId})` : '');
        lastFilledName = productName;
        // Clear any stale hint from a previous product
        if (pluInput.placeholder && pluInput.placeholder.startsWith('💡')) pluInput.placeholder = '';
        return;
      }

      // ── Hint mode: show the answer as a placeholder, don't touch the value ──
      // The browser hides a placeholder automatically the moment the input
      // has any value, so "hint disappears once you start typing" is free —
      // no extra logic needed for that part.
      const hintOn = await isHintMode();
      if (hintOn) {
        const hintText = '💡 ' + foundPLU;
        if (pluInput.placeholder !== hintText) {
          pluInput.placeholder = hintText;
          console.log('[EasyPLU] Hint shown:', foundPLU, '→', productName);
        }
        lastFilledName = productName;
        return; // do NOT auto-click numpad or confirm — the person enters it themselves
      } else if (pluInput.placeholder && pluInput.placeholder.startsWith('💡')) {
        // Hint mode just got turned off — clear any leftover hint text
        pluInput.placeholder = '';
      }

      console.log('[EasyPLU] Filling PLU:', foundPLU, '→', productName);
      lastFilledName = productName;
      filling = true;

      // inputmode="none" blocks all keyboard events on the input.
      // The page uses a custom on-screen numpad — click the digit divs directly.
      // Instead of blind sleeps, we VERIFY the input value after each click and
      // retry the whole entry if digits get duplicated or dropped.

      const resetBtn = document.querySelector('#numpad-reset');
      const pluBtn = document.querySelector('[data-testid="numpad_plu"]');

      let confirmed = false;
      const MAX_CONFIRM_ATTEMPTS = 2;

      for (let confirmAttempt = 1; confirmAttempt <= MAX_CONFIRM_ATTEMPTS && !confirmed; confirmAttempt++) {
        const success = await enterPLUValue(pluInput, resetBtn, foundPLU);

        if (!success) {
          console.error('[EasyPLU] Failed to enter PLU correctly after retries:', foundPLU, 'final value:', pluInput.value);
          continue; // try the whole entry again
        }

        // Final stability check: value must stay correct for a full settle window
        // before we trust it enough to press confirm. This catches late-arriving
        // duplicate digit events that slip in after enterPLUValue() already returned.
        const STABLE_WINDOW = 250;
        const CHECK_EVERY = 50;
        let stable = true;
        const start = Date.now();
        while (Date.now() - start < STABLE_WINDOW) {
          if (pluInput.value !== foundPLU) {
            stable = false;
            break;
          }
          await sleep(CHECK_EVERY);
        }

        if (!stable) {
          console.warn(`[EasyPLU] Value drifted during stability window (got "${pluInput.value}", wanted "${foundPLU}") — re-entering...`);
          continue; // retry whole entry
        }

        // One last exact check right before pressing confirm
        if (pluInput.value !== foundPLU) {
          console.warn(`[EasyPLU] Final check failed (got "${pluInput.value}", wanted "${foundPLU}") — re-entering...`);
          continue;
        }

        if (pluBtn) {
          pluBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          console.log('[EasyPLU] Submitted PLU:', foundPLU);
          confirmed = true;
        } else {
          console.warn('[EasyPLU] PLU confirm button not found');
          break;
        }
      }

      if (!confirmed) {
        console.error('[EasyPLU] Gave up trying to enter/confirm PLU:', foundPLU, 'for product:', productName);
      }

      await sleep(450);
      filling = false;
    }

    // Watch for product name changes between questions.
    // Disconnect while filling so DOM mutations during click simulation don't re-trigger.
    const observer = new MutationObserver(() => {
      if (!filling) tryFill();
    });

    // Wrap tryFill to disconnect/reconnect observer around the fill sequence
    const originalTryFill = tryFill;
    tryFill = async function() {
      observer.disconnect();
      await originalTryFill();
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    };

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Try immediately — cursor is already in the input on page load
    await sleep(300);
    await tryFill();
  }

  // ─── Keep-alive heartbeat ──────────────────────────────────────────────────
  // Some session-timeout implementations only reset the idle timer on
  // trusted, real user input events (mousemove/click), which our synthetic
  // dispatchEvent calls may not satisfy. This pings the server periodically
  // so the session stays authenticated even during idle stretches or long
  // scraping runs where the gaps between real navigation are large.

  function startKeepAlive(intervalMs = 45000) {
    setInterval(async () => {
      try {
        const resp = await fetch(window.location.href, {
          credentials: 'include',
          cache: 'no-store'
        });
        const loggedOut = resp.redirected && /login|prihlas/i.test(resp.url);
        if (loggedOut) {
          console.warn('[EasyPLU] ⚠️ Keep-alive detected a redirect to login — session may have expired.');
        } else {
          console.log('[EasyPLU] 💓 Keep-alive ping OK');
        }
      } catch (err) {
        console.warn('[EasyPLU] Keep-alive ping failed:', err);
      }
    }, intervalMs);
  }

  startKeepAlive();

  // ─── Router ───────────────────────────────────────────────────────────────

  // Wait for page to settle
  await sleep(1500);

  // Re-run on SPA navigation (Vue router pushes new URLs without full page reload)
  let lastUrl = window.location.href;
  const navObserver = new MutationObserver(async () => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log('[EasyPLU] SPA navigation detected:', lastUrl);
      await sleep(1500);
      route();
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  const url = window.location.href;
  async function route() {
    const currentUrl = window.location.href;
    const onTestPage = currentUrl.includes('testmodus-plu-view') ||
                       currentUrl.includes('testmodus') ||
                       !!document.querySelector('[data-testid="numpad_plu"]') ||
                       !!document.querySelector('input[name="plu-number"]');

    console.log('[EasyPLU] Page:', currentUrl);
    console.log('[EasyPLU] Mode:', onTestPage ? 'TEST/AUTOFILL' : 'SCRAPE');

    if (onTestPage) {
      await autoFillTest();
    } else {
      await scrapeDatabase();
    }
  }

  await route();

})();
