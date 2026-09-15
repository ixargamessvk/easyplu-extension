// background.js — service worker

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCRAPE_STARTED') {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  }

  if (msg.type === 'SCRAPE_PROGRESS') {
    const count = msg.count || 0;
    const label = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  }

  if (msg.type === 'SCRAPE_DONE') {
    const count = msg.count || 0;
    const label = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green = done
  }

  if (msg.type === 'SCRAPE_STOPPED') {
    const count = msg.count || 0;
    const label = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: '#78716c' }); // gray = stopped
  }

  if (msg.type === 'SCRAPE_ERROR') {
    // Only set error badge on fatal errors (no query = startup failure)
    if (!msg.query) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
  }
});
