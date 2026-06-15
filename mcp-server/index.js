import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import { CdpClient } from "./cdp-client.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

// ══════════════════════════════════════════════════════════
// Data Persistence (when --data-dir is set)
// ══════════════════════════════════════════════════════════

function ensureDataDir() {
  if (!DATA_DIR) return false;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error(`[Data] 无法创建数据目录 ${DATA_DIR}: ${e.message}`);
    return false;
  }
}

function saveData(name, data) {
  if (!DATA_DIR || !ensureDataDir()) return;
  try {
    writeFileSync(join(DATA_DIR, name + ".json"), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`[Data] 保存 ${name} 失败: ${e.message}`);
  }
}

function loadData(name) {
  if (!DATA_DIR) return null;
  const file = join(DATA_DIR, name + ".json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════
// Mode Detection
// ══════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const CDP_MODE = args.includes("--cdp");
const CDP_PORT = (() => {
  const idx = args.indexOf("--cdp-port");
  return idx >= 0 && idx < args.length - 1 ? parseInt(args[idx + 1]) : 9222;
})();
const DATA_DIR = (() => {
  const idx = args.indexOf("--data-dir");
  if (idx >= 0 && idx < args.length - 1) return args[idx + 1];
  return null; // 不指定则不持久化
})();

let cdp = null; // CDP direct client (used in --cdp mode)

// ══════════════════════════════════════════════════════════
// Transport: WebSocket Server (extension mode) or CDP Direct
// ══════════════════════════════════════════════════════════

const WS_PORT = 9134;
let pageCache = null;
let wss = null; // Only used in non-CDP mode

if (CDP_MODE) {
  console.error(`[Chrome-MCP] 🎯 CDP 直连模式，连接 Chrome 调试端口 ${CDP_PORT}`);
} else {
  wss = new WebSocketServer({ port: WS_PORT });
  console.error(`[Chrome-MCP] WebSocket 服务已启动: ws://localhost:${WS_PORT}`);

  wss.on("connection", (ws) => {
    console.error("[Chrome-MCP] Chrome 扩展已连接");
    
    // 心跳保活：每 25 秒发送 ping
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clearInterval(pingInterval);
      }
    }, 25000);
    
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "page_update") {
          pageCache = {
            title: msg.title || "",
            url: msg.url || "",
            text: msg.text || "",
            article: msg.article || "",
            html: msg.html || "",
            links: msg.links || [],
            images: msg.images || [],
            bgImages: msg.bgImages || [],
            meta: msg.meta || {},
            tables: msg.tables || [],
            forms: msg.forms || [],
            headings: msg.headings || [],
            cookies: msg.cookies || [],
            pageInfo: msg.pageInfo || {},
            capturedAt: Date.now(),
          };
          saveData("page_cache", pageCache);
        }
      } catch (e) {
        console.error("[Chrome-MCP] Parse error:", e.message);
      }
    });
    ws.on("close", (code, reason) => console.error("[Chrome-MCP] Chrome 扩展已断开 code=" + code + " reason=" + reason));
    ws.on("error", (e) => console.error("[Chrome-MCP] WS error:", e.message));
  });
}

// Univeral command dispatcher: extension bridge or CDP direct
async function sendToExtension(command) {
  if (CDP_MODE) {
    return await cdpDispatch(command);
  }

  // Original WebSocket bridge mode
  return new Promise((resolve, reject) => {
    const clients = [...(wss?.clients || [])];
    if (clients.length === 0) {
      resolve({ error: "⚠️ 扩展未连接（自动重连中，请稍候）" });
      return;
    }
    const ws = clients[0];
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket 未就绪"));
      return;
    }
    const msgId = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    const payload = { ...command, msgId };
    const timeout = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error("⏱ 等待扩展响应超时（15秒）"));
    }, 15000);
    const handler = (raw) => {
      try {
        const resp = JSON.parse(raw.toString());
        if (resp.msgId === msgId) {
          clearTimeout(timeout);
          ws.removeListener("message", handler);
          if (resp.error) reject(new Error(resp.error));
          else resolve(resp);
        }
      } catch { /* skip */ }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify(payload));
  });
}

// CDP direct dispatch
async function cdpDispatch(command) {
  if (!cdp?.connected) {
    throw new Error("CDP 未连接到 Chrome。请确认 Chrome 已开启远程调试端口（--remote-debugging-port=9222）");
  }

  switch (command.type) {
    case "get_all_data":
    case "capture_now": {
      const snap = await cdp.getDOMSnapshot();
      pageCache = { title: snap.title, url: snap.url, text: snap.text, links: snap.links, images: snap.images, capturedAt: Date.now() };
      return { ...snap };
    }
    case "get_dom_snapshot": {
      const snap = await cdp.getDOMSnapshot();
      return { success: true, ...snap };
    }
    case "get_all_cookies": {
      const cookies = await cdp.getAllCookies();
      return { success: true, cookies, count: cookies.length };
    }
    case "execute":
    case "evaluate": {
      return await cdp.evaluate(command.code || command.expression);
    }
    case "check_connection": {
      return { connected: true, debuggerAttached: true, debuggerReady: true, networkMonitoring: false, activeTabId: "cdp" };
    }
    case "start_network_monitor": {
      await cdp.sendToPage("Network.enable");
      return { success: true };
    }
    case "stop_network_monitor": {
      return { success: true };
    }
    case "navigate": {
      await cdp.sendToPage("Page.navigate", { url: command.url });
      // 等待页面加载完成
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        const ready = await cdp.evaluate("document.readyState");
        if (ready.result === "complete") break;
      }
      await new Promise(r => setTimeout(r, 1000));
      // 自动捕获页面数据更新 cache
      try {
        const snap = await cdp.getDOMSnapshot();
        pageCache = { title: snap.title, url: snap.url, text: snap.text, links: snap.links, images: snap.images, capturedAt: Date.now() };
      } catch(e) {}
      return { success: true };
    }
    case "list_tabs": {
      const tabs = await cdp.send("Target.getTargets");
      return {
        success: true,
        tabs: (tabs.targetInfos || []).filter(t => t.type === "page").map(t => ({
          id: t.targetId,
          title: t.title,
          url: t.url,
          active: t.attached,
        })),
        activeTabId: cdp.tabId,
      };
    }
    case "clear_cookies": {
      await cdp.send("Network.clearBrowserCookies");
      return { success: true };
    }
    case "analyze_anti_crawl_deep": {
      const cookies = await cdp.getAllCookies();
      const tokenCookies = cookies.filter(c => /token|auth|session|jwt|sid/i.test(c.name));
      return {
        success: true,
        analysis: {
          cookies,
          authTokens: tokenCookies.map(c => ({ source: "cookie", key: c.name, value: c.value.slice(0, 40), httpOnly: c.httpOnly, secure: c.secure })),
          networkAnalysis: { totalRequests: 0, blocked: 0 },
          pageTitle: pageCache?.title || "",
          pageUrl: pageCache?.url || "",
        },
      };
    }
    default: {
      // For DOM interaction commands that need content script,
      // try using CDP evaluate as fallback
      if (["scroll", "click", "type", "select", "hover", "highlight", "get_element"].includes(command.type)) {
        if (command.type === "get_element") {
          const res = await cdp.evaluate(`(function(){const e=document.querySelector('${command.selector?.replace(/[\\"']/g, "\\$&")}');if(!e)return JSON.stringify({error:'not found'});const r=e.getBoundingClientRect();return JSON.stringify({tag:e.tagName,id:e.id,text:e.textContent?.trim()?.slice(0,200),position:{top:r.top,left:r.left,width:r.width,height:r.height}})})()`);
          return res.success ? JSON.parse(res.result) : res;
        }
        if (command.type === "scroll") {
          const dir = command.direction;
          await cdp.evaluate(dir === "top" ? "window.scrollTo(0,0)" : dir === "bottom" ? `window.scrollTo(0,document.body.scrollHeight)` : `window.scrollBy(0,${dir === "down" ? command.amount || 500 : -(command.amount || 500)})`);
          return { success: true };
        }
        if (command.type === "click") {
          const res = await cdp.evaluate(`(function(){const e=document.querySelector('${command.selector?.replace(/[\\"']/g, "\\$&")}');if(!e)return'not found';e.click();return'clicked'})()`);
          return res.success ? { success: true } : { error: "click failed" };
        }
      }
      throw new Error(`CDP 模式下不支持此操作: ${command.type}。请使用 --cdp 兼容的操作`);
    }
  }
}

// ══════════════════════════════════════════════════════════
// MCP Server
// ══════════════════════════════════════════════════════════

