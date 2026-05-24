// ==UserScript==
// @name         Stake IDR → USD Display
// @namespace    https://oclus.io
// @version      5.0.0
// @description  Cosmetic USD overlay for content creation (IDR mode)
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

  // ── INSTANT CSS HIDE — prevents any flash of Indonesia flag ──
  const hideCSS = document.createElement("style");
  hideCSS.textContent = `
    svg[data-ds-icon="Indonesia"] { opacity: 0 !important; transition: none !important; }
  `;
  document.head.appendChild(hideCSS);

  const US_FLAG_SVG = `<svg data-ds-icon="UnitedStatesOfAmerica" width="20" height="20" viewBox="0 0 24 19" xmlns="http://www.w3.org/2000/svg" fill="none"><metadata data-ds-license="true">Derived from flag-icons by Panayiotis Lipiridis (MIT). See https://github.com/lipis/flag-icons</metadata><rect width="24" height="18.333" fill="#F7FAFC" rx=".2"/><path fill="#B31942" d="M1 1h22v16.5H1"/><path fill="#000" d="M1 2.904h22zm22 2.538H1zM1 7.981h22zm22 2.538H1zM1 13.058h22zm22 2.538H1z"/><path fill="#fff" d="M23 14.962v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27z"/><path fill="#0A3161" d="M1 1h12.54v8.885H1"/><path fill="#fff" d="m2.045 1.38.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM3.09 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM5.18 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM7.27 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM9.36 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM11.45 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568z"/></svg>`;

  // ── 1. SWAP INDONESIA FLAG SVGs → US FLAG ──
  function swapFlags() {
    document.querySelectorAll('svg[data-ds-icon="Indonesia"]').forEach(svg => {
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

  // ── 2. SWAP IDR → $ IN TEXT NODES ──
  function swapCurrency(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      if (!t) continue;
      const pn = node.parentElement?.nodeName;
      if (pn === "SCRIPT" || pn === "STYLE" || pn === "TEXTAREA") continue;

      let n = t;
      // "IDR 410.77" or "IDR 410.77" → "$410.77"
      n = n.replace(/IDR[\s ]*/g, "$");
      n = n.replace(/\bIDR\b/g, "USD");
      if (n !== t) node.textContent = n;
    }
  }

  // ── 3. SWAP IDR PREFIXES (positioned divs/spans next to inputs) ──
  function swapPrefixes() {
    document.querySelectorAll("div, span").forEach(el => {
      if (el.children.length === 0 && el.textContent.trim() === "IDR") {
        el.textContent = "$";
      }
    });
  }

  // ── 4. FIX COMMA DECIMALS ──
  // type="number" always renders with locale formatting (comma in IDR locale).
  // Changing to type="text" stops the browser from applying locale display.
  function fixCommas() {
    document.querySelectorAll('input[data-testid="input-game-amount"]').forEach(inp => {
      if (inp.type === "number") {
        const currentVal = inp.value;
        inp.setAttribute("type", "text");
        inp.setAttribute("inputmode", "decimal");
        inp.setAttribute("pattern", "[0-9.]*");
        if (currentVal) inp.value = currentVal;
      }
    });
    document.querySelectorAll('[data-testid="conversion-amount"] span, [slot="label"] span').forEach(el => {
      if (el.children.length === 0 && /\d,\d/.test(el.textContent)) {
        el.textContent = el.textContent.replace(/(\d),(\d)/g, "$1.$2");
      }
    });
  }

  // ── 5. FIX USDT CONVERSION AMOUNTS ──
  // The small text shows real crypto value — replace with the displayed $ amount as USDT (1 USDT ≈ $1)
  function fixConversions() {
    document.querySelectorAll('[data-testid="conversion-amount"]').forEach(el => {
      const text = el.textContent.trim();
      if (/[\d.,]+\s*USDT/i.test(text)) {
        const label = el.closest("label") || el.closest("span")?.closest("label");
        if (!label) return;
        const inp = label.querySelector('input[data-testid="input-game-amount"]') ||
                    label.querySelector('input[data-testid="profit-input"]');
        if (inp && inp.value) {
          let val = inp.value.replace(/,/g, ".");
          let num = parseFloat(val);
          if (!isNaN(num)) {
            const formatted = num.toFixed(8) + " USDT";
            const span = el.querySelector("span") || el;
            if (span.textContent.trim() !== formatted) {
              span.textContent = formatted;
            }
          }
        }
      }
    });
  }

  // ── FULL SWEEP ──
  function sweep() {
    swapFlags();
    swapCurrency();
    swapPrefixes();
    fixCommas();
    fixConversions();
  }

  // Initial sweeps — aggressive timing
  sweep();
  setTimeout(sweep, 100);
  setTimeout(sweep, 300);
  setTimeout(sweep, 600);
  setTimeout(sweep, 1200);

  // ── MUTATION OBSERVER — catches every Svelte re-render instantly ──
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

  // Fallback for anything missed
  setInterval(sweep, 2000);

  console.log("[Stake IDR→USD] v5 active");
})();
