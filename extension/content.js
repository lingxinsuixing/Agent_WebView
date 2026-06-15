// ── Chrome MCP Browser — Content Script ──
// Runs in every page, provides full DOM introspection and interaction
(function() {
"use strict";

// ═══════════════════════════════════════════════
// Data Extraction
// ═══════════════════════════════════════════════

function getMeta() {
  const meta = {};
  document.querySelectorAll("meta").forEach((m) => {
    const name = m.getAttribute("name") || m.getAttribute("property") || "";
    const content = m.getAttribute("content") || "";
    if (name && content) meta[name] = content;
  });
  return meta;
}

// Enhanced image info extraction
function getDetailedImages() {
  const imgs = [];
  document.querySelectorAll("img").forEach((img) => {
    const rect = img.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isVisible = rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;

    const srcsetItems = [];
    if (img.srcset) {
      img.srcset.split(",").forEach((s) => {
        const [url, size] = s.trim().split(/\s+/);
        if (url) srcsetItems.push({ url, size: size || "1x" });
      });
    }

    // Detect if it's a data URL
    const isDataUrl = img.src?.startsWith("data:");

    // Get lazy loading attribute
    const loading = img.getAttribute("loading") || "auto";

    // Check for picture parent
    const pictureEl = img.closest("picture");
    let sources = [];
    if (pictureEl) {
      sources = Array.from(pictureEl.querySelectorAll("source")).map((s) => ({
        srcset: s.getAttribute("srcset") || "",
        media: s.getAttribute("media") || "",
        type: s.getAttribute("type") || "",
      }));
    }

    // Figure context
    const figure = img.closest("figure");
    const figcaption = figure?.querySelector("figcaption")?.textContent?.trim() || "";

    imgs.push({
      src: img.src,
      alt: img.alt || "",
      altText: img.alt ? (img.alt.length > 0 ? "有描述" : "空alt") : "无alt",
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayedWidth: rect.width,
      displayedHeight: rect.height,
      aspectRatio: img.naturalHeight > 0 ? (img.naturalWidth / img.naturalHeight).toFixed(2) : null,
      position: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      },
      isVisible,
      isInViewport: isVisible,
      loading,
      isDataUrl,
      srcset: srcsetItems,
      pictureSources: sources,
      figcaption,
      complete: img.complete,
      hasNaturalSize: img.naturalWidth > 0,
      className: img.className || "",
      id: img.id || "",
    });
  });

  // Also collect CSS background images (up to 50)
  const bgImages = [];
  const allEls = document.querySelectorAll("*");
  for (let i = 0; i < allEls.length && bgImages.length < 50; i++) {
    const el = allEls[i];
    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none" && bg.includes("url(")) {
      const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g) || [];
      urls.forEach((u) => {
        const url = u.replace(/url\(["']?|["']?\)/g, "");
        if (url && !url.startsWith("data:")) {
          bgImages.push({
            url,
            tagName: el.tagName,
            id: el.id || "",
            className: el.className?.slice(0, 100) || "",
            selector: getUniqueSelector(el),
          });
        }
      });
    }
  }

  return { imgs: imgs.slice(0, 300), bgImages: bgImages.slice(0, 50) };
}

// Get a unique CSS selector for an element
function getUniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const path = [];
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      path.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    if (current.className && typeof current.className === "string") {
      const classes = current.className.trim().split(/\s+/).filter(Boolean);
      if (classes.length <= 3) {
        selector += "." + classes.map((c) => CSS.escape(c)).join(".");
      }
    }
    // Add nth-child if needed
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-child(${idx})`;
      }
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(" > ");
}

// Extract all tables
function getTables() {
  const tables = [];
  document.querySelectorAll("table").forEach((table, idx) => {
    const caption = table.querySelector("caption")?.textContent?.trim() || "";
    const headers = [];
    const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
    if (headerRow) {
      headerRow.querySelectorAll("th, td").forEach((h) => {
        headers.push(h.textContent.trim().slice(0, 100));
      });
    }

    const rows = [];
    table.querySelectorAll("tbody tr, tr").forEach((tr) => {
      // Skip header row if it's the first
      const cells = [];
      tr.querySelectorAll("td, th").forEach((td) => {
        cells.push(td.textContent.trim().slice(0, 200));
      });
      if (cells.length > 0 && cells.length === headers.length) {
        rows.push(cells);
      } else if (cells.length > 0) {
        rows.push(cells); // Allow non-matching lengths
      }
    });

    const rect = table.getBoundingClientRect();
    tables.push({
      index: idx,
      caption,
      headers,
      rowCount: rows.length,
      colCount: headers.length || (rows[0]?.length || 0),
      rows: rows.slice(0, 100),
      selector: table.id ? `#${CSS.escape(table.id)}` : `table:nth-of-type(${idx + 1})`,
      summary: table.getAttribute("summary") || "",
    });
  });
  return tables.slice(0, 50);
}

// Extract all forms (including standalone search inputs)
function getForms() {
  const forms = [];
  
  // Find <form> elements
  document.querySelectorAll("form").forEach((form, idx) => {
    const fields = [];
    form.querySelectorAll("input, textarea, select, button").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const name = el.getAttribute("name") || "";
      const id = el.id || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const label = form.querySelector(`label[for="${id}"]`)?.textContent?.trim() || "";
      const parentLabel = el.closest("label")?.textContent?.trim()?.slice(0, 100) || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const required = el.hasAttribute("required");
      const disabled = el.disabled;
      const readonly = el.hasAttribute("readonly");
      const value = el.value?.slice(0, 100) || "";
      const selector = id ? `#${CSS.escape(id)}` : el.name ? `[name="${CSS.escape(el.name)}"]` : `${tag}:nth-of-type(${idx + 1})`;

      fields.push({
        tag, type: tag === "input" ? type : tag, name, id, selector,
        label: label || parentLabel || ariaLabel || placeholder,
        placeholder, required, disabled, readonly, value,
        options: tag === "select" ? Array.from(el.options).map((o) => ({ text: o.text, value: o.value, selected: o.selected })) : undefined,
        rows: tag === "textarea" ? el.rows : undefined,
      });
    });

    forms.push({
      index: idx, id: form.id || "", name: form.getAttribute("name") || "",
      action: form.action || "", method: form.method || "get",
      selector: form.id ? `#${CSS.escape(form.id)}` : `form:nth-of-type(${idx + 1})`,
      fields, fieldCount: fields.length, type: "form",
    });
  });

  // Find standalone search inputs (not inside a <form>)
  document.querySelectorAll("input[type=search], input[placeholder*='搜索'], input[placeholder*='search'], input[aria-label*='搜索'], input[aria-label*='search'], input[name*='q'], input[name*='wd'], input[name*='search'], input[name*='keyword'], input[role=searchbox]").forEach((el) => {
    if (el.closest("form")) return; // already captured
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return; // invisible
    forms.push({
      index: forms.length, id: el.id || "", name: el.name || "",
      action: "", method: "", type: "search",
      selector: el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${CSS.escape(el.name)}"]` : `input[placeholder="${el.placeholder}"]`,
      fields: [{
        tag: "input", type: "search", name: el.name || "", id: el.id || "",
        selector: el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${CSS.escape(el.name)}"]` : `input[placeholder="${el.placeholder}"]`,
        label: el.getAttribute("aria-label") || el.placeholder || "搜索",
        placeholder: el.placeholder || "", required: false, disabled: false, readonly: false, value: el.value || "",
      }],
      fieldCount: 1,
    });
  });

  return forms.slice(0, 20);
}