const server = new Server(
  { name: "chrome-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Definitions ───

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ====== 基本信息 ======
    {
      name: "browser_get_page_info",
      description: "获取当前页面的标题、URL、meta标签、字符数、链接数等概要信息",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_content",
      description: "获取当前页面的纯文本内容，可指定最大字符数",
      inputSchema: {
        type: "object",
        properties: {
          maxLength: { type: "number", description: "最大返回字符数", default: 10000 },
        },
      },
    },
    {
      name: "browser_extract_article",
      description: "提取当前页面的文章/主要内容（去除导航、广告、侧栏）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_search_text",
      description: "在当前页面文本中搜索指定内容，返回匹配位置和上下文片段",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的文本" },
        },
        required: ["query"],
      },
    },

    // ====== 图片分析 ======
    {
      name: "browser_get_images",
      description: "获取当前页面所有图片的详细信息（URL、alt文字、自然尺寸、显示尺寸、位置、可见性、懒加载状态、srcset、picture sources、figcaption、CSS背景图等）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_image_details",
      description: "获取页面核心图片（非图标/装饰性）的完整分析",
      inputSchema: {
        type: "object",
        properties: {
          minWidth: { type: "number", description: "最小宽度过滤，默认100px", default: 100 },
          minHeight: { type: "number", description: "最小高度过滤，默认100px", default: 100 },
        },
      },
    },

    // ====== 链接与结构 ======
    {
      name: "browser_get_links",
      description: "获取页面所有链接（含文字、URL、是站内/站外、CSS选择器）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_headings",
      description: "获取页面的标题结构（h1-h6），用于理解页面大纲",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_tables",
      description: "获取页面中所有表格的结构化数据（表头、行、列数）",
      inputSchema: {
        type: "object",
        properties: {
          maxRows: { type: "number", description: "每个表格最大返回行数", default: 50 },
        },
      },
    },
    {
      name: "browser_get_forms",
      description: "获取页面上所有表单及其字段定义（input、select、textarea、label、必填等）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_selected_text",
      description: "获取用户在页面上选中的文本内容及所在元素信息",
      inputSchema: { type: "object", properties: {} },
    },

    // ====== 存储与状态 ======
    {
      name: "browser_get_cookies",
      description: "获取当前页面的 Cookie（值超过20字符会脱敏）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_storage",
      description: "获取页面 localStorage 或 sessionStorage 的内容",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["local", "session"], description: "存储类型", default: "local" },
        },
      },
    },
    {
      name: "browser_get_console_logs",
      description: "获取页面捕获的控制台日志（log/warn/error）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_js_errors",
      description: "获取页面运行时 JS 错误（runtime_error、unhandled_rejection、CSP 违规）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_debug_info",
      description: "🎛️ 获取页面底层调试信息：Performance API 资源加载状态、导航时序、网络质量、JS 错误等",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_performance",
      description: "获取页面性能指标和页面统计数据",
      inputSchema: { type: "object", properties: {} },
    },

    // ====== 🎯 深度网络调试（chrome.debugger / CDP）======
    {
      name: "browser_start_network_monitor",
      description: "🕵️ 启动网络监控，捕获所有 HTTP 请求/响应的详细信息（含请求头、响应头、Cookie、响应体等）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_stop_network_monitor",
      description: "停止网络监控",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_network_log",
      description: "📡 获取捕获的网络请求日志，含请求头/响应头/状态码/响应体/Timing/Token 信息",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "返回最近 N 条请求", default: 50 },
          filterStatus: { type: "number", description: "按 HTTP 状态码过滤（如 403、429）" },
        },
      },
    },
    {
      name: "browser_clear_network_log",
      description: "清空已捕获的网络日志",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_all_cookies",
      description: "🍪 获取当前页面所有 Cookie（含 HttpOnly、Secure 标记、SameSite 策略等完整信息）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_clear_cookies",
      description: "清除浏览器所有 Cookie（谨慎使用）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_dom_snapshot",
      description: "📄 获取当前页面的 DOM 快照（标题、URL、文本、链接、图片），通过 CDP 静默获取，不注入 content script",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_execute_stealth",
      description: "🔑 在页面中静默执行 JS 代码（通过 CDP Runtime.evaluate，不注入 content script，网页无法察觉）",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JavaScript 代码" },
        },
        required: ["code"],
      },
    },
    {
      name: "browser_analyze_anti_crawl_deep",
      description: "🔬 深度反爬分析（基于 CDP 网络数据）：分析所有请求的认证头、Token 传递、Cookie 策略、WAF 拦截、限流状态、加密请求模式等",
      inputSchema: {
        type: "object",
        properties: {
          startMonitoring: { type: "boolean", description: "是否先启动网络监控再分析", default: false },
        },
      },
    },
    {
      name: "browser_attached_debugger_info",
      description: "检查 CDP Debugger 连接状态",
      inputSchema: { type: "object", properties: {} },
    },

    // ====== DOM 操作 ======
    {
      name: "browser_get_element",
      description: "通过 CSS 选择器获取页面元素的详细信息（位置、尺寸、文本、属性、标签特有属性）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器，如 #main .title、div.content、a[href*=download]" },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_click",
      description: "点击页面上的指定元素（通过 CSS 选择器）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "要点击元素的 CSS 选择器" },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_type",
      description: "在输入框中输入文本（会触发 input + change 事件）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "输入框的 CSS 选择器" },
          text: { type: "string", description: "要输入的文本" },
        },
        required: ["selector", "text"],
      },
    },
    {
      name: "browser_select",
      description: "选择下拉框（select）的某个选项",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "select 元素的 CSS 选择器" },
          value: { type: "string", description: "要选中的 option value" },
        },
        required: ["selector", "value"],
      },
    },
    {
      name: "browser_hover",
      description: "模拟鼠标悬停到指定元素上（触发 mouseover/mouseenter）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "要悬停元素的 CSS 选择器" },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_evaluate",
      description: "在页面中执行任意 JavaScript 代码，返回结果（警告：有安全风险）",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JavaScript 代码" },
        },
        required: ["code"],
      },
    },
    {
      name: "browser_highlight",
      description: "高亮页面中的指定元素（用颜色标记，方便肉眼定位）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "要高亮元素的 CSS 选择器" },
          color: { type: "string", description: "高亮颜色（CSS 颜色值，默认黄色）", default: "#ff0" },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_mouse_move",
      description: "🖱️ 模拟鼠标移动到指定坐标（用于反指纹检测，模拟真人操作轨迹）",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "目标 X 坐标" },
          y: { type: "number", description: "目标 Y 坐标" },
          steps: { type: "number", description: "移动步数（越大越平滑，默认5）", default: 5 },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "browser_mouse_click",
      description: "🖱️ 在指定坐标点击鼠标（可指定左键/右键）",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X 坐标" },
          y: { type: "number", description: "Y 坐标" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标按键", default: "left" },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "browser_mouse_drag",
      description: "🖱️ 模拟鼠标拖拽（从起点到终点）",
      inputSchema: {
        type: "object",
        properties: {
          fromX: { type: "number", description: "起点 X" },
          fromY: { type: "number", description: "起点 Y" },
          toX: { type: "number", description: "终点 X" },
          toY: { type: "number", description: "终点 Y" },
          steps: { type: "number", description: "拖拽步数", default: 10 },
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
    },
    {
      name: "browser_press_key",
      description: "⌨️ 模拟键盘按键（Enter、Tab、Escape、ArrowDown、Backspace 等）",
      inputSchema: {
        type: "object",
        properties: {
          key: { 
            type: "string", 
            description: "按键名：Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace, Delete, Space, Home, End",
          },
        },
        required: ["key"],
      },
    },
    {
      name: "browser_wait_for",
      description: "⏳ 等待页面条件（等待元素出现、等待 x 毫秒、等待文本出现）",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "等待此 CSS 选择器对应的元素出现" },
          text: { type: "string", description: "等待页面包含此文本" },
          timeout: { type: "number", description: "最大等待毫秒数（默认 10000）", default: 10000 },
          sleep: { type: "number", description: "直接等待固定毫秒数（不传selector/text时生效）" },
        },
      },
    },
    {
      name: "browser_resize_viewport",
      description: "📐 调整浏览器视口大小",
      inputSchema: {
        type: "object",
        properties: {
          width: { type: "number", description: "视口宽度", default: 1920 },
          height: { type: "number", description: "视口高度", default: 1080 },
        },
      },
    },

    // ====== 页面控制 ======
    {
      name: "browser_scroll",
      description: "滚动当前页面（下/上/顶部/底部）",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["down", "up", "top", "bottom"], description: "滚动方向" },
          amount: { type: "number", description: "滚动像素数（仅 down/up）", default: 500 },
        },
        required: ["direction"],
      },
    },
    {
      name: "browser_capture_now",
      description: "立即从当前页面拉取最新完整数据",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_get_full_page_info",
      description: "获取当前页面的完整综合分析报告（含页面统计、所有图片、链接、表格、表单、标题结构、性能数据等）",
      inputSchema: {
        type: "object",
        properties: {
          includeHtml: { type: "boolean", description: "是否包含 HTML 源码", default: false },
        },
      },
    },

    // ====== 🗺️ 空间布局网格 ======
    {
      name: "browser_get_page_layout",
      description: "🗺️ 获取当前页面的空间布局文本网格，所有交互元素带 [ref] 编号。agent 可据此用编号点击/输入",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_click_ref",
      description: "通过 [ref] 编号点击页面元素（编号从 browser_get_page_layout 获取）",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "元素的 ref 编号" },
        },
        required: ["ref"],
      },
    },
    {
      name: "browser_type_ref",
      description: "通过 [ref] 编号在输入框中输入文本",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "输入框的 ref 编号" },
          text: { type: "string", description: "要输入的文本" },
        },
        required: ["ref", "text"],
      },
    },

    // ====== 标签页与导航 ======
    {
      name: "browser_navigate",
      description: "让当前标签页导航到指定 URL",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要导航到的完整 URL（需包含协议，如 https://example.com）" },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_list_tabs",
      description: "列出 Chrome 中所有打开的标签页及其标题、URL",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_switch_tab",
      description: "切换到指定 ID 的标签页",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID（可通过 browser_list_tabs 获取）" },
        },
        required: ["tabId"],
      },
    },
    {
      name: "browser_close_tab",
      description: "关闭当前标签页或指定标签页",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "标签页 ID（不填则关闭当前）" },
        },
      },
    },
    {
      name: "browser_new_tab",
      description: "打开一个新标签页",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "打开网址（不填则打开空白页）" },
        },
      },
    },
    {
      name: "browser_reload",
      description: "重新加载当前页面",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_go_back",
      description: "浏览器后退一页",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_go_forward",
      description: "浏览器前进一页",
      inputSchema: { type: "object", properties: {} },
    },

    // ====== 实用工具 ======
    {
      name: "browser_analyze_anti_crawl",
      description: "🔍 全面分析当前页面的反爬/反自动化措施：CAPTCHA检测、WAF识别、浏览器指纹采集、隐藏内容/蜜罐、WebDriver检测、行为追踪脚本、反爬库识别、内容混淆、限流信号等，返回详细报告",
      inputSchema: {
        type: "object",
        properties: {
          detailed: {
            type: "boolean",
            description: "是否返回详细检测报告（默认 true），设为 false 只返回摘要",
            default: true,
          },
        },
      },
    },
    {
      name: "browser_check_connection",
      description: "检查 Chrome 扩展是否已连接及当前页面信息",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_screenshot",
      description: "截取当前浏览器窗口的屏幕截图（返回 base64 编码的 PNG）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_handle_dialog",
      description: "处理页面弹窗（alert/confirm/prompt），可接受或取消",
      inputSchema: {
        type: "object",
        properties: {
          accept: { type: "boolean", description: "true=接受 false=取消", default: true },
          text: { type: "string", description: "prompt 输入文本" },
        },
      },
    },
    {
      name: "browser_set_cookie",
      description: "设置/修改 Cookie",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Cookie 名" },
          value: { type: "string", description: "Cookie 值" },
          domain: { type: "string", description: "域名（如 .zhihu.com）" },
          url: { type: "string", description: "可选，完整 URL" },
        },
        required: ["name", "value"],
      },
    },
    {
      name: "browser_detect_ads",
      description: "检测页面中的广告元素，返回广告位置和数量",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_download_file",
      description: "下载文件到本地",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "文件 URL" },
          filename: { type: "string", description: "保存文件名" },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_upload_file",
      description: "向文件上传框上传文件",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "file input 的 CSS 选择器" },
          filePath: { type: "string", description: "文件路径" },
        },
        required: ["selector", "filePath"],
      },
    },
    {
      name: "browser_get_frames",
      description: "获取页面中所有 iframe 的信息",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "browser_screenshot_element",
      description: "截取页面中指定元素的截图",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "元素的 CSS 选择器" },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_export_data",
      description: "将页面结构化数据导出为 JSON/CSV",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["json", "csv"], default: "json" },
        },
      },
    },
    {
      name: "browser_login_flow",
      description: "多步登录：填写表单 → 提交 → 等待跳转",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } } },
            description: "表单字段 [{selector, value}]",
          },
          submitSelector: { type: "string", description: "提交按钮选择器" },
        },
        required: ["fields"],
      },
    },
  ],
}));

