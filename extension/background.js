// ── Chrome MCP Browser — Background Service Worker ──
// 隐身模式：不注入 content script，通过 chrome.debugger (CDP) 工作

// ══════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════

let ws = null;
let reconnectTimer = null;
let wsUrl = "ws://localhost:9134";
let activeTabId = null;
let debuggerAttached = false;
let debuggerReady = false;
let networkMonitoring = false;
let heartbeatTimer = null;

// CDP Network log buffer
const networkLog = [];
const MAX_NETWORK_LOG = 1000;
let responseBodies = new Map(); // requestId -> body text
let pendingResponseBodies = new Set(); // requestIds waiting for body fetch

// Tab page cache (from CDP Runtime.evaluate or optional content script)
let pageCache = null;

// ══════════════════════════════════════════════════════════
// chrome.debugger (CDP) Management
// ══════════════════════════════════════════════════════════

async function attachDebugger(tabId) {
  if (debuggerAttached) return true;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttached = true;
    debuggerReady = false;
    return true;
  } catch (err) {
    return false;
  }
}

async function detachDebugger() {
  if (!debuggerAttached || !activeTabId) return;
  try {
    await chrome.debugger.detach({ tabId: activeTabId });
  } catch (e) { /* ignore */ }
  debuggerAttached = false;
  debuggerReady = false;
  networkMonitoring = false;
}

async function enableDomains() {
  if (!debuggerAttached || !activeTabId || debuggerReady) return;
  try {
    await cdpSend("Network.enable", {});
    await cdpSend("Runtime.enable", {});
    await cdpSend("DOM.enable", {});
    debuggerReady = true;
  } catch (err) {
    // 静默忽略
  }
}

async function cdpSend(method, params = {}) {
  if (!debuggerAttached || !activeTabId) {
    throw new Error("Debugger not attached");
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: activeTabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// CDP event handler
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || source.tabId !== activeTabId) return;

  switch (method) {
    // ── Network events ──
    case "Network.requestWillBeSent": {
      const entry = {
        requestId: params.requestId,
        type: params.type || "other",
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData?.slice(0, 5000) || null,
        timestamp: params.timestamp,
        wallTime: params.wallTime,
        initiator: params.initiator?.type || "other",
        redirectSource: params.redirectResponse ? true : false,
        response: null,
        responseBody: null,
      };

      // Handle redirects
      if (params.redirectResponse) {
        const existing = networkLog.find(e => e.requestId === params.requestId);
        if (existing) {
          existing.redirectResponse = {
            status: params.redirectResponse.status,
            statusText: params.redirectResponse.statusText,
            headers: params.redirectResponse.headers,
            headersText: params.redirectResponse.headersText,
          };
        }
      }

      networkLog.push(entry);
      if (networkLog.length > MAX_NETWORK_LOG) networkLog.shift();
      break;
    }

    case "Network.responseReceived": {
      const entry = networkLog.find(e => e.requestId === params.requestId);
      if (entry) {
        entry.response = {
          status: params.response.status,
          statusText: params.response.statusText,
          headers: params.response.headers,
          mimeType: params.response.mimeType,
          fromDiskCache: params.response.fromDiskCache,
          fromServiceWorker: params.response.fromServiceWorker,
          protocol: params.response.protocol,
          securityState: params.response.securityState,
          remoteIPAddress: params.response.remoteIPAddress,
          remotePort: params.response.remotePort,
          timing: params.response.timing,
          responseTime: params.response.responseTime,
          // Extract Set-Cookie from response headers
          setCookies: extractSetCookies(params.response.headers),
          // Look for auth tokens in headers
          authHeaders: extractAuthHeaders(params.request?.headers, params.response.headers),
        };
        // Mark for body fetch
        pendingResponseBodies.add(params.requestId);
      }
      break;
    }

    case "Network.loadingFinished": {
      // Fetch response body for interesting requests
      const entry = networkLog.find(e => e.requestId === params.requestId);
      if (entry && pendingResponseBodies.has(params.requestId)) {
        pendingResponseBodies.delete(params.requestId);
        // Only fetch bodies for certain types (JSON, text, HTML)
        const mime = entry.response?.mimeType || "";
        if (mime.includes("json") || mime.includes("text") || mime.includes("javascript") || mime.includes("html")) {
          fetchResponseBody(params.requestId, entry);
        }
      }
      break;
    }

    case "Network.loadingFailed": {
      const entry = networkLog.find(e => e.requestId === params.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = params.errorText;
        entry.blockedReason = params.blockedReason || null;
        entry.corsError = params.corsErrorStatus || null;
      }
      break;
    }

    // ── Runtime events ──
    case "Runtime.consoleAPICalled": {
      // Capture console logs stealthily via CDP
      break;
    }

    case "Runtime.exceptionThrown": {
      // Capture JS errors stealthily
      break;
    }
  }
});