// Article extraction (simplified Readability-like)
function extractArticle() {
  const selectors = [
    "article",
    '[role="main"]',
    "main",
    ".post-content",
    ".article-content",
    ".entry-content",
    ".content",
    "#content",
    "#article",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 200) return cleanArticle(el);
  }
  const blocks = Array.from(document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote"));
  const texts = blocks.filter((b) => b.textContent.trim().length > 20).map((b) => b.tagName + " " + b.textContent.trim());
  return texts.length > 5 ? texts.join("\n\n") : document.body?.innerText || "";
}

function cleanArticle(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("script, style, nav, footer, header, .nav, .sidebar, .menu, .ad, .advertisement, .social-share, noscript")
    .forEach((n) => n.remove());
  const lines = [];
  clone.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, pre, blockquote, td, th, div").forEach((b) => {
    const t = b.textContent.trim();
    if (t.length > 5) lines.push(t);
  });
  return lines.join("\n\n");
}

// Get element info by selector
function getElementInfo(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { error: `未找到匹配选择器的元素: ${selector}` };

    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();

    const info = {
      tag,
      id: el.id || "",
      className: el.className?.toString()?.slice(0, 200) || "",
      selector: getUniqueSelector(el),
      text: el.textContent?.trim()?.slice(0, 1000) || "",
      innerText: el.innerText?.trim()?.slice(0, 1000) || "",
      // HTML is only included for specific elements
      html: ["p", "span", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "a"].includes(tag)
        ? el.outerHTML?.slice(0, 2000) || ""
        : "",
      // Attributes
      attributes: getAttributes(el),
      // Position
      position: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      // Visibility
      isVisible: rect.width > 0 && rect.height > 0,
      isInViewport: rect.top < window.innerHeight && rect.bottom > 0,
      // Computed style
      display: styles.display,
      visibility: styles.visibility,
      opacity: styles.opacity,
      // Children count
      childCount: el.children.length,
      // Link target
      tagSpecific: tag === "a" ? { href: el.href, target: el.target } :
                    tag === "img" ? { src: el.src, alt: el.alt, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight } :
                    tag === "input" || tag === "textarea" ? { value: el.value, type: el.getAttribute("type") || tag } :
                    tag === "select" ? { value: el.value, options: Array.from(el.options).map(o => ({ text: o.text, value: o.value, selected: o.selected })) } :
                    tag === "video" ? { src: el.src, duration: el.duration, paused: el.paused } :
                    tag === "audio" ? { src: el.src, duration: el.duration, paused: el.paused } :
                    undefined,
    };
    return info;
  } catch (e) {
    return { error: `获取元素信息失败: ${e.message}` };
  }
}

function getAttributes(el) {
  const attrs = {};
  if (el.attributes) {
    Array.from(el.attributes).slice(0, 30).forEach((a) => {
      attrs[a.name] = a.value;
    });
  }
  return attrs;
}

// Get selected text with context
function getSelectedText() {
  const sel = window.getSelection();
  if (!sel || !sel.toString().trim()) return { text: "", error: "没有选中的文本" };
  const text = sel.toString().trim();
  const range = sel.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container.nodeType === 3 ? container.parentElement : container;

  return {
    text: text.slice(0, 5000),
    length: text.length,
    selector: element ? getUniqueSelector(element) : "",
    tagName: element?.tagName?.toLowerCase() || "",
  };
}

// Get cookies
function getCookies() {
  try {
    const cookies = document.cookie.split(";").filter(Boolean).map((c) => {
      const [name, ...rest] = c.trim().split("=");
      // Mask values for privacy
      const val = rest.join("=");
      return {
        name: name?.trim() || "",
        value: val.slice(0, 200),
        masked: val.length > 20 ? val.slice(0, 3) + "***" : val,
      };
    });
    return cookies;
  } catch (e) {
    return [];
  }
}

// Get storage
function getStorage(type = "local") {
  try {
    const store = type === "session" ? sessionStorage : localStorage;
    const items = {};
    for (let i = 0; i < store.length && Object.keys(items).length < 100; i++) {
      const key = store.key(i);
      items[key] = store.getItem(key)?.slice(0, 500) || "";
    }
    return items;
  } catch (e) {
    return { error: `无法读取 ${type}Storage: ${e.message}` };
  }
}

// Get all links
function getLinks() {
  return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
    text: a.textContent.trim().slice(0, 200),
    href: a.href,
    target: a.target || "_self",
    rel: a.rel || "",
    isExternal: a.hostname !== location.hostname,
    selector: getUniqueSelector(a),
  }));
}

// Get headings structure
function getHeadings() {
  const hTags = ["h1", "h2", "h3", "h4", "h5", "h6"];
  return hTags.flatMap((tag) =>
    Array.from(document.querySelectorAll(tag)).map((h) => ({
      level: parseInt(tag[1]),
      text: h.textContent.trim().slice(0, 200),
      selector: getUniqueSelector(h),
    }))
  );
}

// Get console logs + JS errors
const capturedLogs = [];
const capturedErrors = [];