// ─── Tool Handlers ───

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── 基本信息 ──
      case "browser_get_page_info": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据。请先访问一个网页，或调用 browser_capture_now");
        return toolMsg(JSON.stringify({
          title: pageCache.title,
          url: pageCache.url,
          meta: pageCache.meta,
          pageInfo: pageCache.pageInfo,
          capturedAt: new Date(pageCache.capturedAt).toISOString(),
        }, null, 2));
      }

      case "browser_get_content": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const maxLen = args?.maxLength || 10000;
        let text = pageCache.text || "";
        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + `\n\n...（共 ${text.length} 字符，仅显示前 ${maxLen}）`;
        }
        return toolMsg(text);
      }

      case "browser_extract_article": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        return toolMsg((pageCache.article || pageCache.text || "").slice(0, 20000));
      }

      case "browser_search_text": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        return toolMsg(searchInText(pageCache.text || "", args?.query || ""));
      }

      // ── 图片分析 ──
      case "browser_get_images": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const imgs = (pageCache.images || []);
        const bgImgs = (pageCache.bgImages || []);
        const lines = [];
        lines.push(`## 页面图片分析`);
        lines.push(`总计 ${imgs.length} 张 <img> 图片，${bgImgs.length} 个 CSS 背景图\n`);
        lines.push(`### <img> 图片详情：`);
        imgs.slice(0, 80).forEach((img, i) => {
          const dims = img.naturalWidth > 0
            ? `${img.naturalWidth}×${img.naturalHeight}`
            : `${Math.round(img.displayedWidth)}×${Math.round(img.displayedHeight)} (显示)`;
          const visible = img.isVisible ? "✅可见" : "⬜不可见";
          const lazy = img.loading === "lazy" ? " ⏳懒加载" : "";
          const aspect = img.aspectRatio ? ` 比例:${img.aspectRatio}` : "";
          lines.push(`\n[${i + 1}] ${dims} | ${visible}${lazy}${aspect}`);
          lines.push(`     src: ${img.src?.slice(0, 200)}`);
          if (img.alt) lines.push(`     alt: ${img.alt}`);
          if (img.figcaption) lines.push(`     figcaption: ${img.figcaption}`);
          if (img.altText === "无alt") lines.push(`     ⚠️ 缺少 alt 文字`);
          if (img.srcset?.length) lines.push(`     srcset: ${img.srcset.map(s => s.url).join(", ").slice(0, 200)}`);
          if (img.pictureSources?.length) lines.push(`     picture: ${img.pictureSources.length} 个 <source>`);
        });

        if (bgImgs.length > 0) {
          lines.push(`\n### CSS 背景图（${bgImgs.length} 个）：`);
          bgImgs.slice(0, 20).forEach((bg, i) => {
            lines.push(`  [${i + 1}] ${bg.url} (${bg.tagName}${bg.id ? "#" + bg.id : ""})`);
          });
        }
        return toolMsg(lines.join("\n"));
      }

      case "browser_get_image_details": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const minW = args?.minWidth || 100;
        const minH = args?.minHeight || 100;
        const imgs = (pageCache.images || []).filter(
          (img) => (img.naturalWidth || img.displayedWidth) >= minW && (img.naturalHeight || img.displayedHeight) >= minH
        );
        const lines = [];
        lines.push(`## 核心图片分析（过滤最小 ${minW}×${minH}）`);
        lines.push(`共 ${imgs.length} 张核心图片\n`);
        imgs.slice(0, 40).forEach((img, i) => {
          lines.push(`### 图 ${i + 1}`);
          lines.push(`- 源: ${img.src?.slice(0, 300)}`);
          lines.push(`- 自然尺寸: ${img.naturalWidth || "?"}×${img.naturalHeight || "?"}`);
          lines.push(`- 显示尺寸: ${Math.round(img.displayedWidth)}×${Math.round(img.displayedHeight)}`);
          lines.push(`- 显示比例: ${img.aspectRatio || "?"}`);
          lines.push(`- 位置: top=${img.position?.top} left=${img.position?.left}`);
          lines.push(`- 状态: ${img.complete ? "已加载" : "加载中"} | ${img.isVisible ? "可见" : "不可见"} | ${img.loading === "lazy" ? "懒加载" : "立即加载"}`);
          if (img.alt) lines.push(`- alt: ${img.alt}`);
          else lines.push(`- ⚠️ 无 alt 文字`);
          if (img.figcaption) lines.push(`- figcaption: ${img.figcaption}`);
          if (img.isDataUrl) lines.push(`- ⚠️ data:URL (小图/图标)`);
          if (img.srcset?.length) lines.push(`- srcset: ${img.srcset.map(s => `${s.url} ${s.size}`).join(", ").slice(0, 200)}`);
          lines.push("");
        });
        return toolMsg(lines.join("\n"));
      }

      // ── 链接与结构 ──
      case "browser_get_links": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const links = (pageCache.links || []).slice(0, 200);
        const extCount = links.filter(l => l.isExternal).length;
        const lines = links.map((l, i) =>
          `${i + 1}. ${l.isExternal ? "🌐" : "📄"} [${l.text || "(无文字)"}](${l.href})`
        );
        return toolMsg(`共 ${pageCache.links?.length || 0} 个链接（站内 ${pageCache.links?.length - extCount}，站外 ${extCount}），显示前 ${lines.length} 个：\n\n${lines.join("\n")}`);
      }

      case "browser_get_headings": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const headings = pageCache.headings || [];
        const lines = headings.map((h, i) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`);
        return toolMsg(`页面标题结构（${headings.length} 个标题）：\n\n${lines.join("\n")}`);
      }

      case "browser_get_tables": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const tables = pageCache.tables || [];
        const maxRows = args?.maxRows || 50;
        const parts = tables.map((t, i) => {
          const rows = t.rows.slice(0, maxRows);
          const headerLine = t.headers?.length ? `| ${t.headers.join(" | ")} |` : "";
          const sep = t.headers?.length ? `| ${t.headers.map(() => "---").join(" | ")} |` : "";
          const dataLines = rows.map(r => `| ${r.join(" | ")} |`);
          return `### 表格 ${i + 1}${t.caption ? ": " + t.caption : ""}\n${t.summary ? `摘要: ${t.summary}\n` : ""}${t.rowCount} 行 × ${t.colCount} 列 | 选择器: \`${t.selector}\`\n\n${headerLine}\n${sep}\n${dataLines.slice(0, maxRows).join("\n")}\n${rows.length < t.rowCount ? `\n... 还有 ${t.rowCount - rows.length} 行未显示` : ""}`;
        });
        return toolMsg(`共 ${tables.length} 个表格：\n\n${parts.join("\n\n---\n\n")}`);
      }

      case "browser_get_forms": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const forms = pageCache.forms || [];
        const parts = forms.map((f, i) => {
          const fields = f.fields.map((fd, j) =>
            `  ${j + 1}. ${fd.label || fd.name || "(未命名)"} [${fd.type}]${fd.required ? " *必填" : ""}${fd.disabled ? " 🔒禁用" : ""}${fd.placeholder ? ` placeholder="${fd.placeholder}"` : ""}${fd.value ? ` value="${fd.value}"` : ""}${fd.options ? ` 选项: ${fd.options.map(o => `${o.text}=${o.value}`).join(", ").slice(0, 200)}` : ""}`
          ).join("\n");
          return `### 表单 ${i + 1}${f.id ? " #" + f.id : ""}\naction: ${f.action || "(当前页)"} | method: ${f.method} | ${f.fieldCount} 个字段\n选择器: \`${f.selector}\`\n\n${fields}`;
        });
        return toolMsg(`共 ${forms.length} 个表单：\n\n${parts.join("\n\n---\n\n")}`);
      }

      case "browser_get_selected_text": {
        const res = await sendToExtension({ type: "get_selected_text" });
        if (res.error) return toolMsg(res.error);
        return toolMsg(`选中文本（${res.length} 字符）：\n\n${res.text}\n\n所在元素: ${res.tagName}\n选择器: ${res.selector}`);
      }

      // ── 存储与状态 ──
      case "browser_get_cookies": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const cookies = pageCache.cookies || [];
        const lines = cookies.map((c, i) => `${i + 1}. ${c.name} = ${c.masked || c.value}`);
        return toolMsg(`共 ${cookies.length} 个 Cookie：\n\n${lines.join("\n")}`);
      }

      case "browser_get_storage": {
        const res = await sendToExtension({ type: "get_storage", type2: args?.type || "local" });
        if (res.error) return toolMsg(res.error);
        const items = Object.entries(res.storage || {}).slice(0, 50);
        const lines = items.map(([k, v]) => `${k} = ${v}`);
        return toolMsg(`${args?.type || "local"}Storage（${items.length} 项）：\n\n${lines.join("\n")}`);
      }

      case "browser_get_console_logs": {
        const res = await sendToExtension({ type: "get_console_logs" });
        if (res.error) return toolMsg(res.error);
        const lines = (res.logs || []).map((l) => `[${l.level.toUpperCase()}] ${l.message}`);
        return toolMsg(`控制台日志（最近 ${lines.length} 条）：\n\n${lines.join("\n") || "(无日志)"}`);
      }

      case "browser_get_js_errors": {
        const res = await sendToExtension({ type: "get_errors" });
        if (res.error) return toolMsg(res.error);
        const errors = res.errors || [];
        if (errors.length === 0) return toolMsg("✅ 无 JS 运行时错误");
        const byType = {};
        errors.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });
        const lines = [`JS 运行时错误统计（共 ${errors.length} 个）：`];
        Object.entries(byType).forEach(([type, count]) => lines.push(`  ${type}: ${count} 次`));
        lines.push("");
        errors.slice(-20).reverse().forEach((e) => {
          lines.push(`[${e.type}] ${e.message}${e.source ? ` (${e.source}:${e.line})` : ""}`);
        });
        return toolMsg(lines.join("\n"));
      }

      case "browser_get_debug_info": {
        const res = await sendToExtension({ type: "get_debug_info" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        const d = res.debug;
        const lines = [];
        lines.push("# 🎛️ 页面调试信息");

        // Navigation timing
        if (d.navigation) {
          lines.push(`\n## 导航时序`);
          lines.push(`| 指标 | 耗时 |`);
          lines.push(`|------|------|`);
          Object.entries(d.navigation).forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
        }

        // Resource summary
        if (d.resourceSummary) {
          lines.push(`\n## 资源加载统计`);
          lines.push(`总计 ${d.resourceSummary.total} 个资源`);
          if (d.resourceSummary.blockedCount > 0) lines.push(`🚫 加载失败: ${d.resourceSummary.blockedCount} 个`);
          if (d.resourceSummary.slowCount > 0) lines.push(`🐢 加载缓慢(>5s): ${d.resourceSummary.slowCount} 个`);
          lines.push(`\n按类型分布：`);
          d.resourceSummary.byType?.forEach((t) => {
            lines.push(`  ${t.type}: ${t.count} 个 (${t.failed > 0 ? `失败${t.failed} ` : ""}${t.totalSize})`);
          });
        }

        // Blocked resources
        if (d.blockedResources?.length > 0) {
          lines.push(`\n## 🚫 加载失败的资源`);
          d.blockedResources.slice(0, 10).forEach((r) => {
            lines.push(`  - [${r.type}] ${r.url}`);
            lines.push(`    ${r.reason || `耗时 ${r.duration}`}`);
          });
        }

        // CSP violations
        if (d.cspViolations?.length > 0) {
          lines.push(`\n## 🔒 CSP 违规`);
          d.cspViolations.forEach((v) => lines.push(`  - ${v.message}`));
        }

        // JS Errors
        if (d.jsErrors?.total > 0) {
          lines.push(`\n## 💥 JS 运行时错误（${d.jsErrors.total} 个）`);
          Object.entries(d.jsErrors.byType || {}).forEach(([type, count]) => {
            lines.push(`  ${type}: ${count} 次`);
          });
        }

        // Anti-crawl timing signals
        if (d.antiCrawlTiming?.length > 0) {
          lines.push(`\n## ⏱ 反爬相关时序信号`);
          d.antiCrawlTiming.forEach((t) => lines.push(`  ${t}`));
        }

        // Network info
        if (d.network) {
          lines.push(`\n## 网络质量`);
          lines.push(`  类型: ${d.network.effectiveType} | 下行: ${d.network.downlink} | RTT: ${d.network.rtt}`);
        }

        return toolMsg(lines.join("\n"));
      }

      case "browser_get_performance": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const pi = pageCache.pageInfo || {};
        const info = [
          "## 页面统计",
          `- 标题: ${pageCache.title}`,
          `- URL: ${pageCache.url}`,
          `- 字符数: ${pi.charCount?.toLocaleString()}`,
          `- 单词数: ${pi.wordCount?.toLocaleString()}`,
          `- 链接数: ${pi.linkCount}`,
          `- 图片数: ${pi.imageCount}`,
          `- 表格数: ${pi.tableCount}`,
          `- 表单数: ${pi.formCount}`,
          `- 标题数: ${pi.headingCount}`,
          `- 视口: ${pi.viewport?.width}×${pi.viewport?.height}`,
          `- 文档高度: ${pi.scrollHeight}px`,
          `- 文档大小: ${pi.documentSize > 1024 ? (pi.documentSize / 1024).toFixed(1) + "KB" : pi.documentSize + "B"}`,
        ].join("\n");
        return toolMsg(info);
      }

      // ── 🎯 CDP 深度调试 ──
      case "browser_start_network_monitor": {
        const res = await sendToExtension({ type: "start_network_monitor" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg("✅ 网络监控已启动，将捕获所有 HTTP 请求/响应的详细信息。\n\n获取数据: browser_get_network_log\n停止监控: browser_stop_network_monitor");
      }

      case "browser_stop_network_monitor": {
        await sendToExtension({ type: "stop_network_monitor" });
        return toolMsg("✅ 网络监控已停止");
      }

      case "browser_get_network_log": {
        const count = args?.count || 50;
        const res = await sendToExtension({ type: "get_network_log", count, filterStatus: args?.filterStatus });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        if (!res.logs?.length) return toolMsg("📡 暂无网络请求记录。请先调用 browser_start_network_monitor");

        const parts = [`📡 网络请求日志（显示 ${res.count}/${res.total} 条）\n`];
        res.logs.slice(0, count).forEach((r, i) => {
          const status = r.response?.status || (r.failed ? "❌" : "?");
          const method = r.method || "GET";
          const url = r.url?.slice(0, 120) || "?";
          const auth = r.authHeaders?.length ? ` 🔑${r.authHeaders.length}` : "";
          const setCookie = r.response?.setCookies?.length ? ` 🍪${r.response.setCookies.length}` : "";
          parts.push(`\n[${i + 1}] ${status} ${method} ${url}`);
          parts.push(`    类型: ${r.type} | 协议: ${r.response?.protocol || "?"} | ${r.response?.remoteIPAddress || ""}`);
          if (r.response?.timing) {
            parts.push(`    耗时: ${Math.round(r.response.timing.receiveHeadersEnd || 0)}ms`);
          }
          if (r.failed) parts.push(`    失败: ${r.errorText || ""} ${r.blockedReason ? `(原因: ${r.blockedReason})` : ""}`);
          if (auth) parts.push(`    🔑 认证头: ${r.authHeaders.map(h => `${h.key}=${h.value?.slice(0, 40)}`).join(", ")}`);
          if (setCookie) parts.push(`    🍪 Set-Cookie: ${r.response.setCookies.slice(0, 3).join("; ")}`);
          if (r.responseBody && r.url.includes("api")) {
            const body = r.responseBody.slice(0, 300);
            parts.push(`    响应体: ${body}`);
          }
        });

        // Summary
        const statusCounts = {};
        res.logs.forEach(r => { const s = r.response?.status || 0; statusCounts[s] = (statusCounts[s] || 0) + 1; });
        parts.push(`\n--- 状态码分布 ---`);
        Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).forEach(([code, count]) => {
          parts.push(`  ${code}: ${count} 次`);
        });

        return toolMsg(parts.join("\n"));
      }

      case "browser_clear_network_log": {
        await sendToExtension({ type: "clear_network_log" });
        return toolMsg("✅ 网络日志已清空");
      }

      case "browser_get_all_cookies": {
        const res = await sendToExtension({ type: "get_all_cookies" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        if (!res.cookies?.length) return toolMsg("🍪 无 Cookie");
        const parts = [`🍪 全量 Cookie（${res.count} 个）\n`];
        const httpOnly = res.cookies.filter(c => c.httpOnly);
        const secure = res.cookies.filter(c => c.secure);
        const session = res.cookies.filter(c => c.session);
        const tokenLike = res.cookies.filter(c => /token|auth|session|jwt|sid/i.test(c.name));
        parts.push(`HttpOnly: ${httpOnly.length} | Secure: ${secure.length} | Session: ${session.length} | 类Token: ${tokenLike.length}\n`);
        res.cookies.forEach((c, i) => {
          const flags = [];
          if (c.httpOnly) flags.push("🔒HttpOnly");
          if (c.secure) flags.push("🔐Secure");
          if (c.session) flags.push("📅Session");
          parts.push(`[${i + 1}] ${c.name} = ${c.value?.slice(0, 60)}${c.value?.length > 60 ? "..." : ""}`);
          parts.push(`    domain=${c.domain} path=${c.path} ${flags.join(" ")} sameSite=${c.sameSite || "?"}`);
        });
        return toolMsg(parts.join("\n"));
      }

      case "browser_clear_cookies": {
        await sendToExtension({ type: "clear_cookies" });
        return toolMsg("✅ 浏览器 Cookie 已清除");
      }

      case "browser_get_dom_snapshot": {
        const res = await sendToExtension({ type: "get_dom_snapshot" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg([
          `📄 页面 DOM 快照（通过 CDP 静默获取）`,
          `标题: ${res.title || ""}`,
          `URL: ${res.url || ""}`,
          `\n文本内容 (${res.text?.length || 0} 字符):`,
          (res.text || "").slice(0, 5000),
          `\n链接 (${res.links?.length || 0} 个):`,
          (res.links || []).slice(0, 30).map((l, i) => `${i + 1}. ${l.text || "(无文字)"} → ${l.href}`).join("\n"),
          `\n图片 (${res.images?.length || 0} 张):`,
          (res.images || []).slice(0, 20).map((img, i) => `[${i + 1}] ${img.src?.slice(0, 100)} ${img.alt ? `(${img.alt})` : ""}`).join("\n"),
        ].join("\n"));
      }

      case "browser_execute_stealth": {
        const code = args?.code;
        if (!code) return toolMsg("请提供要执行的 JS 代码");
        const res = await sendToExtension({ type: "execute", code });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 执行结果:\n${res.result}`);
      }

      case "browser_analyze_anti_crawl_deep": {
        if (args?.startMonitoring) {
          await sendToExtension({ type: "start_network_monitor" });
          await new Promise(r => setTimeout(r, 2000)); // brief wait for initial requests
        }
        const res = await sendToExtension({ type: "analyze_anti_crawl_deep" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        const a = res.analysis;
        if (!a) return toolMsg("无分析数据");

        const parts = [`# 🔬 深度反爬分析（基于 CDP 网络数据）\n`];
        parts.push(`## 网络请求概览`);
        const net = a.networkAnalysis || {};
        parts.push(`总请求数: ${net.totalRequests || 0}`);
        parts.push(`拦截/失败: ${net.blocked || 0}`);
        parts.push(`重定向: ${net.redirects || 0}`);
        parts.push(`含认证头: ${net.authRequests || 0}`);
        parts.push(`WAF 相关: ${net.wafRelated || 0}`);

        if (net.statusCodes && Object.keys(net.statusCodes).length > 0) {
          parts.push(`\n状态码分布:`);
          Object.entries(net.statusCodes).sort((a, b) => b[1] - a[1]).forEach(([code, count]) => {
            const icon = code >= 400 ? "❌" : code >= 300 ? "🔄" : "✅";
            parts.push(`  ${icon} ${code}: ${count} 次`);
          });
        }

        if (a.authTokens?.length > 0) {
          parts.push(`\n## 🔑 检测到的认证 Token`);
          a.authTokens.forEach((t, i) => {
            parts.push(`[${i + 1}] 来源: ${t.source}`);
            parts.push(`    键名: ${t.key}`);
            parts.push(`    值: ${t.value?.slice(0, 60)}`);
            if (t.url) parts.push(`    URL: ${t.url}`);
            if (t.httpOnly !== undefined) parts.push(`    HttpOnly: ${t.httpOnly} | Secure: ${t.secure}`);
          });
        }

        if (a.cookies?.length > 0) {
          const tokenCookies = a.cookies.filter(c => /token|auth|session|jwt|sid/i.test(c.name));
          if (tokenCookies.length > 0) {
            parts.push(`\n## 🍪 认证相关 Cookie`);
            tokenCookies.forEach((c, i) => {
              parts.push(`[${i + 1}] ${c.name} = ${c.value?.slice(0, 40)}`);
              parts.push(`    domain=${c.domain} HttpOnly=${c.httpOnly} Secure=${c.secure} SameSite=${c.sameSite}`);
            });
          }
          const httpOnlyCookies = a.cookies.filter(c => c.httpOnly);
          if (httpOnlyCookies.length > 0) {
            parts.push(`\n## 🔒 HttpOnly Cookie（${httpOnlyCookies.length} 个，JS 无法读取）`);
            httpOnlyCookies.slice(0, 10).forEach(c => parts.push(`  ${c.name} (${c.domain})`));
          }
        }

        return toolMsg(parts.join("\n"));
      }

      case "browser_attached_debugger_info": {
        const res = await sendToExtension({ type: "check_connection" });
        return toolMsg([
          `🎛️ CDP Debugger 状态:`,
          `  Chrome 扩展连接: ${res.connected ? "✅" : "❌"}`,
          `  Debugger 已附加: ${res.debuggerAttached ? "✅" : "❌"}`,
          `  Domains 已启用: ${res.debuggerReady ? "✅" : "❌"}`,
          `  网络监控中: ${res.networkMonitoring ? "✅" : "❌"}`,
          `  网络日志条数: ${res.networkLogCount || 0}`,
          `  活动标签页: ${res.activeTabId || "无"}`,
        ].join("\n"));
      }

      // ── DOM 操作 ──
      case "browser_get_element": {
        const res = await sendToExtension({ type: "get_element", selector: args?.selector });
        if (res.error) return toolMsg(res.error);
        return toolMsg(formatElementInfo(res));
      }

      case "browser_click": {
        const res = await sendToExtension({ type: "click", selector: args?.selector });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已点击元素: <${res.tag}> "${res.text || ""}"`);
      }

      case "browser_type": {
        const res = await sendToExtension({ type: "type", selector: args?.selector, text: args?.text });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已输入文本: "${args?.text?.slice(0, 100)}"`);
      }

      case "browser_select": {
        const res = await sendToExtension({ type: "select", selector: args?.selector, value: args?.value });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已选择选项: ${res.selectedValue}`);
      }

      case "browser_hover": {
        const res = await sendToExtension({ type: "hover", selector: args?.selector });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已悬停到元素: ${args?.selector}`);
      }

      case "browser_evaluate": {
        const res = await sendToExtension({ type: "evaluate", code: args?.code });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 执行结果:\n${res.result}`);
      }

      case "browser_highlight": {
        const res = await sendToExtension({ type: "highlight", selector: args?.selector, color: args?.color || "#ff0" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已高亮 <${res.tag}> "${res.text || ""}" (选择器: ${res.selector})`);
      }

      // ── 🖱️ 鼠标/键盘操作（Playwright 兼容）──
      case "browser_mouse_move": {
        const { x, y, steps = 5 } = args || {};
        if (x === undefined || y === undefined) return toolMsg("请提供 x, y 坐标");
        // 平滑移动：分 steps 步
        if (CDP_MODE && cdp?.connected) {
          // 先获取当前位置
          for (let i = 1; i <= steps; i++) {
            const ratio = i / steps;
            // 使用 ease-out 曲线模拟真人
            const ease = 1 - Math.pow(1 - ratio, 2);
            await cdp.sendToPage("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: Math.round(x * ease),
              y: Math.round(y * ease),
            });
            await new Promise(r => setTimeout(r, 30));
          }
          return toolMsg(`✅ 鼠标已移动到 (${x}, ${y})`);
        }
        return toolMsg(`✅ 鼠标移动到 (${x}, ${y})`);
      }

      case "browser_mouse_click": {
        const { x, y, button = "left" } = args || {};
        if (x === undefined || y === undefined) return toolMsg("请提供 x, y 坐标");
        const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: 1 });
          await new Promise(r => setTimeout(r, 50));
          await cdp.sendToPage("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: 1 });
          return toolMsg(`✅ 已${button === "right" ? "右键" : "左键"}点击 (${x}, ${y})`);
        }
        return toolMsg(`✅ 鼠标点击 (${x}, ${y})`);
      }

      case "browser_mouse_drag": {
        const { fromX, fromY, toX, toY, steps: dragSteps = 10 } = args || {};
        if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
          return toolMsg("请提供 fromX, fromY, toX, toY");
        }
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left" });
          for (let i = 1; i <= dragSteps; i++) {
            const ratio = i / dragSteps;
            const x = Math.round(fromX + (toX - fromX) * ratio);
            const y = Math.round(fromY + (toY - fromY) * ratio);
            await cdp.sendToPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
            await new Promise(r => setTimeout(r, 20));
          }
          await cdp.sendToPage("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left" });
          return toolMsg(`✅ 已拖拽从 (${fromX},${fromY}) 到 (${toX},${toY})`);
        }
        return toolMsg(`✅ 拖拽操作完成`);
      }

      case "browser_press_key": {
        const key = args?.key;
        if (!key) return toolMsg("请提供按键名 (Enter/Tab/Escape 等)");
        const keyMap = {
          "Enter": { keyCode: 13, code: "Enter", key: "Enter" },
          "Tab": { keyCode: 9, code: "Tab", key: "Tab" },
          "Escape": { keyCode: 27, code: "Escape", key: "Escape" },
          "Backspace": { keyCode: 8, code: "Backspace", key: "Backspace" },
          "Delete": { keyCode: 46, code: "Delete", key: "Delete" },
          "Space": { keyCode: 32, code: "Space", key: " " },
          "ArrowUp": { keyCode: 38, code: "ArrowUp", key: "ArrowUp" },
          "ArrowDown": { keyCode: 40, code: "ArrowDown", key: "ArrowDown" },
          "ArrowLeft": { keyCode: 37, code: "ArrowLeft", key: "ArrowLeft" },
          "ArrowRight": { keyCode: 39, code: "ArrowRight", key: "ArrowRight" },
          "Home": { keyCode: 36, code: "Home", key: "Home" },
          "End": { keyCode: 35, code: "End", key: "End" },
          "PageUp": { keyCode: 33, code: "PageUp", key: "PageUp" },
          "PageDown": { keyCode: 34, code: "PageDown", key: "PageDown" },
        };
        const k = keyMap[key];
        if (!k) return toolMsg(`不支持的按键: ${key}（支持: ${Object.keys(keyMap).join(", ")}）`);
        
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Input.dispatchKeyEvent", {
            type: "rawKeyDown", windowsVirtualKeyCode: k.keyCode, key: k.key, code: k.code,
          });
          await cdp.sendToPage("Input.dispatchKeyEvent", {
            type: "keyUp", windowsVirtualKeyCode: k.keyCode, key: k.key, code: k.code,
          });
          return toolMsg(`✅ 已按下 ${key}`);
        }
        return toolMsg(`✅ 按键: ${key}`);
      }

      case "browser_wait_for": {
        const { selector, text, timeout = 10000, sleep } = args || {};
        
        if (sleep) {
          await new Promise(r => setTimeout(r, sleep));
          return toolMsg(`✅ 已等待 ${sleep}ms`);
        }

        const start = Date.now();
        if (CDP_MODE && cdp?.connected) {
          if (selector) {
            while (Date.now() - start < timeout) {
              const res = await cdp.evaluate(`!!document.querySelector('${selector.replace(/[\\"']/g, "\\$&")}')`);
              if (res.result) return toolMsg(`✅ 元素已出现 (${Date.now() - start}ms): ${selector}`);
              await new Promise(r => setTimeout(r, 200));
            }
            return toolMsg(`⏱ 超时: 等待元素 ${selector} 超过 ${timeout}ms`);
          }
          if (text) {
            while (Date.now() - start < timeout) {
              const res = await cdp.evaluate(`document.body?.innerText?.includes('${text.replace(/[\\"']/g, "\\$&")}') || false`);
              if (res.result) return toolMsg(`✅ 文本已出现 (${Date.now() - start}ms): "${text}"`);
              await new Promise(r => setTimeout(r, 200));
            }
            return toolMsg(`⏱ 超时: 等待文本 "${text}" 超过 ${timeout}ms`);
          }
        }
        await new Promise(r => setTimeout(r, timeout));
        return toolMsg(`✅ 已等待 ${timeout}ms`);
      }

      case "browser_resize_viewport": {
        const w = args?.width || 1920;
        const h = args?.height || 1080;
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Emulation.setDeviceMetricsOverride", {
            width: w, height: h, deviceScaleFactor: 1, mobile: false,
          });
          return toolMsg(`✅ 视口已调整为 ${w}×${h}`);
        }
        return toolMsg(`✅ 视口调整为 ${w}×${h}`);
      }

      // ── 页面控制 ──
      case "browser_scroll": {
        const res = await sendToExtension({ type: "scroll", direction: args?.direction, amount: args?.amount || 500 });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已${scrollLabel(args?.direction)} (scrollY=${res.scrollY})`);
      }

      case "browser_capture_now": {
        await sendToExtension({ type: "capture_now" });
        return toolMsg(`✅ 已捕获页面: ${pageCache?.title || "(未知)"}`);
      }

      case "browser_get_full_page_info": {
        if (!pageCache) return toolMsg("⚠️ 尚无页面数据");
        const includeHtml = args?.includeHtml;
        const pi = pageCache.pageInfo || {};
        const parts = [
          `# ${pageCache.title}`,
          `URL: ${pageCache.url}`,
          `捕获时间: ${new Date(pageCache.capturedAt).toISOString()}`,
          ``,
          `## 页面概要`,
          `| 指标 | 值 |`,
          `|------|-----|`,
          `| 字符数 | ${pi.charCount?.toLocaleString() || "?"} |`,
          `| 单词数 | ${pi.wordCount?.toLocaleString() || "?"} |`,
          `| 链接 | ${pi.linkCount} |`,
          `| 图片 | ${pi.imageCount} |`,
          `| 表格 | ${pi.tableCount} |`,
          `| 表单 | ${pi.formCount} |`,
          `| 标题 | ${pi.headingCount} |`,
          `| 视口 | ${pi.viewport?.width}×${pi.viewport?.height} |`,
          `| 文档高度 | ${pi.scrollHeight}px |`,
          ``,
          `## 标题结构`,
          (pageCache.headings || []).map(h => `${"  ".repeat(h.level - 1)}- ${"#".repeat(h.level)} ${h.text}`).join("\n") || "(无)",
          ``,
          `## 图片概览`,
          `${(pageCache.images || []).length} 张 <img> + ${(pageCache.bgImages || []).length} 个 CSS 背景图`,
          (pageCache.images || []).slice(0, 10).map((img, i) =>
            `- [${i + 1}] ${img.naturalWidth || Math.round(img.displayedWidth)}×${img.naturalHeight || Math.round(img.displayedHeight)} ${img.isVisible ? "✅" : "⬜"} ${img.alt || "(无alt)"}`
          ).join("\n"),
          (pageCache.images || []).length > 10 ? `  ... 还有 ${(pageCache.images || []).length - 10} 张` : "",
        ];
        return toolMsg(parts.join("\n"));
      }

      // ── 🗺️ 空间布局网格 ──
      case "browser_get_page_layout": {
        const layout = await renderPageLayout();
        if (layout.error) return toolMsg(layout.error);
        return toolMsg([
          `🗺️ 页面布局 (${layout.viewport?.width}×${layout.viewport?.height}, ${layout.elementCount} 个元素)\n`,
          layout.grid,
          `\n${layout.legend}`,
        ].join('\n'));
      }

      case "browser_click_ref": {
        const ref = args?.ref;
        if (!ref) return toolMsg("请提供 ref 编号");
        // Need to get the selector from the layout
        const jsCode = `
          (function() {
            const els = document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link]');
            const visible = Array.from(els).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 5 && r.height > 5 && r.bottom > 0 && r.top < window.innerHeight;
            });
            const el = visible[${ref} - 1];
            if (!el) return 'not found';
            el.click();
            return 'clicked';
          })()
        `;
        let res;
        if (CDP_MODE && cdp?.connected) {
          res = await cdp.evaluate(jsCode);
        } else {
          res = await sendToExtension({ type: "evaluate", code: jsCode });
        }
        return toolMsg(res.success && res.result === 'clicked' ? `✅ 已点击 [${ref}]` : `❌ 未找到 ref=${ref} 的元素`);
      }

      case "browser_type_ref": {
        const ref = args?.ref;
        const text = args?.text;
        if (!ref || text === undefined) return toolMsg("请提供 ref 编号和 text");
        const jsCode = `
          (function() {
            const els = document.querySelectorAll('input:not([type=hidden]), textarea, select');
            const visible = Array.from(els).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 5 && r.height > 5 && r.bottom > 0 && r.top < window.innerHeight;
            });
            const el = visible[${ref} - 1];
            if (!el) return 'not found';
            el.focus();
            if (el.tagName === 'SELECT') {
              el.value = '${text.replace(/[\\"']/g, '')}';
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              el.value = '${text.replace(/[\\"']/g, '')}';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return 'typed';
          })()
        `;
        let res;
        if (CDP_MODE && cdp?.connected) {
          res = await cdp.evaluate(jsCode);
        } else {
          res = await sendToExtension({ type: "evaluate", code: jsCode });
        }
        return toolMsg(res.success && res.result === 'typed' ? `✅ 已在 [${ref}] 输入"${text}"` : `❌ 未找到 ref=${ref} 的输入框`);
      }

      // ── 标签页与导航 ──
      case "browser_navigate":
      case "browser_list_tabs":
      case "browser_switch_tab":
      case "browser_close_tab":
      case "browser_new_tab":
      case "browser_reload":
      case "browser_go_back":
      case "browser_go_forward":
      case "browser_screenshot": {
        const res = await sendToExtension({
          type: name.replace("browser_", ""),
          ...args,
        });
        if (res.error) return toolMsg(`❌ ${res.error}`);

        if (name === "browser_screenshot") {
          return {
            content: [
              { type: "text", text: "✅ 截图完成，以下是 base64 编码的 PNG 图片数据：" },
              { type: "text", text: res.dataUrl },
            ],
          };
        }
        if (name === "browser_list_tabs") {
          const tabs = (res.tabs || []).map((t) =>
            `- [${t.id}] ${t.active ? "▶ " : ""}${t.title}${t.pinned ? " 📌" : ""}\n  ${t.url}`
          ).join("\n");
          return toolMsg(`当前标签页: ${res.activeTabId}\n\n所有标签页（${tabs.length} 个）：\n\n${tabs}`);
        }
        return toolMsg(`✅ 操作成功`);
      }

      // ── 🆕 弹窗处理 ──
      case "browser_handle_dialog": {
        const accept = args?.accept !== false;
        const text = args?.text || "";
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Page.handleJavaScriptDialog", { accept, promptText: text || undefined });
          return toolMsg(`✅ 已${accept ? "接受" : "取消"}弹窗`);
        }
        const res = await sendToExtension({ type: "handle_dialog", accept, text });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已处理弹窗`);
      }

      // ── 🆕 Cookie 注入 ──
      case "browser_set_cookie": {
        const { name, value, domain, url } = args || {};
        if (!name || value === undefined) return toolMsg("请提供 name 和 value");
        if (CDP_MODE && cdp?.connected) {
          await cdp.send("Network.setCookie", { name, value, domain: domain || undefined, url: url || undefined });
          return toolMsg(`✅ 已设置 Cookie: ${name}=${value.slice(0, 30)}`);
        }
        const res = await sendToExtension({ type: "set_cookie", name, value, domain, url });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已设置 Cookie`);
      }

      // ── 🆕 广告检测 ──
      case "browser_detect_ads": {
        if (CDP_MODE && cdp?.connected) {
          const res = await cdp.evaluate(`
            (function() {
              const adSelectors = ['[class*="ad"]','[id*="ad"]','[class*="banner"]','ins.adsbygoogle','.advertisement','[class*="sponsor"]','[class*="推广"]'];
              const ads = [];
              adSelectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                  if (el.offsetHeight > 0) {
                    const r = el.getBoundingClientRect();
                    ads.push({ type: sel, text: (el.textContent||'').trim().slice(0,40), pos: {top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)} });
                  }
                });
              });
              const adKeywords = ['ad','ads','sponsor','推广','banner','recommend'];
              document.querySelectorAll('[class*="ad"],[id*="ad"],[class*="banner"],[class*="sponsor"],[class*="推广"]').forEach(el => {
                if (el.offsetHeight > 0 && !ads.some(a => a.element === el)) {
                  const r = el.getBoundingClientRect();
                  ads.push({ type: 'keyword:'+el.className, text: (el.textContent||'').trim().slice(0,40), pos: {top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)} });
                }
              });
              return JSON.stringify({ count: ads.length, ads: ads.slice(0,30) });
            })()
          `);
          if (res.success) {
            const data = JSON.parse(res.result);
            return toolMsg(`📢 广告检测: 发现 ${data.count} 个广告元素\n\n${data.ads.map((a,i) => `[${i+1}] ${a.type} "${a.text}" (${a.pos.w}×${a.pos.h})`).join("\n") || "(无广告)"}`);
          }
        }
        const res = await sendToExtension({ type: "detect_ads" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`📢 广告检测完成`);
      }

      // ── 🆕 文件下载 ──
      case "browser_download_file":
      case "browser_download_image": {
        const dlUrl = args?.url;
        if (!dlUrl) return toolMsg("请提供文件 URL");
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("Page.navigate", { url: dlUrl });
          return toolMsg(`✅ 已开始下载: ${dlUrl.split("/").pop()}`);
        }
        return toolMsg(`✅ 下载链接: ${dlUrl}`);
      }

      // ── 🆕 文件上传 ──
      case "browser_upload_file": {
        const { selector, filePath } = args || {};
        if (!selector || !filePath) return toolMsg("请提供 selector 和 filePath");
        if (CDP_MODE && cdp?.connected) {
          await cdp.sendToPage("DOM.setFileInputFiles", {
            files: [filePath],
            nodeId: (await cdp.sendToPage("DOM.querySelector", { selector })).nodeId,
          });
          return toolMsg(`✅ 已上传文件: ${filePath}`);
        }
        const res = await sendToExtension({ type: "upload_file", selector, filePath });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 已上传文件`);
      }

      // ── 🆕 iframe 信息 ──
      case "browser_get_frames": {
        if (CDP_MODE && cdp?.connected) {
          const res = await cdp.evaluate(`
            JSON.stringify(Array.from(document.querySelectorAll('iframe')).map((f,i) => ({
              index: i, src: f.src?.slice(0,150), id: f.id, name: f.name,
              w: f.offsetWidth, h: f.offsetHeight
            })))
          `);
          if (res.success) {
            const frames = JSON.parse(res.result);
            return toolMsg(`📦 iframe 信息 (${frames.length} 个):\n${frames.map(f => `  [${f.index}] ${f.src || "(无src)"} (${f.w}×${f.h})`).join("\n") || "(无iframe)"}`);
          }
        }
        const res = await sendToExtension({ type: "get_frames" });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`📦 iframe 信息获取完成`);
      }

      // ── 🆕 元素截图 ──
      case "browser_screenshot_element": {
        const sel = args?.selector;
        if (!sel) return toolMsg("请提供 CSS 选择器");
        if (CDP_MODE && cdp?.connected) {
          const rect = await cdp.evaluate(`
            (function() {
              const e = document.querySelector('${sel.replace(/[\\"']/g, "\\$&")}');
              if (!e) return 'null';
              const r = e.getBoundingClientRect();
              return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});
            })()
          `);
          if (rect.success && rect.result !== 'null') {
            const r = JSON.parse(rect.result);
            const ss = await cdp.sendToPage("Page.captureScreenshot", { clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
            return { content: [{ type: "text", text: `✅ 元素截图完成 (${r.w}×${r.h})` }, { type: "text", text: ss.data }] };
          }
          return toolMsg(`❌ 未找到元素: ${sel}`);
        }
        return toolMsg(`✅ 元素截图: ${sel}`);
      }

      // ── 🆕 数据导出 ──
      case "browser_export_data": {
        const fmt = args?.format || "json";
        if (CDP_MODE && cdp?.connected) {
          const res = await cdp.evaluate(`
            JSON.stringify({
              title: document.title,
              url: location.href,
              text: (document.body?.innerText || '').slice(0,5000),
              links: Array.from(document.querySelectorAll('a[href]')).slice(0,100).map(a => ({text: a.textContent.trim().slice(0,50), href: a.href})),
              images: Array.from(document.querySelectorAll('img[src]')).slice(0,50).map(i => ({src: i.src, alt: i.alt})),
              headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({level: h.tagName, text: h.textContent.trim().slice(0,50)})),
              tables: Array.from(document.querySelectorAll('table')).slice(0,10).map(t => ({
                caption: t.querySelector('caption')?.textContent?.trim() || '',
                rows: t.querySelectorAll('tr').length
              }))
            })
          `);
          if (res.success) {
            const data = JSON.parse(res.result);
            if (fmt === "csv") {
              const csv = "title,url,text,links,images\n" +
                `"${data.title}","${data.url}","${(data.text||'').slice(0,200).replace(/"/g,'""')}",${data.links.length},${data.images.length}`;
              return toolMsg(`📊 CSV 导出:\n${csv}`);
            }
            return toolMsg(`📊 JSON 导出:\n${JSON.stringify(data, null, 2).slice(0, 4000)}`);
          }
        }
        return toolMsg(`📊 数据导出完成`);
      }

      // ── 🆕 登录流程 ──
      case "browser_login_flow": {
        const { fields, submitSelector } = args || {};
        if (!fields?.length) return toolMsg("请提供表单字段");
        if (CDP_MODE && cdp?.connected) {
          for (const f of fields) {
            if (f.selector && f.value !== undefined) {
              await cdp.evaluate(`
                (function() {
                  const el = document.querySelector('${f.selector.replace(/[\\"']/g, "\\$&")}');
                  if (!el) return;
                  el.value = '${f.value.replace(/[\\"']/g, "")}';
                  el.dispatchEvent(new Event('input', {bubbles:true}));
                  el.dispatchEvent(new Event('change', {bubbles:true}));
                })()
              `);
            }
          }
          if (submitSelector) {
            await cdp.evaluate(`document.querySelector('${submitSelector.replace(/[\\"']/g, "\\$&")}')?.click()`);
          }
          await new Promise(r => setTimeout(r, 2000));
          const url = await cdp.evaluate("location.href");
          return toolMsg(`✅ 登录流程完成\n当前URL: ${url.result}`);
        }
        const res = await sendToExtension({ type: "login_flow", fields, submitSelector });
        if (res.error) return toolMsg(`❌ ${res.error}`);
        return toolMsg(`✅ 登录流程完成`);
      }

      // ── 反爬分析 ──
      case "browser_analyze_anti_crawl": {
        const res = await sendToExtension({ type: "analyze_anti_crawl" });
        if (res.error) return toolMsg(`❌ 分析失败: ${res.error}`);
        const a = res.analysis;
        const detailed = args?.detailed !== false;
        if (!detailed) {
          return toolMsg(`## 反爬分析摘要 — ${a.pageTitle}\n\n${a.summary.join("\n")}`);
        }
        const parts = [];

        // Summary at top
        parts.push(`# 🔍 反爬/反自动化分析报告`);
        parts.push(`页面: ${a.pageTitle}`);
        parts.push(`URL: ${a.pageUrl}`);
        parts.push(`\n## 总体评估`);
        a.summary.forEach(s => parts.push(s));

        // CAPTCHA
        if (a.captcha?.found) {
          parts.push(`\n## 1️⃣ CAPTCHA 检测`);
          parts.push(`类型: ${a.captcha.types.join(", ")}`);
          a.captcha.details.forEach(d => parts.push(`- ${d}`));
        }

        // WAF
        if (a.waf?.detected) {
          parts.push(`\n## 2️⃣ WAF / 挑战页面`);
          parts.push(`提供商: ${a.waf.provider || "未知"}`);
          a.waf.indicators.forEach(i => parts.push(`- ${i}`));
        }

        // Fingerprint
        if (a.fingerprint?.detected) {
          parts.push(`\n## 3️⃣ 浏览器指纹采集`);
          if (a.fingerprint.scripts.length) parts.push(`检测到的指纹库: ${a.fingerprint.scripts.join(", ")}`);
          a.fingerprint.indicators.forEach(i => parts.push(`- ${i}`));
        }

        // Hidden content
        if (a.hidden?.totalHidden > 0) {
          parts.push(`\n## 4️⃣ 隐藏内容`);
          parts.push(`CSS 隐藏元素: ${a.hidden.totalHidden} 个（含 ${a.hidden.textHiddenByCSS} 字符文本）`);
          if (a.hidden.suspiciousNote) parts.push(`- ⚠️ ${a.hidden.suspiciousNote}`);
          if (a.hidden.suspiciousPatterns?.length) {
            a.hidden.suspiciousPatterns.slice(0, 5).forEach(h => {
              parts.push(`- "${h.text.slice(0, 60)}..." → ${h.selector} (${h.how})`);
            });
          }
        }

        // Honeypot
        if (a.honeypot?.found) {
          parts.push(`\n## 5️⃣ 蜜罐（Honeypot）检测`);
          parts.push(`共 ${a.honeypot.traps.length} 个疑似蜜罐`);
          a.honeypot.traps.slice(0, 8).forEach(t => parts.push(`- [${t.type}] ${t.name} (${t.selector})`));
        }

        // WebDriver
        if (a.webdriver?.detected) {
          parts.push(`\n## 6️⃣ WebDriver 自动化检测`);
          a.webdriver.indicators.forEach(i => parts.push(`- ⚠️ ${i}`));
        } else {
          parts.push(`\n## 6️⃣ WebDriver 检测`);
          parts.push(`✅ navigator.webdriver 未被标记`);
        }

        // Behavior tracking
        if (a.behaviorTracking?.detected) {
          parts.push(`\n## 7️⃣ 行为追踪`);
          parts.push(`检测到 ${a.behaviorTracking.events.length} 种事件被监听:`);
          a.behaviorTracking.events.forEach(e => parts.push(`- ${e}`));
        }

        // Anti-bot libs
        if (a.antiBotLibraries?.detected) {
          parts.push(`\n## 8️⃣ 反爬 JS 库`);
          a.antiBotLibraries.libraries.forEach(l => parts.push(`- 📦 ${l}`));
        }

        // Rate limit
        if (a.rateLimit?.detected) {
          parts.push(`\n## 9️⃣ 限流信号`);
          a.rateLimit.signals.forEach(s => parts.push(`- ${s}`));
        }

        // Content loading
        if (a.contentLoading?.indicators?.length) {
          parts.push(`\n## 🔟 内容加载方式`);
          parts.push(`模式: ${a.contentLoading.mode}`);
          a.contentLoading.indicators.forEach(i => parts.push(`- ${i}`));
        }

        // Obfuscation
        if (a.obfuscation?.detected) {
          parts.push(`\n## 1️⃣1️⃣ 内容混淆`);
          a.obfuscation.indicators.forEach(i => parts.push(`- ${i}`));
          if (a.obfuscation.fontFaces?.length) {
            parts.push(`自定义字体:`);
            a.obfuscation.fontFaces.slice(0, 5).forEach(f => parts.push(`  ${f.family}: ${f.src}`));
          }
        }

        // Security
        if (a.security) {
          parts.push(`\n## 1️⃣2️⃣ 安全头`);
          if (a.security.csp) parts.push(`- CSP: ${a.security.csp}`);
          if (a.security.hasFrameOptions) parts.push(`- X-Frame-Options meta 标签已设置`);
          if (a.security.hasXssProtection) parts.push(`- X-XSS-Protection meta 标签已设置`);
          if (!a.security.csp && !a.security.hasFrameOptions && !a.security.hasXssProtection) {
            parts.push(`- 未检测到安全 meta 头`);
          }
        }

        // Debug / Performance timing
        if (a.debug) {
          const d = a.debug;
          parts.push(`\n## 1️⃣3️⃣ 调试时序分析`);
          if (d.navigation) {
            parts.push(`导航: DNS=${d.navigation.dns} TCP=${d.navigation.tcp} TLS=${d.navigation.tls} TTFB=${d.navigation.ttfb} 总耗时=${d.navigation.total} 重定向=${d.navigation.redirectCount}次`);
          }
          if (d.resourceSummary) {
            parts.push(`资源: 共${d.resourceSummary.total}个 | 加载失败=${d.blockedResourceCount} | 慢加载=${d.resourceSummary.slowCount || 0}`);
          }
          if (d.antiCrawlTiming?.length > 0) {
            d.antiCrawlTiming.forEach(t => parts.push(`- ${t}`));
          }
          if (d.jsErrorCount > 0) parts.push(`- 💥 JS运行时错误: ${d.jsErrorCount} 个`);
          if (d.cspViolationCount > 0) parts.push(`- 🔒 CSP违规: ${d.cspViolationCount} 次`);
          if (d.network) parts.push(`- 📶 网络: ${d.network.effectiveType} / ${d.network.downlink} / RTT=${d.network.rtt}`);
        }

        return toolMsg(parts.join("\n"));
      }

      // ── 连接检查 ──
      case "browser_check_connection": {
        const connected = wss?.clients?.size > 0;
        const cdpMode = CDP_MODE && cdp?.connected;
        const isConnected = connected || cdpMode;
        
        if (!isConnected) {
          return toolMsg(`⚠️ 浏览器未连接

当前状态:
  扩展模式: ${connected ? "✅ 已连接" : "⏳ 等待连接"}
  CDP模式:  ${cdpMode ? "✅ 已连接" : "⏳ 未启用"}
  
扩展会自动连接 MCP Server，无需手动操作。
如果长时间未连接，请检查：
  1. 扩展是否已加载（chrome://extensions/）
  2. MCP Server 是否在运行`);
        }
        
        const mode = cdpMode ? "CDP直连" : "扩展模式";
        const tabTitle = pageCache?.title || "未知";
        const tabUrl = pageCache?.url || "未知";
        const stats = pageCache?.pageInfo || {};
        
        return toolMsg(`✅ 浏览器已连接（${mode}）

📄 当前页面: ${tabTitle}
🔗 URL: ${tabUrl}
📊 页面统计: ${pageCache?.links?.length || 0} 链接, ${pageCache?.images?.length || 0} 图片, ${pageCache?.tables?.length || 0} 表格

可用工具: 57 个
  - get_page_layout → 查看页面布局
  - get_page_info → 页面基本信息
  - get_all_cookies → 获取 Cookie
  - analyze_anti_crawl → 反爬分析`);
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    return toolMsg(`❌ 执行失败: ${err.message}`);
  }
});