// Fetch response body for a specific request
async function fetchResponseBody(requestId, entry) {
  try {
    const result = await cdpSend("Network.getResponseBody", { requestId });
    if (result) {
      const body = result.body || "";
      entry.responseBody = body.slice(0, 50000);
      entry.responseBodyBase64 = result.base64Encoded || false;
    }
  } catch (e) {
    // Body may not be available (already consumed, etc.)
  }
}

function extractSetCookies(headers) {
  const cookies = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === "set-cookie") {
      cookies.push(value);
    }
  }
  return cookies;
}

function extractAuthHeaders(reqHeaders, resHeaders) {
  const sensitive = [];
  const patterns = ["token", "auth", "jwt", "bearer", "apikey", "api_key", "x-csrf", "x-xsrf",
    "session", "authorization", "x-requested-with", "x-forwarded", "x-real-ip",
    "set-cookie", "refresh-token", "access-token", "x-access-token"];

  for (const headers of [reqHeaders, resHeaders]) {
    if (!headers) continue;
    for (const [key, value] of Object.entries(headers)) {
      const kl = key.toLowerCase();
      if (patterns.some(p => kl.includes(p))) {
        sensitive.push({
          key,
          value: value?.slice(0, 200) || "",
          source: headers === reqHeaders ? "request" : "response",
        });
      }
    }
  }
  return sensitive;
}

// ══════════════════════════════════════════════════════════
// Network Monitoring Control
// ══════════════════════════════════════════════════════════

async function startNetworkMonitoring() {
  if (networkMonitoring) return true;
  if (!debuggerReady) {
    if (!await attachDebugger(activeTabId)) return false;
    await enableDomains();
  }
  networkMonitoring = true;
  // Already enabled via Network.enable
  return true;
}

function stopNetworkMonitoring() {
  networkMonitoring = false;
}

async function getAllCookies() {
  if (!debuggerReady) throw new Error("Debugger not ready");
  const result = await cdpSend("Network.getAllCookies");
  return (result.cookies || []).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    expires: c.expires ? new Date(c.expires * 1000).toISOString() : null,
    priority: c.priority,
  }));
}

async function clearBrowserCookies() {
  if (!debuggerReady) throw new Error("Debugger not ready");
  await cdpSend("Network.clearBrowserCookies");
}

async function executeJS(code) {
  if (!debuggerReady) throw new Error("Debugger not ready");
  const result = await cdpSend("Runtime.evaluate", {
    expression: code,
    returnByValue: true,
    awaitPromise: true,
    maxValueRetention: 5000,
  });
  if (result.exceptionDetails) {
    return { success: false, error: result.exceptionDetails.text, exception: result.exceptionDetails };
  }
  return { success: true, result: result.result?.value };
}