function captureConsole() {
  ["log", "warn", "error", "info", "debug"].forEach((level) => {
    const orig = console[level];
    console[level] = function (...args) {
      capturedLogs.push({
        level,
        message: args.map((a) => (typeof a === "object" ? JSON.stringify(a).slice(0, 200) : String(a))).join(" ").slice(0, 500),
        timestamp: Date.now(),
      });
      if (capturedLogs.length > 200) capturedLogs.shift();
      return orig.apply(console, args);
    };
  });

  // Track JS runtime errors
  window.addEventListener("error", (e) => {
    capturedErrors.push({
      type: "runtime_error",
      message: e.message?.slice(0, 200),
      source: e.filename?.slice(-100) || "",
      line: e.lineno,
      col: e.colno,
      timestamp: Date.now(),
    });
    if (capturedErrors.length > 100) capturedErrors.shift();
  });

  // Track unhandled promise rejections
  window.addEventListener("unhandledrejection", (e) => {
    capturedErrors.push({
      type: "unhandled_rejection",
      message: (e.reason?.message || String(e.reason || "")).slice(0, 200),
      timestamp: Date.now(),
    });
    if (capturedErrors.length > 100) capturedErrors.shift();
  });

  // Track CSP violations via securitypolicyviolation event
  document.addEventListener("securitypolicyviolation", (e) => {
    capturedErrors.push({
      type: "csp_violation",
      message: `CSP 违规: 违反了 ${e.effectiveDirective} 策略 — ${e.blockedURI?.slice(0, 100)}`,
      timestamp: Date.now(),
    });
  });
}
// captureConsole is called at module load time below

// Get all page data in one shot
function getAllPageData() {
  const title = document.title;
  const url = window.location.href;
  const text = document.body?.innerText || "";
  const article = extractArticle();
  const html = document.documentElement?.innerHTML || "";
  const links = getLinks();
  const { imgs, bgImages } = getDetailedImages();
  const meta = getMeta();
  const tables = getTables();
  const forms = getForms();
  const headings = getHeadings();
  const cookies = getCookies();
  const ads = detectAds();
  const filteredLinks = filterAdsFromLinks(links, ads);
  const filteredImgs = filterAdsFromImages(imgs, ads);
  const filteredText = filterAdsFromText(text, ads);

  return {
    type: "page_update",
    url,
    title,
    text: filteredText.slice(0, 100000),
    article: article.slice(0, 50000),
    html: html.slice(0, 50000),
    links: filteredLinks.slice(0, 500),
    images: filteredImgs.slice(0, 300),
    bgImages: bgImages.slice(0, 50),
    ads: ads.slice(0, 100),
    meta,
    tables: tables.slice(0, 50),
    forms: forms.slice(0, 20),
    headings: headings.slice(0, 100),
    cookies: cookies.slice(0, 50),
    pageInfo: {
      charCount: text.length,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      linkCount: filteredLinks.length,
      imageCount: filteredImgs.length + bgImages.length,
      tableCount: tables.length,
      formCount: forms.length,
      headingCount: headings.length,
      adCount: ads.length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollHeight: document.documentElement.scrollHeight,
      documentSize: document.documentElement.innerHTML.length,
    },
  };
}

// ═══════════════════════════════════════════════
// Actions (executed on demand from background)
// ═══════════════════════════════════════════════

