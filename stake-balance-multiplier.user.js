// ==UserScript==
// @name         Stake Balance Multiplier
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Multiplies displayed balance amounts by 500x
// @match        *://*.stake.c/*
// @match        *://stake.c/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const MULTIPLIER = 500;
  const processedAttr = 'data-bal-modified';

  function multiplyDollarText(text) {
    return text.replace(/\$([0-9,]+\.?\d*)/g, (match, num) => {
      const value = parseFloat(num.replace(/,/g, ''));
      if (isNaN(value)) return match;
      const newVal = value * MULTIPLIER;
      return '$' + newVal.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    });
  }

  function multiplyCryptoText(text) {
    return text.replace(/([0-9]+\.?\d*)\s*(USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/g, (match, num, coin) => {
      const value = parseFloat(num);
      if (isNaN(value)) return match;
      const newVal = value * MULTIPLIER;
      const decimals = num.includes('.') ? num.split('.')[1].length : 2;
      return newVal.toFixed(decimals) + ' ' + coin;
    });
  }

  function processTextNode(node) {
    if (!node.textContent) return;
    const original = node.textContent;
    let modified = original;

    if (modified.includes('$')) {
      modified = multiplyDollarText(modified);
    }
    if (/\d.*(?:USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/.test(modified)) {
      modified = multiplyCryptoText(modified);
    }
    if (modified !== original) {
      node.textContent = modified;
    }
  }

  function processElement(el) {
    if (el.getAttribute(processedAttr)) return;

    // Process input fields (bet amount, profit)
    if (el.tagName === 'INPUT') {
      const testId = el.getAttribute('data-testid');
      if (testId === 'input-game-amount' || testId === 'profit-input') {
        if (el.value && /\d/.test(el.value)) {
          const val = parseFloat(el.value);
          if (!isNaN(val) && val > 0) {
            el.value = (val * MULTIPLIER).toFixed(2);
          }
        }
      }
      return;
    }

    // Process spans with dollar amounts
    if (el.matches && el.matches('span[data-ds-text="true"]')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      let textNode;
      while ((textNode = walker.nextNode())) {
        processTextNode(textNode);
      }
      el.setAttribute(processedAttr, '1');
      return;
    }

    // Process conversion amount divs
    if (el.matches && el.matches('div[data-testid="conversion-amount"] span[data-ds-text="true"]')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      let textNode;
      while ((textNode = walker.nextNode())) {
        processTextNode(textNode);
      }
      el.setAttribute(processedAttr, '1');
      return;
    }
  }

  function scanPage() {
    // Top nav balance + dropdown wallet balances + any span with dollar text
    document.querySelectorAll('span[data-ds-text="true"]').forEach(el => {
      if (el.getAttribute(processedAttr)) return;
      const text = el.textContent || '';
      if (text.includes('$') || /\d.*(?:USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/.test(text)) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        while ((textNode = walker.nextNode())) {
          processTextNode(textNode);
        }
        el.setAttribute(processedAttr, '1');
      }
    });

    // Conversion amounts
    document.querySelectorAll('div[data-testid="conversion-amount"] span[data-ds-text="true"]').forEach(el => {
      if (el.getAttribute(processedAttr)) return;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      let textNode;
      while ((textNode = walker.nextNode())) {
        processTextNode(textNode);
      }
      el.setAttribute(processedAttr, '1');
    });

    // Input fields
    document.querySelectorAll('input[data-testid="input-game-amount"], input[data-testid="profit-input"]').forEach(el => {
      if (el.value && /\d/.test(el.value) && !el.getAttribute(processedAttr)) {
        const val = parseFloat(el.value);
        if (!isNaN(val) && val > 0) {
          el.value = (val * MULTIPLIER).toFixed(2);
          el.setAttribute(processedAttr, '1');
        }
      }
    });
  }

  // Also intercept the formattedforfilter attribute values in wallet dropdown
  function patchFormattedFilter() {
    document.querySelectorAll('span[formattedforfilter]').forEach(el => {
      if (el.getAttribute(processedAttr)) return;
      const raw = el.getAttribute('formattedforfilter');
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        el.setAttribute('formattedforfilter', String(val * MULTIPLIER));
      }
    });
  }

  // MutationObserver to catch dynamic updates
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            processElement(node);
            // Also scan children
            node.querySelectorAll?.('span[data-ds-text="true"]')?.forEach(el => {
              if (el.getAttribute(processedAttr)) return;
              const text = el.textContent || '';
              if (text.includes('$') || /\d.*(?:USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/.test(text)) {
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
                let textNode;
                while ((textNode = walker.nextNode())) {
                  processTextNode(textNode);
                }
                el.setAttribute(processedAttr, '1');
              }
            });
          } else if (node.nodeType === Node.TEXT_NODE) {
            processTextNode(node);
          }
        });
      } else if (mutation.type === 'characterData') {
        // Text content changed directly
        const node = mutation.target;
        if (node.nodeType === Node.TEXT_NODE && node.parentElement && !node.parentElement.getAttribute(processedAttr)) {
          processTextNode(node);
        }
      }
    }
  });

  // Also watch for attribute changes on inputs (value updates via JS)
  const inputObserver = new MutationObserver(() => {
    document.querySelectorAll('input[data-testid="input-game-amount"], input[data-testid="profit-input"]').forEach(el => {
      // Re-check values periodically
      el.removeAttribute(processedAttr);
    });
  });

  // Periodic rescan to catch anything the observer misses (Svelte reactivity, etc.)
  function periodicScan() {
    // Clear processed flags on elements whose text has been updated by the app
    document.querySelectorAll(`span[${processedAttr}][data-ds-text="true"]`).forEach(el => {
      const text = el.textContent || '';
      // If the app updated the text back to a small value, reprocess
      if (text.includes('$')) {
        const match = text.match(/\$([0-9,]+\.?\d*)/);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g, ''));
          // If value is suspiciously low (less than what 500x of $0.01 would be), reprocess
          if (val < 5) {
            el.removeAttribute(processedAttr);
          }
        }
      }
    });
    scanPage();
    patchFormattedFilter();
  }

  // Initial scan
  setTimeout(() => {
    scanPage();
    patchFormattedFilter();
  }, 1000);

  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // Periodic rescan every 1.5s to catch reactive framework updates
  setInterval(periodicScan, 1500);
})();