async function getDOMSnapshot() {
  if (!debuggerReady) throw new Error("Debugger not ready");
  // Get document title and URL via Runtime
  const titleRes = await executeJS("document.title");
  const urlRes = await executeJS("window.location.href");
  const textRes = await executeJS("document.body?.innerText?.slice(0,50000) || ''");
  const htmlRes = await executeJS("document.documentElement?.outerHTML?.slice(0,30000) || ''");
  const linksRes = await executeJS(`
    JSON.stringify(Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a => ({
      text: a.textContent.trim().slice(0,200),
      href: a.href
    })))
  `);
  const imgsRes = await executeJS(`
    JSON.stringify(Array.from(document.querySelectorAll('img[src]')).slice(0,100).map(img => ({
      src: img.src,
      alt: img.alt || '',
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height
    })))
  `);

  let links = [], images = [];
  try { if (linksRes.success) links = JSON.parse(linksRes.result); } catch(e) {}
  try { if (imgsRes.success) images = JSON.parse(imgsRes.result); } catch(e) {}

  const snapshot = {
    title: titleRes.success ? titleRes.result : "",
    url: urlRes.success ? urlRes.result : "",
    text: textRes.success ? textRes.result : "",
    html: htmlRes.success ? htmlRes.result : "",
    links,
    images,
  };

  // Update cache
  pageCache = {
    title: snapshot.title,
    url: snapshot.url,
    text: snapshot.text,
    links: snapshot.links,
    images: snapshot.images,
    capturedAt: Date.now(),
  };

  return snapshot;
}

// ══════════════════════════════════════════════════════════
// Anti-Crawl Analysis via CDP
// ══════════════════════════════════════════════════════════

async function analyzeAntiCrawlViaCDP() {
  const analysis = { networkAnalysis: [], cookies: [], authTokens: [] };

  // Get all cookies
  try {
    const cookies = await getAllCookies();
    analysis.cookies = cookies;
    // Flag suspicious cookies
    const flagCookies = cookies.filter(c =>
      c.name.toLowerCase().includes("token") ||
      c.name.toLowerCase().includes("auth") ||
      c.name.toLowerCase().includes("session") ||
      c.name.toLowerCase().includes("jwt") ||
      c.name.toLowerCase().includes("sid")
    );
    if (flagCookies.length > 0) {
      analysis.authTokens.push(...flagCookies.map(c => ({
        source: "cookie",
        name: c.name,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })));
    }
  } catch (e) { /* */ }

  // Analyze network log for anti-crawling patterns
  const recentRequests = networkLog.slice(-200);
  const blockedOrFailed = recentRequests.filter(r => r.failed || r.response?.status >= 400);
  const redirects = recentRequests.filter(r => r.redirectResponse);
  const authRequests = recentRequests.filter(r => (r.authHeaders?.length || 0) > 0);
  const wafPatterns = recentRequests.filter(r =>
    r.url.includes("challenge") || r.url.includes("captcha") ||
    r.url.includes("verify") || r.url.includes("human") ||
    r.response?.status === 403 || r.response?.status === 429
  );

  analysis.networkAnalysis = {
    totalRequests: recentRequests.length,
    blocked: blockedOrFailed.length,
    redirects: redirects.length,
    authRequests: authRequests.length,
    wafRelated: wafPatterns.length,
    statusCodes: {},
  };

  // Summarize status codes
  recentRequests.forEach(r => {
    const status = r.response?.status || 0;
    analysis.networkAnalysis.statusCodes[status] = (analysis.networkAnalysis.statusCodes[status] || 0) + 1;
  });

  // Extract auth tokens from recent request/response headers
  recentRequests.forEach(r => {
    if (r.authHeaders?.length) {
      r.authHeaders.forEach(h => {
        const exists = analysis.authTokens.find(t => t.key === h.key);
        if (!exists) {
          analysis.authTokens.push({
            source: h.source === "request" ? "请求头" : "响应头",
            key: h.key,
            value: h.value?.length > 50 ? h.value.slice(0, 20) + "..." : h.value,
            url: r.url.slice(0, 150),
          });
        }
      });
    }
    // Look for tokens in response bodies
    if (r.responseBody && (r.response.headers?.["content-type"]?.includes("json") || r.url.includes("api"))) {
      const body = r.responseBody;
      const tokenPatterns = [
        /"token"\s*:\s*"([^"]+)"/,
        /"access_token"\s*:\s*"([^"]+)"/,
        /"refresh_token"\s*:\s*"([^"]+)"/,
        /"jwt"\s*:\s*"([^"]+)"/,
        /"session_id"\s*:\s*"([^"]+)"/,
        /"api_key"\s*:\s*"([^"]+)"/,
        /"auth"\s*:\s*"([^"]+)"/,
        /"code"\s*:\s*"([A-Za-z0-9_-]{20,})"/,
      ];
      for (const pat of tokenPatterns) {
        const match = body.match(pat);
        if (match) {
          analysis.authTokens.push({
            source: "响应体",
            key: match[0].split(":")[0]?.replace(/["\\]/g, "") || "token",
            value: match[1].slice(0, 30) + "...",
            url: r.url.slice(0, 150),
          });
          break;
        }
      }
    }
  });

  return analysis;
}

