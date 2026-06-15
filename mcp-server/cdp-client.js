// ── Direct CDP Client ──
// Connects to Chrome's remote debugging port directly,
// bypassing the Chrome extension for data operations.

import WebSocket from "ws";
import http from "http";

export class CdpClient {
  constructor(port = 9222) {
    this.port = port;
    this.ws = null;
    this.connected = false;
    this.msgId = 1;
    this.pending = new Map(); // msgId -> { resolve, reject, timeout }
    this.tabId = null; // Target tab ID
  }

  // Discover the browser WebSocket URL
  async _getBrowserWS() {
    const url = `http://127.0.0.1:${this.port}/json/version`;
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.webSocketDebuggerUrl);
          } catch (e) {
            reject(new Error(`解析 CDP 版本信息失败: ${e.message}`));
          }
        });
      }).on("error", (e) => reject(new Error(`无法连接 Chrome CDP 端口 ${this.port}: ${e.message}`)));
    });
  }

  // Get list of all tabs
  async _getTabs() {
    const url = `http://127.0.0.1:${this.port}/json`;
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`解析标签页列表失败: ${e.message}`));
          }
        });
      }).on("error", reject);
    });
  }

  // Connect to Chrome's browser-level WebSocket
  async connect() {
    const wsUrl = await this._getBrowserWS();
    console.error(`[CDP] 正在连接 Chrome: ${wsUrl}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.connected = true;
        console.error("[CDP] ✅ 已连接到 Chrome CDP");
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject, timeout } = this.pending.get(msg.id);
            clearTimeout(timeout);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
          // Handle events (ignored for now)
        } catch (e) {
          console.error("[CDP] 消息解析错误:", e.message);
        }
      });

      this.ws.on("close", () => {
        this.connected = false;
        console.error("[CDP] ❌ 与 Chrome 的连接已断开");
        // Clear all pending
        for (const [id, { reject, timeout }] of this.pending) {
          clearTimeout(timeout);
          reject(new Error("CDP 连接已断开"));
        }
        this.pending.clear();
      });

      this.ws.on("error", (err) => {
        console.error("[CDP] WebSocket 错误:", err.message);
        if (!this.connected) reject(err);
      });

      // Timeout
      setTimeout(() => {
        if (!this.connected) reject(new Error("连接 Chrome CDP 超时（15秒）"));
      }, 15000);
    });
  }

  // Send CDP command and wait for result
  async send(method, params = {}, sessionId = null) {
    if (!this.connected || !this.ws) {
      throw new Error("CDP 未连接");
    }
    const id = this.msgId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(msg));
    });
  }

  // Attach to first available page target and enable domains
  async attachToPage() {
    let tabs = await this._getTabs();
    // Find first non-blank page
    let page = tabs.find((t) => t.type === "page" && t.url && !t.url.startsWith("chrome") && !t.url.startsWith("devtools"));

    // If no page found, create one
    if (!page) {
      console.error("[CDP] 无标签页，正在创建...");
      const result = await this.send("Target.createTarget", {
        url: "about:blank",
      });
      page = { id: result.targetId, title: "blank", url: "about:blank" };
      // Re-fetch tabs to get proper list
      tabs = await this._getTabs();
      page = tabs.find((t) => t.type === "page") || page;
    }

    this.tabId = page.id;
    console.error(`[CDP] 已附加到页面: ${page.title} (${page.url?.slice(0, 80)})`);

    // Use Target.attachToTarget to attach to the page
    const result = await this.send("Target.attachToTarget", {
      targetId: this.tabId,
      flatten: true,
    });
    this.sessionId = result.sessionId;

    // Enable domains
    await this.send("Network.enable", {}, this.sessionId);
    await this.send("Runtime.enable", {}, this.sessionId);
    await this.send("DOM.enable", {}, this.sessionId);
    console.error("[CDP] 网络/Runtime/DOM 域已启用");
  }

  // Send command to page session
  async sendToPage(method, params = {}) {
    if (!this.sessionId) {
      throw new Error("CDP 未附加到页面");
    }
    return this.send(method, params, this.sessionId);
  }

  // Evaluate JS in page context
  async evaluate(expression) {
    const result = await this.sendToPage("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      maxValueRetention: 5000,
    });
    if (result.exceptionDetails) {
      return { success: false, error: result.exceptionDetails.text };
    }
    return { success: true, result: result.result?.value };
  }

  // Get all cookies (try browser level first, fall back to page level)
  async getAllCookies() {
    let result;
    try {
      result = await this.send("Network.getAllCookies");
    } catch (e) {
      // Fall back to page-level cookie retrieval
      try {
        result = await this.sendToPage("Network.getAllCookies");
      } catch (e2) {
        // Last resort: get cookies via JS
        const jsResult = await this.evaluate(
          `JSON.stringify(document.cookie.split(';').filter(Boolean).map(c => {const [n,...v]=c.trim().split('=');return{name:n,value:v.join('='),domain:location.hostname,path:'/',httpOnly:false,secure:false,session:true}}))`
        );
        if (jsResult.success) return JSON.parse(jsResult.result);
        throw e2;
      }
    }
    return (result.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
    }));
  }

  // Get DOM snapshot
  async getDOMSnapshot() {
    const title = await this.evaluate("document.title");
    const url = await this.evaluate("window.location.href");
    const text = await this.evaluate("document.body?.innerText?.slice(0, 50000) || ''");
    const linksRes = await this.evaluate(
      `JSON.stringify(Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a => ({text: a.textContent.trim().slice(0,200), href: a.href})))`
    );
    const imgsRes = await this.evaluate(
      `JSON.stringify(Array.from(document.querySelectorAll('img[src]')).slice(0,100).map(img => ({src: img.src, alt: img.alt || '', width: img.naturalWidth || img.width, height: img.naturalHeight || img.height})))`
    );
    let links = [], images = [];
    try { if (linksRes.success) links = JSON.parse(linksRes.result); } catch (e) {}
    try { if (imgsRes.success) images = JSON.parse(imgsRes.result); } catch (e) {}
    return {
      title: title.success ? title.result : "",
      url: url.success ? url.result : "",
      text: text.success ? text.result : "",
      links,
      images,
    };
  }

  // Disconnect
  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.connected = false;
  }
}