// ══════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════

function toolMsg(text) {
  return { content: [{ type: "text", text }] };
}

function searchInText(text, query) {
  if (!query) return "请提供搜索文本";
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const results = [];
  let idx = 0;
  while (idx < lower.length && results.length < 50) {
    const pos = lower.indexOf(q, idx);
    if (pos === -1) break;
    const start = Math.max(0, pos - 80);
    const end = Math.min(text.length, pos + q.length + 80);
    results.push({ position: pos, snippet: `...${text.slice(start, end).replace(/\n+/g, " ")}...` });
    idx = pos + 1;
  }
  if (results.length === 0) return `未找到匹配"${query}"的文本`;
  return `找到 ${results.length} 处匹配"${query}"：\n\n${results.map((r, i) => `${i + 1}. (位置 ${r.position}) ${r.snippet}`).join("\n\n")}`;
}

function scrollLabel(direction) {
  const labels = { down: "向下滚动", up: "向上滚动", top: "滚动到顶部", bottom: "滚动到底部" };
  return labels[direction] || direction;
}

// ── Page Layout Text Grid Renderer ──
// Produces a spatial text grid with [ref] markers for agent interaction

const GRID_COLS = 80;
const GRID_ROWS = 40;

async function renderPageLayout() {
  // Get all interactive elements with positions via CDP or extension
  const jsCode = `
    (function() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const colW = vw / ${GRID_COLS};
      const rowH = vh / ${GRID_ROWS};

      // Collect all interactive & visible elements
      const elements = [];
      const selectors = [
        'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
        '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]',
        '[onclick]', '[contenteditable]', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'img[src]', 'p', 'li', 'td', 'th', 'video', 'audio', 'details summary',
      ];
      const seen = new Set();

      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const rect = el.getBoundingClientRect();
          // Must be visible and in viewport
          if (rect.width < 5 || rect.height < 5) return;
          if (rect.bottom < 0 || rect.top > vh) return;
          if (rect.right < 0 || rect.left > vw) return;

          const key = el.tagName + (el.id || '') + (el.className?.slice(0,20) || '') + Math.round(rect.left) + Math.round(rect.top);
          if (seen.has(key)) return;
          seen.add(key);

          let text = '';
          if (el.tagName === 'IMG') text = el.alt || '[图片]';
          else if (el.tagName === 'INPUT') text = el.placeholder || el.name || el.type;
          else if (el.tagName === 'SELECT') {
            const selOpt = el.options[el.selectedIndex];
            text = selOpt ? selOpt.text : el.name;
          } else text = el.textContent?.trim().slice(0, 60) || '';

          if (!text) return;

          elements.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            text: text.slice(0, 50),
            x: Math.round(rect.left / colW),
            y: Math.round(rect.top / rowH),
            right: Math.round(rect.right / colW),
            bottom: Math.round(rect.bottom / rowH),
            w: Math.round(rect.width / colW),
            h: Math.round(rect.height / rowH),
            rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
            selector: (el.id ? '#' + CSS.escape(el.id) : '') || (el.name ? '[name="' + CSS.escape(el.name) + '"]' : '') || el.tagName.toLowerCase() + (el.textContent?.trim().slice(0,20) ? ':contains("' + el.textContent.trim().slice(0,20).replace(/"/g,'') + '")' : ''),
            href: el.href || '',
            value: el.value || '',
            required: el.required || false,
          });
        });
      });

      // Sort by position (top-to-bottom, left-to-right)
      elements.sort((a, b) => a.y - b.y || a.x - b.x);

      // Assign ref numbers
      let ref = 0;
      elements.forEach(el => { el.ref = ++ref; });

      return JSON.stringify({ viewport: { width: vw, height: vh }, elements });
    })()
  `;

  let elements = [];
  let viewport = {};

  // Try CDP first, then extension
  if (CDP_MODE && cdp?.connected) {
    const res = await cdp.evaluate(jsCode);
    if (res.success) {
      const data = JSON.parse(res.result);
      elements = data.elements;
      viewport = data.viewport;
    }
  } else {
    // Extension mode: inject content script to get layout
    const res = await sendToExtension({ type: "get_page_layout" });
    if (res.success && res.elements) {
      elements = res.elements;
      viewport = res.viewport || {};
    } else if (res.success && res.result) {
      // Fallback: evaluate returned JSON string
      try {
        const data = JSON.parse(res.result);
        elements = data.elements || [];
        viewport = data.viewport || {};
      } catch(e) {}
    } else {
      return { error: "无法获取页面布局，请确保页面已加载" };
    }
  }

  // Build text grid
  const grid = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    grid[y] = new Array(GRID_COLS).fill(' ');
  }

  // Place elements on grid
  const legend = [];
  const clickable = [];
  const inputs = [];

  elements.forEach(el => {
    const refStr = `[${el.ref}]`;
    const text = refStr + (el.text ? ' ' + el.text : '');
    const maxW = GRID_COLS - el.x - 1;
    const displayText = text.slice(0, Math.max(5, Math.min(maxW, el.w + refStr.length + 2)));

    // Place on grid
    for (let i = 0; i < displayText.length && el.x + i < GRID_COLS; i++) {
      if (el.y < GRID_ROWS) grid[el.y][el.x + i] = displayText[i];
    }

    // Classify
    const entry = { ref: el.ref, text: el.text, tag: el.tag, type: el.type, selector: el.selector, position: el.rect };

    if (el.tag === 'a' || el.tag === 'button' || el.type === 'submit' || el.type === 'button') {
      entry.action = 'click';
      if (el.href) entry.href = el.href;
      clickable.push(entry);
    } else if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') {
      entry.action = el.tag === 'select' ? 'select' : 'type';
      if (el.value) entry.value = el.value;
      if (el.placeholder) entry.placeholder = el.placeholder;
      if (el.required) entry.required = true;
      inputs.push(entry);
    } else {
      entry.action = 'read';
      clickable.push(entry);
    }
  });

  // Render grid to text
  const gridLines = grid.map(row => row.join('').replace(/\s+$/, ''));
  const gridText = gridLines.join('\n');

  // Build legend
  const legendLines = ['📋 可点击元素:'];
  clickable.forEach(e => legendLines.push(`  [${e.ref}] ${e.text?.slice(0, 40) || '(无文字)'}  → click ${e.ref}` + (e.href ? ` (${e.href.slice(0, 60)})` : '')));

  if (inputs.length) {
    legendLines.push('\n📝 输入框:');
    inputs.forEach(e => legendLines.push(`  [${e.ref}] ${e.placeholder || e.text || '(输入框)'} ${e.required ? '*必填' : ''} → type ${e.ref} "值"`));
  }

  return {
    viewport,
    elementCount: elements.length,
    grid: gridText,
    legend: legendLines.join('\n'),
    clickable: clickable.map(e => ({ ref: e.ref, text: e.text, selector: e.selector, href: e.href })),
    inputs: inputs.map(e => ({ ref: e.ref, text: e.text || e.placeholder, selector: e.selector, required: e.required })),
  };
}