function clickElement(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `未找到元素: ${selector}` };
    el.click();
    return { success: true, tag: el.tagName, text: el.textContent?.trim()?.slice(0, 100) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function typeText(selector, text) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `未找到元素: ${selector}` };
    el.focus();
    if (el.value !== undefined) {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.textContent = text;
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function selectOption(selector, value) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `未找到元素: ${selector}` };
    if (el.tagName !== "SELECT") return { success: false, error: "元素不是 select" };
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, selectedValue: el.value };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function hoverElement(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `未找到元素: ${selector}` };
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function highlightElement(selector, color = "#ff0") {
  try {
    const el = document.querySelector(selector);
    if (!el) return { success: false, error: `未找到元素: ${selector}` };
    const origOutline = el.style.outline;
    const origBg = el.style.backgroundColor;
    el.style.outline = `3px solid ${color}`;
    el.style.backgroundColor = color + "33"; // with alpha
    return {
      success: true,
      selector: getUniqueSelector(el),
      tag: el.tagName,
      text: el.textContent?.trim()?.slice(0, 100),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function scrollPage(direction, amount = 500) {
  switch (direction) {
    case "down": window.scrollBy({ top: amount, behavior: "smooth" }); break;
    case "up": window.scrollBy({ top: -amount, behavior: "smooth" }); break;
    case "top": window.scrollTo({ top: 0, behavior: "smooth" }); break;
    case "bottom": window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
    default: return { success: false, error: `未知方向: ${direction}` };
  }
  return {
    success: true,
    scrollY: window.scrollY,
    maxScroll: document.body.scrollHeight - window.innerHeight,
  };
}

// ═══════════════════════════════════════════════
// Debug Info (Performance API + runtime errors)
// ═══════════════════════════════════════════════

function getDebugInfo() {
  const debug = {};

  // ── Performance API: 资源加载状态 ──
  try {
    const resources = performance.getEntriesByType("resource");
    // Group by response status (via initiatorType + transferSize)
    const blocked = [];
    const slow = [];
    const large = [];
    const byType = {};

    resources.forEach((r) => {
      const type = r.initiatorType || "other";
      if (!byType[type]) byType[type] = { total: 0, failed: 0, totalSize: 0 };

      byType[type].total++;
      byType[type].totalSize += r.transferSize || 0;

      // Detect potentially blocked resources
      // transferSize=0 and duration>0 often means CORS blocked or failed
      if (r.transferSize === 0 && r.duration > 0 && !r.name.startsWith("data:")) {
        byType[type].failed++;
        if (blocked.length < 20) {
          blocked.push({
            url: r.name.slice(0, 150),
            type,
            duration: Math.round(r.duration) + "ms",
            reason: "transferSize=0（可能被 CORS 阻止/加载失败）",
          });
        }
      }

      // Detect slow resources (>5s)
      if (r.duration > 5000) {
        if (slow.length < 20) {
          slow.push({
            url: r.name.slice(0, 150),
            type,
            duration: Math.round(r.duration) + "ms",
          });
        }
      }

      // Detect large resources
      if ((r.transferSize || 0) > 5 * 1024 * 1024) {
        if (large.length < 10) {
          large.push({
            url: r.name.slice(0, 150),
            type,
            size: (r.transferSize / 1024 / 1024).toFixed(1) + "MB",
          });
        }
      }
    });

    debug.resourceSummary = {
      total: resources.length,
      byType: Object.entries(byType).map(([type, stats]) => ({
        type,
        count: stats.total,
        failed: stats.failed,
        totalSize: stats.totalSize > 1024 * 1024
          ? (stats.totalSize / 1024 / 1024).toFixed(1) + "MB"
          : stats.totalSize > 1024
            ? (stats.totalSize / 1024).toFixed(1) + "KB"
            : stats.totalSize + "B",
      })),
      blockedCount: blocked.length,
      slowCount: slow.length,
      largeCount: large.length,
    };
    if (blocked.length > 0) debug.blockedResources = blocked;
    if (slow.length > 0) debug.slowResources = slow;
    if (large.length > 0) debug.largeResources = large;

    // Check for specific blocked patterns (anti-crawling related)
    const blockedPatterns = {
      "challenge": /challenge|verify|captcha|human/,
      "waf": /waf|shield|protection|security/,
      "analytics": /analytics|tracking|beacon/,
      "cdn": /cdn-cgi|akamai|cloudflare/,
    };
    const blockedCategories = [];
    blocked.forEach((r) => {
      Object.entries(blockedPatterns).forEach(([cat, pattern]) => {
        if (pattern.test(r.url) && !blockedCategories.includes(cat)) {
          blockedCategories.push(cat);
        }
      });
    });
    if (blockedCategories.length > 0) {
      debug.blockedCategories = blockedCategories;
    }
  } catch (e) {
    debug.resourceError = e.message;
  }

  // ── Navigation Timing ──
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      debug.navigation = {
        type: nav.type, // navigate, reload, back_forward, prerender
        dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart) + "ms",
        tcp: Math.round(nav.connectEnd - nav.connectStart) + "ms",
        tls: (nav.secureConnectionStart ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0) + "ms",
        ttfb: Math.round(nav.responseStart - nav.requestStart) + "ms",
        download: Math.round(nav.responseEnd - nav.responseStart) + "ms",
        domReady: Math.round(nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart) + "ms",
        domInteractive: Math.round(nav.domInteractive - nav.domContentLoadedEventStart) || "N/A",
        total: Math.round(nav.loadEventEnd - nav.startTime) + "ms",
        redirectCount: nav.redirectCount,
        transferSize: nav.transferSize > 0
          ? (nav.transferSize > 1024 ? (nav.transferSize / 1024).toFixed(1) + "KB" : nav.transferSize + "B")
          : "N/A",
      };
    }
  } catch (e) {
    debug.navError = e.message;
  }

  // ── Network Information ──
  try {
    if (navigator.connection) {
      debug.network = {
        effectiveType: navigator.connection.effectiveType, // 4g, 3g, 2g, slow-2g
        downlink: navigator.connection.downlink + " Mbps",
        rtt: navigator.connection.rtt + "ms",
        saveData: navigator.connection.saveData || false,
      };
    }
  } catch (e) {
    debug.networkError = e.message;
  }

  // ── JS Errors ──
  if (capturedErrors.length > 0) {
    debug.jsErrors = {
      total: capturedErrors.length,
      byType: {},
      recent: capturedErrors.slice(-20),
    };
    capturedErrors.forEach((e) => {
      if (!debug.jsErrors.byType[e.type]) debug.jsErrors.byType[e.type] = 0;
      debug.jsErrors.byType[e.type]++;
    });
    // Highlight CSP violations specifically
    const cspViolations = capturedErrors.filter((e) => e.type === "csp_violation");
    if (cspViolations.length > 0) {
      debug.cspViolations = cspViolations.slice(-10);
    }
  }

  // ── Timing-specific anti-crawl indicators ──
  const antiCrawlTiming = [];
  if (debug.navigation) {
    // Suspiciously fast TTFB + DOM Interactive (JS challenge)
    const ttfb = parseInt(debug.navigation.ttfb);
    const domInt = debug.navigation.domInteractive;
    if (ttfb > 3000) {
      antiCrawlTiming.push(`⏱ TTFB=${debug.navigation.ttfb}（超长服务器响应时间，可能经过 WAF 检查）`);
    }
    if (debug.navigation.redirectCount > 2) {
      antiCrawlTiming.push(`🔄 ${debug.navigation.redirectCount} 次重定向（可能经过 WAF/挑战页跳转）`);
    }
    if (debug.navigation.type === "prerender") {
      antiCrawlTiming.push("⚡ 预渲染加载（可能用于 SEO/缓存）");
    }
  }
  if (debug.resourceSummary?.blockedCount > 0) {
    antiCrawlTiming.push(`🚫 ${debug.resourceSummary.blockedCount} 个资源加载失败（可能被 CORS 策略/WAF 拦截）`);
  }
  if (debug.cspViolations?.length > 0) {
    antiCrawlTiming.push(`🔒 ${debug.cspViolations.length} 次 CSP 违规（严格的 CSP 策略）`);
  }
  debug.antiCrawlTiming = antiCrawlTiming;

  return debug;
}

// ═══════════════════════════════════════════════
// Anti-Crawling Analysis
// ═══════════════════════════════════════════════