// ══════════════════════════════════════════════════════════
// WebSocket Client
// ══════════════════════════════════════════════════════════

function connectWebSocket() {
  if (ws) try { ws.close(); } catch(e) {}
  ws = new WebSocket("ws://127.0.0.1:9134");
  ws.onopen = () => {
    notifyPanel({ type: "connection_status", connected: true });
    // 定时心跳，防止 Service Worker 休眠
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "hb" }));
      else clearInterval(heartbeatTimer);
    }, 15000);
    const tryAttach = (tabId) => {
      if (!tabId) return;
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) return;
        attachDebugger(tabId).then(ok => {
          if (ok) {
            enableDomains();
            setTimeout(() => {
              handleServerMessage({ type: "capture_now", msgId: "auto_" + Date.now() });
            }, 1000);
          }
        });
      });
    };
    if (activeTabId) tryAttach(activeTabId);
    else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs?.[0]) { activeTabId = tabs[0].id; tryAttach(activeTabId); }
      });
    }
  };
  ws.onclose = (e) => {
    notifyPanel({ type: "connection_status", connected: false });
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    ws = null;
    setTimeout(connectWebSocket, 1000); // 1秒快速重连
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try { handleServerMessage(JSON.parse(e.data)); } catch (err) {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 3000);
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function notifyPanel(data) {
  chrome.runtime.sendMessage({ source: "background", ...data }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// Server Message Handler
// ══════════════════════════════════════════════════════════

async function handleServerMessage(msg) {
  const msgId = msg.msgId;
  let result;

  try {
    switch (msg.type) {
      // ── Ping ──
      case "ping":
        sendToServer({ type: "pong", msgId });
        return;

      // ── Debugger Management ──
      case "attach_debugger":
        result = await attachDebugger(activeTabId);
        if (result) await enableDomains();
        sendToServer({ success: result, debuggerAttached, debuggerReady, msgId });
        return;

      case "detach_debugger":
        await detachDebugger();
        sendToServer({ success: true, msgId });
        return;

      // ── Network Monitoring ──
      case "start_network_monitor":
        result = await startNetworkMonitoring();
        sendToServer({ success: result, msgId });
        return;

      case "stop_network_monitor":
        stopNetworkMonitoring();
        sendToServer({ success: true, msgId });
        return;

      case "get_network_log": {
        const count = msg.count || 100;
        const filterStatus = msg.filterStatus; // optional: filter by status code
        const logs = networkLog.slice(-count);
        const filtered = filterStatus
          ? logs.filter(r => r.response?.status === filterStatus)
          : logs;
        // Trim large bodies
        const trimmed = filtered.map(r => ({
          ...r,
          responseBody: r.responseBody?.slice(0, 5000) || null,
        }));
        sendToServer({ success: true, count: trimmed.length, total: networkLog.length, logs: trimmed, msgId });
        return;
      }

      case "clear_network_log":
        networkLog.length = 0;
        responseBodies.clear();
        sendToServer({ success: true, msgId });
        return;

      // ── Cookie Operations ──
      case "get_all_cookies":
        try {
          const cookies = await getAllCookies();
          sendToServer({ success: true, cookies, count: cookies.length, msgId });
        } catch (e) {
          sendToServer({ success: false, error: e.message, msgId });
        }
        return;

      case "clear_cookies":
        try {
          await clearBrowserCookies();
          sendToServer({ success: true, msgId });
        } catch (e) {
          sendToServer({ success: false, error: e.message, msgId });
        }
        return;

      // ── JS Execution (stealth via CDP) ──
      case "execute":
        try {
          const res = await executeJS(msg.code);
          sendToServer({ ...res, msgId });
        } catch (e) {
          sendToServer({ success: false, error: e.message, msgId });
        }
        return;

      // ── DOM Snapshot ──
      case "get_dom_snapshot":
        try {
          const snap = await getDOMSnapshot();
          sendToServer({ success: true, ...snap, msgId });
        } catch (e) {
          sendToServer({ success: false, error: e.message, msgId });
        }
        return;

      // ── Anti-Crawl Deep Analysis ──
      case "analyze_anti_crawl_deep":
        try {
          const analysis = await analyzeAntiCrawlViaCDP();
          // Also get DOM snapshot for page info
          let domInfo = {};
          try {
            const title = await executeJS("document.title");
            const url = await executeJS("window.location.href");
            domInfo = { title: title.result, url: url.result };
          } catch (e) {}
          sendToServer({
            success: true,
            analysis: { ...analysis, pageTitle: domInfo.title, pageUrl: domInfo.url },
            msgId,
          });
        } catch (e) {
          sendToServer({ success: false, error: e.message, msgId });
        }
        return;

      // ── Page Capture ──
      case "capture_now":
      case "get_all_data": {
        // 优先用 CDP，如果 debugger 未就绪则注入 content script
        if (debuggerReady) {
          try {
            const snap = await getDOMSnapshot();
            const data = {
              type: "page_update",
              url: snap.url, title: snap.title, text: snap.text,
              links: snap.links, images: snap.images,
              capturedAt: Date.now(), stealth: true,
            };
            pageCache = data;
            sendToServer({ ...data, msgId });
            notifyPanel({ type: "page_captured", title: snap.title, url: snap.url, links: snap.links, images: snap.images, text: snap.text });
            return;
          } catch (e) { /* fall through to content script */ }
        }
        // 回退：注入 content script 获取页面数据
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ["content.js"],
          });
          await new Promise(r => setTimeout(r, 500));
          const res = await chrome.tabs.sendMessage(activeTabId, {
            source: "background", type: "get_all_data"
          });
          if (res) {
            const data = {
              type: "page_update", url: res.url, title: res.title,
              text: res.text, links: res.links, images: res.images,
              tables: res.tables, forms: res.forms, headings: res.headings,
              meta: res.meta, pageInfo: res.pageInfo,
              capturedAt: Date.now(),
            };
            pageCache = data;
            sendToServer(data);
            notifyPanel({ type: "page_captured", title: res.title, url: res.url, links: res.links, images: res.images, text: res.text, tables: res.tables, forms: res.forms });
            return;
          }
        } catch (e) {
          sendToServer({ error: `无法获取页面数据: ${e.message}`, msgId });
        }
        return;
      }

      // ── Tab Commands ──
      case "navigate":
        if (!activeTabId) { sendToServer({ error: "无活动标签页", msgId }); return; }
        await chrome.tabs.update(activeTabId, { url: msg.url });
        sendToServer({ success: true, msgId });
        // 等页面加载后自动捕获
        setTimeout(() => {
          const listener = (tabId, info) => {
            if (tabId === activeTabId && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(() => {
                handleServerMessage({ type: "capture_now", msgId: "nav_auto_" + Date.now() });
              }, 1500);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 15000);
        }, 500);
        return;

      case "list_tabs": {
        const tabs = await chrome.tabs.query({});
        sendToServer({
          success: true,
          tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, pinned: t.pinned })),
          activeTabId,
          msgId,
        });
        return;
      }

      case "switch_tab":
        await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update((await chrome.tabs.get(msg.tabId)).windowId, { focused: true });
        activeTabId = msg.tabId;
        // Re-attach debugger to new tab
        await detachDebugger();
        await attachDebugger(activeTabId);
        await enableDomains();
        sendToServer({ success: true, msgId });
        return;

      case "close_tab": {
        const id = msg.tabId || activeTabId;
        if (id) await chrome.tabs.remove(id);
        sendToServer({ success: true, msgId });
        return;
      }

      case "new_tab": {
        const tab = await chrome.tabs.create({ url: msg.url || "about:blank", active: true });
        activeTabId = tab.id;
        await detachDebugger();
        await attachDebugger(activeTabId);
        await enableDomains();
        sendToServer({ success: true, tabId: tab.id, msgId });
        return;
      }

      case "reload":
        if (activeTabId) await chrome.tabs.reload(activeTabId);
        sendToServer({ success: true, msgId });
        return;

      case "go_back":
        if (activeTabId) await chrome.tabs.goBack(activeTabId);
        sendToServer({ success: true, msgId });
        return;

      case "go_forward":
        if (activeTabId) await chrome.tabs.goForward(activeTabId);
        sendToServer({ success: true, msgId });
        return;

      case "screenshot": {
        if (!activeTabId) { sendToServer({ error: "无活动标签页", msgId }); return; }
        const dataUrl = await chrome.tabs.captureVisibleTab(
          (await chrome.tabs.get(activeTabId)).windowId, { format: "png" }
        );
        sendToServer({ success: true, dataUrl, msgId });
        return;
      }

      // ── Connection Status ──
      case "check_connection":
        sendToServer({
          connected: ws?.readyState === WebSocket.OPEN,
          debuggerAttached,
          debuggerReady,
          networkMonitoring,
          activeTabId,
          networkLogCount: networkLog.length,
          msgId,
        });
        return;

      // ── Legacy content script commands (on-demand inject if needed) ──
      case "scroll":
      case "click":
      case "type":
      case "select":
      case "hover":
      case "highlight":
      case "get_element":
      case "get_selected_text":
      case "get_cookies":
      case "get_storage":
      case "get_tables":
      case "get_forms":
      case "get_console_logs":
      case "get_errors":
      case "get_debug_info":
      case "get_headings":
      case "get_element_info":
      case "get_page_layout":
      case "analyze_anti_crawl": {
        // These require content script - inject on demand
        const res = await injectAndSend(msg);
        sendToServer({ ...res, msgId });
        return;
      }

      default:
        sendToServer({ error: `未知命令: ${msg.type}`, msgId });
    }
  } catch (err) {
    sendToServer({ error: err.message, msgId });
  }
}

