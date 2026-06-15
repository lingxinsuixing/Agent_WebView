// Agent_WebView 完整功能测试 — 等待扩展连接后测试
import { spawn } from "child_process";

const SERVER_READY_MSG = "MCP Server 已就绪";
const EXT_CONNECTED_MSG = "Chrome 扩展已连接";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let buf = "";
let extConnected = false;
let serverReady = false;
let msgId = 1;
const pending = new Map();

server.stderr.on("data", (d) => {
  const s = d.toString();
  if (s.includes(SERVER_READY_MSG) && !serverReady) {
    serverReady = true;
    console.log("✅ MCP Server 已就绪");
  }
  if (s.includes(EXT_CONNECTED_MSG) && !extConnected) {
    extConnected = true;
    console.log("✅ 扩展已自动连接");
  }
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = setTimeout(() => { reject(new Error("超时")); }, 15000);
    const handler = (data) => {
      buf += data.toString();
      const lines = buf.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            clearTimeout(timeout);
            server.stdout.removeListener("data", handler);
            resolve(resp);
            return;
          }
        } catch (e) {}
      }
    };
    server.stdout.on("data", handler);
    server.stdin.write(req + "\n");
  });
}

async function main() {
  console.log("等待扩展自动连接...\n");
  
  // 等待扩展连接，最多等 15 秒
  const start = Date.now();
  while (!extConnected && Date.now() - start < 15000) {
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (!extConnected) {
    console.log("⚠️ 扩展未在 15 秒内连接");
    console.log("请确保扩展已加载: chrome://extensions/ → 重新加载 Agent_WebView");
    server.kill();
    process.exit(1);
  }

  // 等一小会儿让扩展完成初始化
  await new Promise(r => setTimeout(r, 1000));

  // ═══ Test 1: 工具列表 ═══
  console.log("\n" + "=".repeat(50));
  console.log("📋 Test 1: tools/list");
  console.log("=".repeat(50));
  const list = await call("tools/list", {});
  const tools = list.result?.tools || [];
  console.log(`   工具总数: ${tools.length} ✅`);

  // ═══ Test 2: 连接状态 ═══
  console.log("\n" + "=".repeat(50));
  console.log("🔌 Test 2: browser_check_connection");
  console.log("=".repeat(50));
  const conn = await call("tools/call", { name: "browser_check_connection", arguments: {} });
  const connText = conn.result?.content?.[0]?.text || "";
  console.log(`   ${connText.split("\n")[0]}`);
  console.log(`   ${connText.split("\n")[1] || ""}`);

  // ═══ Test 3: 页面信息 ═══
  console.log("\n" + "=".repeat(50));
  console.log("📄 Test 3: browser_get_page_info");
  console.log("=".repeat(50));
  const pg = await call("tools/call", { name: "browser_get_page_info", arguments: {} });
  const pgText = pg.result?.content?.[0]?.text || "";
  console.log(`   ${pgText.split("\n").slice(0, 3).join("\n   ")}`);

  // ═══ Test 4: 布局网格 ═══
  console.log("\n" + "=".repeat(50));
  console.log("🗺️ Test 4: browser_get_page_layout");
  console.log("=".repeat(50));
  const layout = await call("tools/call", { name: "browser_get_page_layout", arguments: {} });
  const layoutText = layout.result?.content?.[0]?.text || "";
  console.log(`   ${layoutText.split("\n").slice(0, 5).join("\n   ")}...`);

  // ═══ Test 5: 反爬分析 ═══
  console.log("\n" + "=".repeat(50));
  console.log("🔬 Test 5: browser_analyze_anti_crawl");
  console.log("=".repeat(50));
  const ac = await call("tools/call", { name: "browser_analyze_anti_crawl", arguments: {} });
  const acText = ac.result?.content?.[0]?.text || "";
  console.log(`   ${acText.split("\n").slice(0, 6).join("\n   ")}`);

  // ═══ Test 6: 链接 ═══
  console.log("\n" + "=".repeat(50));
  console.log("🔗 Test 6: browser_get_links");
  console.log("=".repeat(50));
  const links = await call("tools/call", { name: "browser_get_links", arguments: {} });
  const linksText = links.result?.content?.[0]?.text || "";
  console.log(`   ${linksText.split("\n").slice(0, 3).join("\n   ")}`);

  // ═══ Test 7: 图片 ═══
  console.log("\n" + "=".repeat(50));
  console.log("🖼️ Test 7: browser_get_images");
  console.log("=".repeat(50));
  const imgs = await call("tools/call", { name: "browser_get_images", arguments: {} });
  const imgsText = imgs.result?.content?.[0]?.text || "";
  console.log(`   ${imgsText.split("\n").slice(0, 4).join("\n   ")}`);

  // ═══ Test 8: Cookie ═══
  console.log("\n" + "=".repeat(50));
  console.log("🍪 Test 8: browser_get_all_cookies");
  console.log("=".repeat(50));
  const ck = await call("tools/call", { name: "browser_get_all_cookies", arguments: {} });
  const ckText = ck.result?.content?.[0]?.text || "";
  console.log(`   ${ckText.split("\n").slice(0, 4).join("\n   ")}`);

  // ═══ Test 9: 表单 ═══
  console.log("\n" + "=".repeat(50));
  console.log("📝 Test 9: browser_get_forms");
  console.log("=".repeat(50));
  const fm = await call("tools/call", { name: "browser_get_forms", arguments: {} });
  const fmText = fm.result?.content?.[0]?.text || "";
  console.log(`   ${fmText.split("\n").slice(0, 4).join("\n   ")}`);

  // ═══ Test 10: 标题结构 ═══
  console.log("\n" + "=".repeat(50));
  console.log("📑 Test 10: browser_get_headings");
  console.log("=".repeat(50));
  const hd = await call("tools/call", { name: "browser_get_headings", arguments: {} });
  const hdText = hd.result?.content?.[0]?.text || "";
  console.log(`   ${hdText.split("\n").slice(0, 6).join("\n   ")}`);

  // 总结
  console.log("\n" + "=".repeat(50));
  console.log("✅ 全部 10 项测试完成");
  console.log("=".repeat(50));

  server.kill();
  process.exit(0);
}

main().catch(e => {
  console.error("❌", e.message);
  server.kill();
  process.exit(1);
});
