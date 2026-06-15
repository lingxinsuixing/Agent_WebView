// 快速验证测试：MCP tools/list + 浏览器功能
import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let buf = "";
let hasExt = false;
let toolsCount = 0;

server.stderr.on("data", (d) => {
  const s = d.toString();
  if (s.includes("扩展已连接")) hasExt = true;
});

function waitForExt(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    server.stdin.write(req + "\n");
    const timeout = setTimeout(() => { reject(new Error("超时")); }, 12000);
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
  });
}

async function main() {
  // Wait for server ready + extension connection
  console.log("等待扩展自动连接...");
  await waitForExt(4000);
  
  // Test 1: tools/list
  console.log("\n📋 tools/list");
  const list = await call("tools/list", {});
  const tools = list.result?.tools || [];
  toolsCount = tools.length;
  console.log(`   工具总数: ${toolsCount}`);

  if (!hasExt) {
    console.log("⚠️ 扩展未连接");
    console.log("正在重试等待...");
    await waitForExt(5000);
    if (!hasExt) {
      console.log("❌ 扩展仍未连接，请确认扩展已启用");
      server.kill();
      process.exit(1);
    }
  }

  console.log("\n✅ 开始测试浏览器功能\n");

  // Test 2: 连接检查
  console.log("🔌 check_connection");
  try {
    const res = await call("tools/call", { name: "browser_check_connection", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.split("\n")[0]}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 3: 页面信息
  console.log("\n📄 get_page_info");
  try {
    const res = await call("tools/call", { name: "browser_get_page_info", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.slice(0, 200)}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 4: 布局网格
  console.log("\n🗺️ get_page_layout");
  try {
    const res = await call("tools/call", { name: "browser_get_page_layout", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.split("\n").slice(0, 6).join("\n   ")}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 5: 反爬分析
  console.log("\n🔬 analyze_anti_crawl");
  try {
    const res = await call("tools/call", { name: "browser_analyze_anti_crawl", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.split("\n").slice(0, 6).join("\n   ")}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 6: 链接
  console.log("\n🔗 get_links");
  try {
    const res = await call("tools/call", { name: "browser_get_links", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.slice(0, 150)}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 7: 图片
  console.log("\n🖼️ get_images");
  try {
    const res = await call("tools/call", { name: "browser_get_images", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    console.log(`   ${txt.split("\n").slice(0, 3).join("\n   ")}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  // Test 8: Cookie
  console.log("\n🍪 get_all_cookies");
  try {
    const res = await call("tools/call", { name: "browser_get_all_cookies", arguments: {} });
    const txt = res.result?.content?.[0]?.text || "";
    const lines = txt.split("\n");
    console.log(`   ${lines[0]}`);
    console.log(`   ${lines[1] || ""}`);
  } catch(e) { console.log(`   ❌ ${e.message}`); }

  console.log("\n" + "=".repeat(50));
  console.log(`✅ 测试完成 (${toolsCount} tools)`);
  console.log("=".repeat(50));

  server.kill();
  process.exit(0);
}

main().catch(e => {
  console.error("❌", e.message);
  server.kill();
  process.exit(1);
});