// On-demand content script injection (only when needed)
async function injectAndSend(msg) {
  if (!activeTabId) return { error: "无活动标签页" };
  try {
    // Inject content script on demand
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"],
    });
    await new Promise(r => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(activeTabId, { source: "background", ...msg });
  } catch (err) {
    return { error: `注入内容脚本失败: ${err.message}` };
  }
}

// ══════════════════════════════════════════════════════════
// Tab Tracking
// ══════════════════════════════════════════════════════════

chrome.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
  notifyPanel({ type: "connection_status", connected: ws?.readyState === WebSocket.OPEN });
  // Auto-attach debugger
  if (ws?.readyState === WebSocket.OPEN) {
    attachDebugger(activeTabId).then(ok => { if (ok) enableDomains(); });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === "complete") {
    // Page reloaded - re-enable domains and re-monitor
    if (debuggerAttached) {
      enableDomains();
    }
  }
});

// Debugger detach event (e.g., user closes devtools)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === activeTabId) {
    debuggerAttached = false;
    debuggerReady = false;
    networkMonitoring = false;
    console.log("[CDP] Detached by browser");
  }
});

// ══════════════════════════════════════════════════════════
// Panel Messages
// ══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source === "panel") {
    switch (message.type) {
      case "connect":
        wsUrl = message.wsUrl || wsUrl;
        connectWebSocket();
        sendResponse({ success: true });
        break;
      case "disconnect":
        detachDebugger();
        if (ws) { ws.close(); ws = null; }
        sendResponse({ success: true });
        break;
      case "get_status":
        sendResponse({ connected: ws?.readyState === WebSocket.OPEN, activeTabId, debuggerAttached, networkLogCount: networkLog.length });
        break;
      case "refresh":
        if (activeTabId) {
          handleServerMessage({ type: "capture_now", msgId: "panel_refresh_" + Date.now() });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "No active tab" });
        }
        break;
    }
    return true;
  }
  return false;
});

// ══════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// 自动连接 WebSocket，静默重试
// 先获取当前活动标签页
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs?.[0]) activeTabId = tabs[0].id;
});
connectWebSocket();