function analyzeAntiCrawl() {
  const results = {};

  // ── 1. CAPTCHA 检测 ──
  const captcha = { found: false, types: [], details: [] };

  // reCAPTCHA v2/v3
  if (document.querySelector('.g-recaptcha, div[class*="recaptcha"], iframe[src*="recaptcha"], script[src*="recaptcha"]')) {
    captcha.found = true;
    captcha.types.push("reCAPTCHA");
    captcha.details.push("检测到 Google reCAPTCHA（class/iframe/script）");
  }
  // hCaptcha
  if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"], script[src*="hcaptcha"]')) {
    captcha.found = true;
    captcha.types.push("hCaptcha");
    captcha.details.push("检测到 hCaptcha");
  }
  // Cloudflare Turnstile
  if (document.querySelector('.cf-turnstile, div[data-turnstile], iframe[src*="turnstile"], script[src*="turnstile"]')) {
    captcha.found = true;
    captcha.types.push("Cloudflare Turnstile");
    captcha.details.push("检测到 Cloudflare Turnstile");
  }
  // FunCAPTCHA
  if (document.querySelector('iframe[src*="funcaptcha"], script[src*="funcaptcha"]')) {
    captcha.found = true;
    captcha.types.push("FunCAPTCHA");
    captcha.details.push("检测到 FunCAPTCHA / Arkose Labs");
  }
  // Image CAPTCHAs (common patterns)
  const pageText = document.body?.innerText || "";
  const html = document.documentElement?.innerHTML || "";
  const captchaKeywords = ["captcha", "验证码", "人机验证", "安全验证", "请输入验证码", "点击按钮开始验证"];
  const foundKeywords = captchaKeywords.filter(k => pageText.includes(k) || html.includes(k));
  if (foundKeywords.length > 0 && !captcha.found) {
    captcha.found = true;
    captcha.types.push("文本关键词匹配");
    captcha.details.push(`页面包含反爬关键词: ${foundKeywords.join(", ")}`);
  }
  results.captcha = captcha;

  // ── 2. WAF / 挑战页面检测 ──
  const waf = { detected: false, provider: null, indicators: [] };

  // Cloudflare
  if (html.includes("cf-browser-racing") || html.includes("challenge-platform") ||
      html.includes("cdn-cgi/challenge-platform") || html.includes("__cf_chl_f_tk") ||
      /Attention:.*Cloudflare/i.test(pageText) || /Checking your browser.*Cloudflare/i.test(pageText) ||
      /Just a moment/i.test(pageText) || /DDoS protection/i.test(pageText)) {
    waf.detected = true;
    waf.provider = "Cloudflare";
    waf.indicators.push("Cloudflare 浏览器检查/挑战页面");
  }
  // Imperva / Incapsula
  if (html.includes("incapsula") || html.includes("_Incapsula_Resource") ||
      /Reference.*#[0-9a-f]{8}/i.test(pageText) || /Contacting.*incapsula/i.test(pageText)) {
    waf.detected = true;
    waf.provider = waf.provider || "Imperva/Incapsula";
    waf.indicators.push("Imperva/Incapsula WAF 检测");
  }
  // Akamai
  if (html.includes("akamai") || html.includes("akamaized") ||
      /Reference.*#akamai/i.test(pageText)) {
    waf.detected = true;
    waf.provider = waf.provider || "Akamai";
    waf.indicators.push("Akamai 检测");
  }
  // Generic WAF text
  const wafTexts = ["verify you are human", "please verify you are a human", "请完成安全验证",
    "检测到异常访问", "请求过于频繁", "access denied", "too many requests",
    "your request has been blocked", "please wait while we verify"];
  const foundWaf = wafTexts.filter(t => pageText.toLowerCase().includes(t));
  if (foundWaf.length > 0) {
    waf.detected = true;
    waf.indicators.push(`WAF 关键词: ${foundWaf.join(", ")}`);
  }
  results.waf = waf;

  // ── 3. 浏览器指纹检测脚本 ──
  const fingerprint = { detected: false, scripts: [], indicators: [] };

  // Fingerprinting libraries
  const fpPatterns = [
    { name: "FingerprintJS", patterns: ["fingerprintjs", "@fingerprintjs", "fpjs"] },
    { name: "ClientJS", patterns: ["clientjs", "client.js"] },
    { name: "Fingerprint2", patterns: ["fingerprint2"] },
    { name: "Fingerprint3", patterns: ["fingerprint3"] },
    { name: "AudioContext Fingerprint", patterns: ["audioContext", "audio_context", "getChannelData"] },
    { name: "Canvas Fingerprint", patterns: ["toDataURL", "canvas fingerprint", "getImageData"] },
    { name: "WebGL Fingerprint", patterns: ["webgl", "WEBGL_debug_renderer_info", "getParameter.*renderer"] },
  ];
  fpPatterns.forEach((fp) => {
    const found = fp.patterns.some(p => html.toLowerCase().includes(p));
    if (found) {
      fingerprint.detected = true;
      fingerprint.scripts.push(fp.name);
    }
  });

  // Check script tags for fingerprinting libraries
  const scripts = document.querySelectorAll("script");
  const scriptSrcs = Array.from(scripts).map(s => s.src || s.textContent?.slice(0, 200) || "").filter(Boolean);
  const fpLibs = ["fingerprint", "fpjs", "clientjs", "detector", "min_max"];
  scriptSrcs.forEach((src) => {
    const foundLib = fpLibs.find(lib => src.toLowerCase().includes(lib));
    if (foundLib) {
      const name = src.split("/").pop()?.slice(0, 50) || foundLib;
      fingerprint.detected = true;
      fingerprint.indicators.push(`指纹脚本: ${name}`);
    }
  });
  results.fingerprint = fingerprint;

  // ── 4. 隐藏内容检测 ──
  const hidden = { totalHidden: 0, suspiciousPatterns: [], textHiddenByCSS: 0 };
  const allEls = document.querySelectorAll("body *");
  let hiddenCount = 0;
  let textHiddenCount = 0;
  const suspiciousSelectors = [];

  allEls.forEach((el) => {
    const style = window.getComputedStyle(el);
    const isHidden = style.display === "none" || style.visibility === "hidden" ||
                     parseFloat(style.opacity) === 0 || style.position === "absolute" &&
                     (parseInt(style.left) < -5000 || parseInt(style.top) < -5000);
    if (isHidden && el.textContent.trim().length > 10) {
      hiddenCount++;
      if (el.children.length === 0 || el.children.length < 3) {
        textHiddenCount += el.textContent.trim().length;
        if (el.textContent.trim().length > 50 && suspiciousSelectors.length < 10) {
          suspiciousSelectors.push({
            text: el.textContent.trim().slice(0, 80),
            selector: getUniqueSelector(el),
            how: style.display === "none" ? "display:none" :
                 style.visibility === "hidden" ? "visibility:hidden" :
                 parseFloat(style.opacity) === 0 ? "opacity:0" :
                 "移出视口",
          });
        }
      }
    }
  });
  hidden.totalHidden = hiddenCount;
  hidden.textHiddenByCSS = textHiddenCount;
  hidden.suspiciousPatterns = suspiciousSelectors;
  if (hiddenCount > 20) hidden.suspiciousNote = "大量元素被 CSS 隐藏，可能用于蜜罐或反爬";
  results.hidden = hidden;

  // ── 5. 蜜罐（Honeypot）检测 ──
  const honeypot = { found: false, traps: [] };

  // Hidden form fields
  document.querySelectorAll("input[type=text], input:not([type]), textarea").forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" ||
        el.offsetHeight === 0 || el.offsetWidth === 0) {
      honeypot.found = true;
      honeypot.traps.push({
        type: "隐藏表单字段",
        name: el.name || el.id || "(未命名)",
        selector: getUniqueSelector(el),
      });
    }
  });
  // CSS-only hidden links
  document.querySelectorAll('a[href], area[href]').forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" && el.textContent.trim()) {
      honeypot.found = true;
      honeypot.traps.push({
        type: "隐藏链接",
        href: el.href?.slice(0, 100),
        selector: getUniqueSelector(el),
      });
    }
  });
  // Check for common honeypot field names
  const honeyNames = ["website", "url", "homepage", "name2", "email2", "message2", "hp", "honeypot"];
  document.querySelectorAll("input, textarea").forEach((el) => {
    const name = (el.name || el.id || "").toLowerCase();
    if (honeyNames.includes(name)) {
      honeypot.found = true;
      honeypot.traps.push({
        type: "常见蜜罐字段名",
        name: name,
        selector: getUniqueSelector(el),
      });
    }
  });
  results.honeypot = honeypot;

  // ── 6. WebDriver 检测 ──
  const webdriver = { detected: false, indicators: [] };
  try {
    if (navigator.webdriver) {
      webdriver.detected = true;
      webdriver.indicators.push("navigator.webdriver = true（表明是自动化浏览器）");
    }
    // Check for automation flags
    const wdChecks = [
      { prop: "__driver_evaluate", source: window },
      { prop: "__webdriver_evaluate", source: window },
      { prop: "__selenium_evaluate", source: window },
      { prop: "__fxdriver_evaluate", source: window },
      { prop: "__driver_unwrapped", source: window },
      { prop: "webdriver", source: navigator },
      { prop: "__webdriverFunc", source: window },
    ];
    wdChecks.forEach(({ prop, source }) => {
      if (prop in source) {
        webdriver.detected = true;
        webdriver.indicators.push(`检测到自动化标记: ${prop}`);
      }
    });
    // Check chrome.runtime (selenium uses this)
    if (window.chrome?.runtime?.id) {
      // Normal in real extensions, but notable
    }
  } catch (e) {
    // Access may be denied
  }
  results.webdriver = webdriver;

  // ── 7. 行为追踪 ──
  const behaviorTracking = { detected: false, events: [] };
  const trackedEvents = ["mousemove", "mousedown", "mouseup", "click", "scroll", "touchstart", "touchmove", "touchend", "keydown", "keyup"];
  const eventListeners = {};
  // We can't directly enumerate all event listeners from JS,
  // but we can check for specific patterns in script content
  scriptSrcs.forEach((src) => {
    const lower = src.toLowerCase();
    const foundEvents = trackedEvents.filter(e => lower.includes(e + "(") || lower.includes("'" + e + "'"));
    if (foundEvents.length > 0) {
      behaviorTracking.detected = true;
      foundEvents.forEach((ev) => {
        if (!eventListeners[ev]) eventListeners[ev] = 0;
        eventListeners[ev]++;
      });
    }
  });
  // Also check inline scripts
  document.querySelectorAll("script:not([src])").forEach((s) => {
    const code = s.textContent || "";
    trackedEvents.forEach((ev) => {
      if (code.includes("addEventListener('" + ev) || code.includes('addEventListener("' + ev)) {
        behaviorTracking.detected = true;
        if (!eventListeners[ev]) eventListeners[ev] = 0;
        eventListeners[ev]++;
      }
    });
  });
  behaviorTracking.events = Object.entries(eventListeners).map(([ev, count]) => `${ev}: ${count} 处`);
  results.behaviorTracking = behaviorTracking;

  // ── 8. 反爬 JS 库 ──
  const antiBotLibs = { detected: false, libraries: [] };
  const knownLibs = [
    { name: "DataDome", patterns: ["datadome", "dd.js"] },
    { name: "Shape Security / Human", patterns: ["shape", "humansecurity"] },
    { name: "PerimeterX / Human", patterns: ["perimeterx", "px.js", "px_captcha"] },
    { name: "ThreatMetrix", patterns: ["threatmetrix", "tmx"] },
    { name: "Arkose Labs", patterns: ["arkose", "funcaptcha"] },
    { name: "Akamai Web Application Protector", patterns: ["akamai", "akabot"] },
    { name: "Cloudflare JS Challenge", patterns: ["cdn-cgi/challenge-platform"] },
    { name: "Kasada", patterns: ["kasada", "kasad"] },
    { name: "Distil Networks", patterns: ["distil"] },
    { name: "Reblaze", patterns: ["reblaze"] },
    { name: "BotD / Fingerprint Pro", patterns: ["botd", "fingerprint-pro"] },
  ];
  knownLibs.forEach((lib) => {
    const found = lib.patterns.some(p => html.toLowerCase().includes(p));
    if (found) {
      antiBotLibs.detected = true;
      antiBotLibs.libraries.push(lib.name);
    }
  });
  results.antiBotLibraries = antiBotLibs;

  // ── 9. 限流信号 ──
  const rateLimit = { detected: false, signals: [] };
  const rlTexts = [
    "rate limit", "rate_limit", "too many requests", "429", "try again later",
    "请求过于频繁", "操作太频繁", "访问频率过高", "请稍后再试",
    "请求过多", "访问受限",
  ];
  const foundRl = rlTexts.filter(t => pageText.toLowerCase().includes(t));
  if (foundRl.length > 0) {
    rateLimit.detected = true;
    rateLimit.signals.push(`页面文本包含限流关键词: ${foundRl.join(", ")}`);
  }
  results.rateLimit = rateLimit;

  // ── 10. 内容加载方式 ──
  const contentLoading = { mode: "unknown", indicators: [] };

  // Check if page uses CSR (client-side rendering)
  const appRoot = document.querySelector("#root, #app, #__next, #__nuxt");
  if (appRoot && document.body.children.length <= 3 && pageText.length < 200) {
    contentLoading.mode = "CSR (客户端渲染) — 内容可能依赖 JS API 加载";
    contentLoading.indicators.push("页面只有少量初始 DOM，内容由 JS 动态加载");
  } else if (pageText.length > 1000) {
    contentLoading.mode = "SSR (服务端渲染) — 内容直接在 HTML 中";
  } else {
    contentLoading.mode = "不确定";
  }
  // Check for skeleton screens
  if (html.includes("skeleton") || html.includes("placeholder") || html.includes("loading-")) {
    contentLoading.indicators.push("检测到骨架屏/加载占位 — 内容延迟加载");
  }
  // Check for XHR/fetch-based content loading
  const xhrPatterns = /XMLHttpRequest|\bfetch\(|axios|ajax|\.load\(/gi;
  if (xhrPatterns.test(html)) {
    contentLoading.indicators.push("检测到 AJAX/Fetch 动态内容加载");
  }
  results.contentLoading = contentLoading;

  // ── 11. 内容混淆检测 ──
  const obfuscation = { detected: false, indicators: [] };
  // Unicode obfuscation (lookalike characters)
  const unicodeRanges = /[\u2028\u2029\u2000-\u200F\u2060-\u2064\uFFF0-\uFFFF]/g;
  if (unicodeRanges.test(pageText)) {
    obfuscation.detected = true;
    obfuscation.indicators.push("检测到 Unicode 零宽字符/特殊字符 — 可能用于反爬文本混淆");
  }
  // Font-based obfuscation (custom fonts that show different chars)
  const fontFaces = [];
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule instanceof CSSFontFaceRule) {
            const family = rule.style?.fontFamily;
            const src = rule.style?.src;
            if (family && src && !family.includes("system") && !family.includes("sans-serif")) {
              fontFaces.push({ family, src: src?.slice(0, 100) });
            }
          }
        }
      } catch (e) { /* cross-origin stylesheet */ }
    }
  } catch (e) { /* ignore */ }
  if (fontFaces.length > 3) {
    obfuscation.detected = true;
    obfuscation.indicators.push(`自定义字体 ${fontFaces.length} 个 — 可能用于 CSS 字体混淆`);
    obfuscation.fontFaces = fontFaces.slice(0, 10);
  }
  // Text encoded as base64/data in JS
  if ((pageText.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []).length > 5) {
    obfuscation.detected = true;
    obfuscation.indicators.push("检测到大量 base64 编码字符串 — 可能用于内容混淆");
  }
  results.obfuscation = obfuscation;

  // ── 12. CSP / 安全头 ──
  const security = { csp: null, hasFrameOptions: false, hasXssProtection: false };
  const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]');
  if (cspMeta) {
    security.csp = cspMeta.getAttribute("content")?.slice(0, 300) || null;
  }
  const xfoMeta = document.querySelector('meta[http-equiv*="x-frame-options"], meta[http-equiv*="X-Frame-Options"]');
  security.hasFrameOptions = !!xfoMeta;
  const xssMeta = document.querySelector('meta[http-equiv*="x-xss-protection"], meta[http-equiv*="X-XSS-Protection"]');
  security.hasXssProtection = !!xssMeta;
  results.security = security;

  // ── 13. 总结 ──
  const summary = [];
  if (captcha.found) summary.push(`⚠️ CAPTCHA: ${captcha.types.join(", ")}`);
  if (waf.detected) summary.push(`🛡️ WAF: ${waf.provider || "未知"} (${waf.indicators.length} 项证据)`);
  if (fingerprint.detected) summary.push(`🔍 浏览器指纹采集: ${fingerprint.scripts.join(", ")}`);
  if (hidden.suspiciousNote) summary.push(`👁️ ${hidden.suspiciousNote} (${hidden.totalHidden} 个隐藏元素)`);
  if (honeypot.found) summary.push(`🍯 蜜罐检测: ${honeypot.traps.length} 个疑似蜜罐`);
  if (webdriver.detected) summary.push(`🤖 navigator.webdriver 被检测到 — 自动化工具易被封`);
  if (behaviorTracking.detected) summary.push(`🖱️ 行为追踪: ${Object.keys(eventListeners).length} 种事件被监听`);
  if (antiBotLibs.detected) summary.push(`📦 反爬库: ${antiBotLibs.libraries.join(", ")}`);
  if (rateLimit.detected) summary.push(`🚦 限流信号: ${rateLimit.signals.length} 项`);
  if (obfuscation.detected) summary.push(`🔐 内容混淆: ${obfuscation.indicators.length} 项`);

  // ── 14. 调试时序分析（从 Performance API 获取） ──
  let debugTiming = null;
  try {
    const perfDebug = getDebugInfo();
    if (perfDebug.antiCrawlTiming?.length > 0) {
      debugTiming = perfDebug.antiCrawlTiming;
      perfDebug.antiCrawlTiming.forEach((t) => summary.push(t));
    }
    // Add resource failure insights
    if (perfDebug.resourceSummary?.blockedCount > 0) {
      results.debugBlockedResources = perfDebug.blockedResources?.slice(0, 10);
    }
    // Add CSP violations
    if (perfDebug.cspViolations?.length > 0) {
      results.debugCspViolations = perfDebug.cspViolations;
    }
    // Add JS errors
    if (perfDebug.jsErrors?.total > 0) {
      results.debugJsErrorCount = perfDebug.jsErrors.total;
      if (perfDebug.jsErrors.total > 3) {
        summary.push(`💥 ${perfDebug.jsErrors.total} 个 JS 运行时错误（可能为反爬脚本触发）`);
      }
    }
    results.debug = {
      navigation: perfDebug.navigation,
      resourceSummary: perfDebug.resourceSummary,
      network: perfDebug.network,
      antiCrawlTiming: perfDebug.antiCrawlTiming,
      jsErrorCount: perfDebug.jsErrors?.total || 0,
      blockedResourceCount: perfDebug.resourceSummary?.blockedCount || 0,
      cspViolationCount: perfDebug.cspViolations?.length || 0,
    };
  } catch (e) {
    // Debug info is best-effort
  }

  if (!webdriver.detected && !captcha.found && !waf.detected && !honeypot.found && !fingerprint.detected && !antiBotLibs.detected &&
      !debugTiming?.length) {
    summary.push("✅ 未发现明显的反爬/反自动化措施");
  }

  results.summary = summary;
  results.pageUrl = window.location.href;
  results.pageTitle = document.title;

  return results;
}