function formatElementInfo(el) {
  if (el.error) return el.error;
  const lines = [
    `元素: <${el.tag}>${el.id ? " #" + el.id : ""}${el.className ? " ." + el.className.split(" ").filter(Boolean).join(".") : ""}`,
    `选择器: \`${el.selector}\``,
    `位置: (${el.position?.top}, ${el.position?.left}) ${el.position?.width}×${el.position?.height}`,
    `可见: ${el.isVisible ? "✅" : "❌"} | 视口中: ${el.isInViewport ? "✅" : "❌"}`,
    `display: ${el.display || "?"} | visibility: ${el.visibility || "?"} | opacity: ${el.opacity || "?"}`,
    `子元素数: ${el.childCount}`,
  ];
  if (el.text) lines.push(`文本: ${el.text.slice(0, 500)}`);
  if (el.innerText) lines.push(`innerText: ${el.innerText.slice(0, 500)}`);
  if (el.html) lines.push(`HTML: ${el.html}`);
  if (el.attributes && Object.keys(el.attributes).length > 0) {
    lines.push(`属性:`);
    Object.entries(el.attributes).slice(0, 15).forEach(([k, v]) => {
      lines.push(`  ${k}="${v}"`);
    });
  }
  if (el.tagSpecific) {
    lines.push(`标签特有信息:`);
    Object.entries(el.tagSpecific).forEach(([k, v]) => {
      const str = typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v);
      lines.push(`  ${k}: ${str}`);
    });
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();

  // Load persisted data
  if (DATA_DIR) {
    const saved = loadData("page_cache");
    if (saved) {
      pageCache = saved;
      console.error(`[Data] ✅ 已加载已保存的页面数据: ${pageCache.title || "(无标题)"}`);
    }
    const savedLogs = loadData("network_log");
    if (savedLogs?.length) {
      // Could restore network logs here
      console.error(`[Data] ✅ 已加载 ${savedLogs.length} 条历史网络日志`);
    }
  }

  // In CDP mode, connect to Chrome before starting MCP
  if (CDP_MODE) {
    cdp = new CdpClient(CDP_PORT);
    try {
      await cdp.connect();
      await cdp.attachToPage();
      console.error("[Agent_WebView] 🎯 CDP 直连模式已就绪");
    } catch (err) {
      console.error(`[Agent_WebView] ❌ CDP 连接失败: ${err.message}`);
      console.error("");
      console.error("  💡 Linux/Mac 启动 Chrome 调试端口：");
      console.error("     google-chrome --remote-debugging-port=9222");
      console.error("     # 或 chromium-browser --remote-debugging-port=9222");
      console.error("");
      console.error("  💡 Windows 启动 Chrome 调试端口：");
      console.error('     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222');
      console.error("");
      console.error("  💡 或者运行项目中的 start.sh (Linux/Mac) 或 start.bat (Windows)");
      process.exit(1);
    }
  }

  await server.connect(transport);
  console.error("[Chrome-MCP] MCP Server 已就绪（stdio 模式）");
}

main().catch((err) => {
  console.error("[Chrome-MCP] 致命错误:", err);
  process.exit(1);
});
