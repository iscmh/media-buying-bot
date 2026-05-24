// ==UserScript==
// @name         Stake IDR → USD Display
// @namespace    https://oclus.io
// @version      4.0.0
// @description  Swaps IDR label to $ for content creation
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

  // ── CSS: hide Indonesia flag instantly to prevent flash ──
  const hideCSS = document.createElement("style");
  hideCSS.textContent = `
    svg[data-ds-icon="Indonesia"] { opacity: 0 !important; transition: none !important; }
  `;
  document.head.appendChild(hideCSS);

  const US_FLAG_SVG = `<svg data-ds-icon="UnitedStatesOfAmerica" width="20" height="20" viewBox="0 0 24 19" xmlns="http://www.w3.org/2000/svg" fill="none"><rect width="24" height="18.333" fill="#F7FAFC" rx=".2"/><path fill="#B31942" d="M1 1h22v16.5H1"/><path fill="#000" d="M1 2.904h22zm22 2.538H1zM1 7.981h22zm22 2.538H1zM1 13.058h22zm22 2.538H1z"/><path fill="#fff" d="M23 14.962v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27zm0-2.538v1.269H1v-1.27zm0-2.539v1.27H1v-1.27z"/><path fill="#0A3161" d="M1 1h12.54v8.885H1"/><path fill="#fff" d="m2.045 1.38.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM3.09 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM5.18 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM7.27 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM9.36 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zM11.45 2.27l.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.567h.965l-.781.567zm1.045-6.22.298.92-.78-.568h.965l-.781.567zm0 1.778.298.918-.78-.567h.965l-.781.567zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.777.298.918-.78-.568h.965l-.781.568zm0 1.776.298.919-.78-.568h.965l-.781.568z"/></svg>`;

  // ── Swap Indonesia flags → US flag ──
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

  // ── Replace "IDR" with "$" in text nodes ──
  function swapIDR(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      if (!t || !t.includes("IDR")) continue;
      const pn = node.parentElement?.nodeName;
      if (pn === "SCRIPT" || pn === "STYLE" || pn === "TEXTAREA") continue;
      // "IDR 410.77" → "$410.77" and "IDR 410.77" → "$410.77"
      node.textContent = t.replace(/IDR[\s ]*/g, "$");
    }
  }

  // ── Also swap "IDR" prefix in before-icon divs (the $ prefix next to inputs) ──
  function swapPrefixes() {
    document.querySelectorAll(".before-icon").forEach(el => {
      if (el.children.length === 0 && el.textContent.trim() === "IDR") {
        el.textContent = "$";
      }
    });
  }

  // ── FULL SWEEP ──
  function sweep() {
    swapFlags();
    swapIDR();
    swapPrefixes();
  }

  // Initial sweeps
  sweep();
  setTimeout(sweep, 100);
  setTimeout(sweep, 300);
  setTimeout(sweep, 600);
  setTimeout(sweep, 1200);

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

  // Fallback periodic scan
  setInterval(sweep, 2000);

  console.log("[Stake IDR→$] v4 active");
})();
