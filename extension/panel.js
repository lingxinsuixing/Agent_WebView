// ── Side Panel Logic ──
const $ = (sel) => document.querySelector(sel);
const logPanel = $("#logPanel");
const emptyLog = $("#emptyLog");

function log(msg, type = "info") {
  if (emptyLog && !emptyLog.classList.contains("hidden")) {
    emptyLog.classList.add("hidden");
  }
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  logPanel.appendChild(entry);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function updateStatus(connected) {
  const dot = $("#statusDot");
  const text = $("#connStatus");
  const btnConn = $("#btnConnect");
  const btnDisconn = $("#btnDisconnect");

  if (connected) {
    dot.className = "dot online";
    text.textContent = "已连接";
    btnConn.classList.add("hidden");
    btnDisconn.classList.remove("hidden");
  } else {
    dot.className = "dot offline";
    text.textContent = "未连接";
    btnConn.classList.remove("hidden");
    btnDisconn.classList.add("hidden");
  }
}

function updatePageInfo(data) {
  if (!data) {
    $("#pageTitle").textContent = "—";
    $("#pageUrl").textContent = "—";
    $("#statLinks").textContent = "0";
    $("#statImages").textContent = "0";
    $("#statChars").textContent = "0";
    $("#statWords").textContent = "0";
    return;
  }

  $("#pageTitle").textContent = data.title || "—";
  $("#pageUrl").textContent = data.url || "—";
  $("#tabStatus").textContent = data.title ? data.title.slice(0, 30) + (data.title.length > 30 ? "…" : "") : "—";

  // Stats
  const links = data.links?.length || 0;
  const images = (data.images?.length || 0) + (data.bgImages?.length || 0);
  const chars = data.text?.length || 0;
  const words = chars > 0 ? Math.round(chars / 5) : 0;
  const tables = data.tables?.length || 0;
  const forms = data.forms?.length || 0;
  $("#statLinks").textContent = links.toLocaleString();
  $("#statImages").textContent = images.toLocaleString();
  $("#statChars").textContent = chars.toLocaleString();
  $("#statWords").textContent = tables + "/" + forms;

  // Update stats tooltip
  $("#statWords").title = `${tables} 个表格 / ${forms} 个表单`;
}

// ── Event Listeners ──
$("#btnConnect").addEventListener("click", () => {
  const wsUrl = $("#wsUrl").value.trim() || "ws://localhost:9134";
  chrome.runtime.sendMessage(
    { source: "panel", type: "connect", wsUrl },
    (resp) => {
      if (resp?.success) {
        log("已连接到 MCP Server: " + wsUrl, "ok");
        updateStatus(true);
      } else {
        log("连接失败", "err");
      }
    }
  );
});

$("#btnDisconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    { source: "panel", type: "disconnect" },
    (resp) => {
      if (resp?.success) {
        log("已断开连接", "info");
        updateStatus(false);
      }
    }
  );
});

$("#btnRefresh").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    { source: "panel", type: "refresh" },
    (resp) => {
      if (resp?.success) {
        log("已请求刷新页面数据", "ok");
      } else {
        log("刷新失败: " + (resp?.error || "未知错误"), "err");
      }
    }
  );
});

// ── Listen for messages from background ──
chrome.runtime.onMessage.addListener((message) => {
  if (message.source !== "background") return;

  switch (message.type) {
    case "connection_status":
      updateStatus(message.connected);
      if (message.connected) {
        log("WebSocket 已连接", "ok");
      } else {
        log("WebSocket 已断开", "err");
      }
      break;

    case "page_captured":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab) {
          updatePageInfo({
            title: message.title || tab.title,
            url: message.url || tab.url,
            links: message.links,
            images: message.images,
            text: message.text,
            tables: message.tables,
            forms: message.forms,
            bgImages: message.bgImages,
          });
          log("已捕获页面: " + (message.title || "").slice(0, 40), "ok");
        }
      });
      break;
  }
});

// ── Init ──
chrome.runtime.sendMessage(
  { source: "panel", type: "get_status" },
  (resp) => {
    if (resp) {
      updateStatus(resp.connected);
      if (resp.connected) {
        log("WebSocket 已连接", "ok");
      }
    }
  }
);

// Get current tab info on load
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs?.[0]) {
    $("#tabStatus").textContent = (tabs[0].title || "").slice(0, 30) + (tabs[0].title?.length > 30 ? "…" : "");
    $("#pageTitle").textContent = tabs[0].title || "—";
    $("#pageUrl").textContent = tabs[0].url || "—";
  }
});