// ── Ad Detection & Filtering ──
const AD_KEYWORDS = ['ad', 'ads', 'advertisement', 'banner', 'sponsor', '推广', '广告', 'recommend', 'promote', 'google_ads', 'dfp-'];
const AD_SELECTORS = [
  '[class*="ad"]', '[id*="ad"]', '[class*="banner"]', '[id*="banner"]',
  '[class*="sponsor"]', '[class*="推广"]', '[id*="推广"]',
  '[class*="recommend"]', '[id*="recommend"]',
  'ins.adsbygoogle', 'div[data-ad-]', '.advertisement',
];

function detectAds() {
  const ads = [];
  // Check by selectors
  AD_SELECTORS.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      if (el.offsetHeight > 0 || el.offsetWidth > 0) {
        const rect = el.getBoundingClientRect();
        ads.push({
          type: 'selector', selector: sel,
          text: el.textContent?.trim().slice(0, 50) || '',
          position: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
          tag: el.tagName,
        });
      }
    });
  });
  // Check by keywords in classes/IDs
  document.querySelectorAll('*').forEach(el => {
    if (ads.length > 100) return;
    const id = el.id || '';
    const cls = el.className?.toString() || '';
    const combined = id + ' ' + cls;
    if (AD_KEYWORDS.some(k => combined.toLowerCase().includes(k))) {
      if (el.offsetHeight > 0 && !ads.some(a => a.element === el)) {
        const rect = el.getBoundingClientRect();
        ads.push({
          type: 'keyword', match: AD_KEYWORDS.find(k => combined.toLowerCase().includes(k)),
          text: el.textContent?.trim().slice(0, 50) || '',
          position: { top: Math.round(rect.top), left: Math.round(rect.left) },
          tag: el.tagName,
          element: el,
        });
      }
    }
  });
  return ads;
}

