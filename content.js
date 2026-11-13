// Continuous Sanity — content script
// Injected on every page. Deterministic capture only — no AI runs here.
//
// This script no longer owns any UI of its own (no floating button, no modal).
// It's a thin "spotter": the side panel arms it, it highlights whatever the
// tester hovers, and on click it gathers everything deterministic (selector,
// label, screenshot, device info) and hands it to the side panel, which owns
// all the actual UI (intent, comment, send).

(function () {
  // Dynamic reinjection happens when an already-open page survives an
  // extension reload. Remove the old handlers first so an invalidated script
  // cannot swallow picker clicks before the current script sees them.
  if (window.__continuousSanityPicker && window.__continuousSanityPicker.dispose) {
    window.__continuousSanityPicker.dispose();
  }

  let armed = false;
  let highlightBox = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "ARM_PICKER") {
      arm();
    } else if (message.type === "DISARM_PICKER") {
      disarm();
    }
  });

  function arm() {
    if (armed) return;
    armed = true;
    document.body.style.cursor = "crosshair";
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function disarm() {
    armed = false;
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (highlightBox) {
      highlightBox.remove();
      highlightBox = null;
    }
  }

  window.__continuousSanityPicker = { dispose: disarm };

  function onKeyDown(e) {
    if (e.key === "Escape") disarm();
  }

  function ensureHighlightBox() {
    if (highlightBox) return highlightBox;
    highlightBox = document.createElement("div");
    Object.assign(highlightBox.style, {
      position: "fixed",
      zIndex: 2147483647,
      pointerEvents: "none",
      border: "2px solid #dc2626",
      background: "rgba(220,38,38,0.08)",
      borderRadius: "4px",
      transition: "all 60ms ease-out",
    });
    document.body.appendChild(highlightBox);
    return highlightBox;
  }

  function onMouseMove(e) {
    if (!armed) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const rect = el.getBoundingClientRect();
    const box = ensureHighlightBox();
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function onClick(e) {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    const clickX = e.clientX;
    const clickY = e.clientY;
    disarm();
    pickElement(target, clickX, clickY);
  }

  function deviceInfo() {
    const ua = navigator.userAgent;
    const browserMatch = ua.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/);
    return {
      userAgent: ua,
      platform: navigator.platform,
      browser: browserMatch ? browserMatch[0] : "unknown",
      language: navigator.language,
    };
  }

  function cssSelector(el) {
    if (!(el instanceof Element)) return null;
    const path = [];
    while (el.nodeType === Node.ELEMENT_NODE && path.length < 6) {
      let selector = el.nodeName.toLowerCase();
      if (el.id) {
        selector += `#${el.id}`;
        path.unshift(selector);
        break;
      } else {
        let sibling = el,
          nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.nodeName.toLowerCase() === selector) nth++;
        }
        selector += `:nth-of-type(${nth})`;
      }
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(" > ");
  }

  // Human-readable "what did they click," in priority order — this is what shows up
  // in reports and feeds the AI. The raw CSS path (cssSelector above) is kept only as
  // a secondary, collapsed technical detail for engineers who explicitly want it —
  // nth-of-type paths mean nothing to a reader and don't map to component names anyway.
  function humanElementLabel(el) {
    if (!(el instanceof Element)) return "unknown element";

    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    if (el.id) {
      const labelFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelFor && labelFor.innerText.trim()) return labelFor.innerText.trim();
    }

    const closestLabel = el.closest("label");
    if (closestLabel && closestLabel.innerText.trim()) return closestLabel.innerText.trim();

    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const name = el.getAttribute("name");
    if (name) return name;

    const ownText = (el.innerText || el.value || "").trim();
    if (ownText) return ownText.slice(0, 80);

    // Walk up a few ancestors looking for a nearby heading or label to at least
    // say roughly where on the page this is, e.g. `near "Farm location"`.
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i++) {
      const heading = node.querySelector ? node.querySelector("h1, h2, h3, label") : null;
      if (heading && heading.innerText.trim()) {
        return `near "${heading.innerText.trim().slice(0, 60)}"`;
      }
      node = node.parentElement;
    }

    return `<${el.tagName.toLowerCase()}>`;
  }

  // Full viewport capture — no cropping. Cropping to just the clicked element
  // throws away the surrounding context (nav, layout, what's near what) that
  // most alignment issues actually live in. The click position is sent
  // separately (see pickElement) so the dashboard/side panel can overlay a
  // pin on top of the full screenshot instead.
  function captureScreenshot() {
    // The screenshot is supporting evidence, never a reason to strand the
    // tester in picker mode. Continue without it if Chrome does not answer.
    return new Promise((resolve) => {
      let settled = false;
      const finish = (dataUrl) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(dataUrl || null);
      };
      const timeout = setTimeout(() => finish(null), 2000);
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn("[Continuous Sanity] screenshot capture failed", chrome.runtime.lastError.message);
            finish(null);
            return;
          }
          finish(response && !response.error ? response.dataUrl : null);
        });
      } catch (err) {
        console.warn("[Continuous Sanity] screenshot capture failed", err);
        finish(null);
      }
    });
  }

  async function pickElement(target, clickX, clickY) {
    const screenshotData = await captureScreenshot();

    chrome.runtime.sendMessage({
      type: "ELEMENT_PICKED",
      payload: {
        pageUrl: window.location.href,
        pageTitle: document.title,
        elementSelector: cssSelector(target),
        elementLabel: humanElementLabel(target),
        elementText: (target.innerText || "").slice(0, 500),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
        },
        clickX,
        clickY,
        deviceInfo: deviceInfo(),
        screenshotData,
      },
    });
  }
})();
