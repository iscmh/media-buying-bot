// ==UserScript==
// @name         Stake USD Display + Balance Multiplier
// @namespace    https://oclus.io
// @version      3.0.0
// @description  Cosmetic USD overlay for content creation + 500x balance multiplier
// @match        *://stake.c/*
// @match        *://*.stake.c/*
// @match        *://stake.com/*
// @match        *://*.stake.com/*
// @match        *://stake.us/*
// @match        *://*.stake.us/*
// @match        *://stake.mba/*
// @match        *://*.stake.mba/*
// @match        *://stake.bet/*
// @match        *://*.stake.bet/*
// @match        *://stake.games/*
// @match        *://*.stake.games/*
// @match        *://stake.ac/*
// @match        *://*.stake.ac/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const MULTIPLIER = 500;

  // ── INSTANT CSS HIDE — prevents any flash of Vietnamese content ──
  const hideCSS = document.createElement("style");
  hideCSS.textContent = `
    svg[data-ds-icon="Vietnam"] { opacity: 0 !important; transition: none !important; }
  `;
  document.head.appendChild(hideCSS);

  const US_FLAG_SVG = `<svg data-ds-icon="UnitedStatesOfAmerica" width="20" height="20" viewBox="0 0 24 19" xmlns="http://www.w3.org/2000/svg" fill="none"><metadata data-ds-license="true">Derived from flag-icons by Panayiotis Lipiridis (MIT). See https://github.com/lipis/flag-icons</metadata><rect width="24" height="18.333" fill="#F7FAFC" rx=".2"/><path fill="#B31942" d="M1 1h22v16.5H1"/><path fill="#000" d="M1 2.904h22zm22 2.538H1zM1 7.981h22zm22 2.538H1zM1 13.058h22zm22 2.538H1z"/><path fill="#fff" d="M23 14.962v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27z"/><path fill="#0A3161" d="M1 1h12.54v8.885H1"/><path fill="#fff" d="m2.045 1.38.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM3.09 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM5.18 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM7.27 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM9.36 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM11.45 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568z"/></svg>`;

  // ── 1. SWAP VIETNAM FLAG SVGs → US FLAG ──
  function swapFlags() {
    document.querySelectorAll('svg[data-ds-icon="Vietnam"]').forEach(svg => {
      const parent = svg.parentElement;
      if (!parent) return;
      const temp = document.createElement("div");
      temp.innerHTML = US_FLAG_SVG;
      const newSvg = temp.firstElementChild;
      newSvg.setAttribute("width", svg.getAttribute("width") || "20");
      newSvg.setAttribute("height", svg.getAttribute("height") || "20");
      if (svg.className.baseVal) newSvg.setAttribute("class", svg.className.baseVal);
      parent.replaceChild(newSvg, svg);
    });
  }

  // ── 2. SWAP ₫ / đ → $ IN TEXT NODES ──
  function swapCurrency(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      if (!t) continue;
      const pn = node.parentElement?.nodeName;
      if (pn === "SCRIPT" || pn === "STYLE" || pn === "TEXTAREA") continue;

      let n = t;
      n = n.replace(/₫/g, "$");
      if (n === "đ") { n = "$"; }
      else { n = n.replace(/đ(?=\s*[\d,.])/g, "$"); }
      n = n.replace(/\bVND\b/g, "USD");
      if (n !== t) node.textContent = n;
    }
  }

  // ── 3. SWAP đ PREFIXES (positioned divs/spans next to inputs) ──
  function swapPrefixes() {
    document.querySelectorAll("div, span").forEach(el => {
      if (el.children.length === 0 && el.textContent.trim() === "đ") {
        el.textContent = "$";
      }
    });
  }

  // ── 4. FIX COMMA DECIMALS → DOT (Vietnamese locale uses , instead of .) ──
  function fixCommas() {
    document.querySelectorAll('input[data-testid="input-game-amount"], input[data-testid="profit-input"]').forEach(inp => {
      if (inp.value && inp.value.includes(",")) {
        const fixed = inp.value.replace(/,/g, ".");
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeSetter.call(inp, fixed);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    document.querySelectorAll('[data-testid="conversion-amount"] span, [slot="label"] span').forEach(el => {
      if (el.children.length === 0 && /\d,\d/.test(el.textContent)) {
        el.textContent = el.textContent.replace(/(\d),(\d)/g, "$1.$2");
      }
    });
  }

  // ── 5. MULTIPLY ALL DOLLAR AMOUNTS BY 500x ──
  function multiplyAmounts() {
    // Target all spans that display dollar amounts
    document.querySelectorAll('span[data-ds-text="true"]').forEach(el => {
      if (el.getAttribute('data-multiplied')) return;
      const text = el.textContent || '';

      // Dollar amounts like $0.02
      if (text.includes('$')) {
        const match = text.match(/\$([0-9,]+\.?\d*)/);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g, ''));
          if (!isNaN(val)) {
            const newVal = val * MULTIPLIER;
            const formatted = '$' + newVal.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            });
            // Replace in text nodes to preserve surrounding content
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
            let tNode;
            while ((tNode = walker.nextNode())) {
              if (tNode.textContent.includes('$')) {
                tNode.textContent = tNode.textContent.replace(
                  /\$([0-9,]+\.?\d*)/g,
                  (m, num) => {
                    const v = parseFloat(num.replace(/,/g, ''));
                    if (isNaN(v)) return m;
                    return '$' + (v * MULTIPLIER).toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    });
                  }
                );
              }
            }
            el.setAttribute('data-multiplied', '1');
          }
        }
      }

      // Crypto amounts like "0.00000000 USDT"
      if (/[\d.]+\s*(?:USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/.test(text)) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let tNode;
        while ((tNode = walker.nextNode())) {
          const orig = tNode.textContent;
          const replaced = orig.replace(
            /([0-9]+\.?\d*)\s*(USDT|USDC|BTC|ETH|SOL|LTC|DOGE|BNB|XRP|TRX)/g,
            (m, num, coin) => {
              const v = parseFloat(num);
              if (isNaN(v)) return m;
              const decimals = num.includes('.') ? num.split('.')[1].length : 2;
              return (v * MULTIPLIER).toFixed(decimals) + ' ' + coin;
            }
          );
          if (replaced !== orig) tNode.textContent = replaced;
        }
        el.setAttribute('data-multiplied', '1');
      }
    });

    // Multiply input values (bet amount, profit display)
    document.querySelectorAll('input[data-testid="input-game-amount"], input[data-testid="profit-input"]').forEach(inp => {
      if (inp.getAttribute('data-multiplied') || !inp.value) return;
      const val = parseFloat(inp.value);
      if (!isNaN(val) && val > 0) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeSetter.call(inp, (val * MULTIPLIER).toFixed(2));
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.setAttribute('data-multiplied', '1');
      }
    });

    // Patch formattedforfilter attributes (used for search/filter in wallet dropdown)
    document.querySelectorAll('span[formattedforfilter]').forEach(el => {
      if (el.getAttribute('data-filter-patched')) return;
      const raw = el.getAttribute('formattedforfilter');
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) {
        el.setAttribute('formattedforfilter', String(val * MULTIPLIER));
        el.setAttribute('data-filter-patched', '1');
      }
    });
  }

  // ── 6. RE-CHECK — clear stale flags when Svelte re-renders values ──
  function clearStaleFlags() {
    document.querySelectorAll('span[data-multiplied][data-ds-text="true"]').forEach(el => {
      const text = el.textContent || '';
      if (text.includes('$')) {
        const match = text.match(/\$([0-9,]+\.?\d*)/);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g, ''));
          // If value is tiny, Svelte re-rendered the real value — reprocess
          if (val < 5) {
            el.removeAttribute('data-multiplied');
          }
        }
      }
    });
    // Clear input flags when value looks un-multiplied
    document.querySelectorAll('input[data-multiplied]').forEach(inp => {
      const val = parseFloat(inp.value);
      if (!isNaN(val) && val < 5 && val > 0) {
        inp.removeAttribute('data-multiplied');
      }
    });
  }

  // ── FULL SWEEP ──
  function sweep() {
    swapFlags();
    swapCurrency();
    swapPrefixes();
    fixCommas();
    multiplyAmounts();
  }

  // Initial sweeps — aggressive timing for SPA load
  sweep();
  setTimeout(sweep, 100);
  setTimeout(sweep, 300);
  setTimeout(sweep, 600);
  setTimeout(sweep, 1200);
  setTimeout(sweep, 2500);

  // ── MUTATION OBSERVER — catches Svelte re-renders ──
  let rafPending = false;
  const observer = new MutationObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      sweep();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Periodic rescan — catches anything the observer misses + re-renders
  setInterval(() => {
    clearStaleFlags();
    sweep();
  }, 1500);

  console.log("[Stake USD + 500x] v3 active");
})();