// Filter ad elements from text content
function filterAdsFromText(text, ads) {
  if (!ads?.length || !text) return text;
  let filtered = text;
  ads.forEach(ad => {
    if (ad.text && ad.text.length > 5) {
      filtered = filtered.replace(ad.text, '');
    }
  });
  return filtered;
}

// Filter ads from links
function filterAdsFromLinks(links, ads) {
  if (!ads?.length || !links?.length) return links;
  const adTexts = new Set(ads.map(a => a.text?.trim()).filter(Boolean));
  return links.filter(l => !adTexts.has(l.text?.trim()));
}

// Filter ads from images
function filterAdsFromImages(images, ads) {
  if (!ads?.length || !images?.length) return images;
  const adSelectors = new Set(ads.map(a => a.selector).filter(Boolean));
  // Also filter by position overlap
  return images.filter(img => {
    const imgPos = { top: img.position?.top || 0, left: img.position?.left || 0 };
    return !ads.some(ad => {
      const p = ad.position;
      return p && Math.abs(imgPos.top - p.top) < 50 && Math.abs(imgPos.left - p.left) < 50;
    });
  });
}

// ═══════════════════════════════════════════════
// Message Handler
// ═══════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source !== "background") return true;

  let result;
  switch (message.type) {
    case "scroll":
      result = scrollPage(message.direction, message.amount);
      break;
    case "click":
      result = clickElement(message.selector);
      break;
    case "type":
      result = typeText(message.selector, message.text);
      break;
    case "select":
      result = selectOption(message.selector, message.value);
      break;
    case "hover":
      result = hoverElement(message.selector);
      break;
    case "evaluate":
      try {
        const fn = new Function(message.code);
        const res = fn();
        result = { success: true, result: res !== undefined ? String(res).slice(0, 5000) : "undefined" };
      } catch (e) {
        result = { success: false, error: e.message };
      }
      break;
    case "get_element":
      result = getElementInfo(message.selector);
      break;
    case "get_selected_text":
      result = getSelectedText();
      break;
    case "highlight":
      result = highlightElement(message.selector, message.color);
      break;
    case "get_cookies":
      result = { success: true, cookies: getCookies() };
      break;
    case "get_storage":
      result = { success: true, storage: getStorage(message.type2 || "local") };
      break;
    case "get_tables":
      result = { success: true, tables: getTables() };
      break;
    case "get_forms":
      result = { success: true, forms: getForms() };
      break;
    case "get_all_data":
      result = getAllPageData();
      break;
    case "get_console_logs":
      result = { success: true, logs: capturedLogs.slice(-100) };
      break;
    case "get_errors":
      result = { success: true, errors: capturedErrors.slice(-50) };
      break;
    case "get_debug_info":
      result = { success: true, debug: getDebugInfo() };
      break;
    case "get_headings":
      result = { success: true, headings: getHeadings() };
      break;
    case "get_element_info":
      result = { success: true, images: getDetailedImages(), links: getLinks() };
      break;
    case "get_page_layout":
      result = (function() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const GRID_COLS = 80, GRID_ROWS = 40;
        const colW = vw / GRID_COLS, rowH = vh / GRID_ROWS;
        const elements = [];
        const seen = new Set();
        const selectors = ['a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
          '[role=button]', '[role=link]', '[role=tab]', 'h1','h2','h3','h4','h5','h6',
          'img[src]', 'p', 'li'];
        selectors.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;
            if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) return;
            const key = el.tagName + el.className + Math.round(rect.left) + Math.round(rect.top);
            if (seen.has(key)) return; seen.add(key);
            let text = el.tagName === 'IMG' ? (el.alt || '[img]') : (el.textContent?.trim().slice(0,50) || el.placeholder || '');
            if (!text) return;
            elements.push({
              tag: el.tagName.toLowerCase(), type: el.type || '', text,
              x: Math.round(rect.left/colW), y: Math.round(rect.top/rowH),
              w: Math.round(rect.width/colW), h: Math.round(rect.height/rowH),
              rect: {top:Math.round(rect.top),left:Math.round(rect.left),width:Math.round(rect.width),height:Math.round(rect.height)},
              href: el.href || '', value: el.value || '', required: el.required || false,
            });
          });
        });
        elements.sort((a,b) => a.y - b.y || a.x - b.x);
        elements.forEach((el,i) => el.ref = i + 1);
        return { success: true, elements, viewport: {width: vw, height: vh} };
      })();
      break;
    case "capture_now":
      result = getAllPageData();
      break;
    case "analyze_anti_crawl":
      result = { success: true, analysis: analyzeAntiCrawl() };
      break;
    default:
      result = { success: false, error: `未知命令: ${message.type}` };
  }

  sendResponse(result);
  return true;
});

// ═══════════════════════════════════════════════
// Initial data send
// ═══════════════════════════════════════════════

// Start console/error capture immediately
captureConsole();

function sendInitialPageData() {
  const data = getAllPageData();
  data.source = "content";
  data.type = "page_data";
  chrome.runtime.sendMessage(data).catch(() => {});
}

if (document.readyState === "complete") {
  setTimeout(sendInitialPageData, 1500);
} else {
  window.addEventListener("load", () => setTimeout(sendInitialPageData, 1500));
}

})(); // end IIFE
