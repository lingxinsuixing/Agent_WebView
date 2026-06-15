// 全面测试：知乎登录复用 + 网页操作 + 滚动加载
import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let extConnected = false;
let buf = "";
let msgId = 1;
const pending = new Map();

server.stderr.on("data", (d) => {
  if (d.toString().includes("扩展已连接")) extConnected = true;
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = setTimeout(() => reject(new Error("超时")), 30000);
    const handler = (data) => {
      buf += data.toString();
      for (const line of buf.split("\n").filter(Boolean)) {
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

function tool(name, args = {}) {
  return call("tools/call", { name, arguments: args });
}

function getText(resp) {
  return resp.result?.content?.[0]?.text || "";
}

async function main() {
  console.log("⏳ 启动中...");
  await new Promise(r => setTimeout(r, 3000));
  
  for (let i = 0; i < 10; i++) {
    if (extConnected) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  
  if (!extConnected) {
    console.log("❌ 扩展未连接，请在 chrome://extensions/ reload");
    server.kill();
    process.exit(1);
  }
  console.log("✅ 扩展已连接\n");

  // ═══ 1. 检查连接 ═══
  console.log("🔌 检查连接");
  const conn = await tool("browser_check_connection");
  console.log(`   ${getText(conn).split("\n")[0]}`);

  // ═══ 2. 看当前页面 ═══
  console.log("\n📄 当前页面信息");
  const info = await tool("browser_get_page_info");
  console.log(`   标题: ${getText(info).split("\n").find(l => l.includes("title"))?.replace(/.*: "/, "").replace(/",?$/, "") || "?"}`);
  console.log(`   URL: ${getText(info).split("\n").find(l => l.includes("url"))?.replace(/.*: "/, "").replace(/",?$/, "") || "?"}`);

  // ═══ 3. 判断是否已登录 ═══
  console.log("\n🔐 检查登录状态");
  const urlCheck = await tool("browser_get_page_info");
  const urlText = getText(urlCheck);
  const isLoggedIn = !urlText.includes("signin") && !urlText.includes("login");
  console.log(`   ${isLoggedIn ? "✅ 已登录（非登录页）" : "⚠️ 未登录（跳转到登录页）"}`);

  // ═══ 4. 看页面布局 ═══
  console.log("\n🗺️ 页面布局");
  const layout = await tool("browser_get_page_layout");
  const layoutText = getText(layout);
  console.log(`   ${layoutText.split("\n").slice(0, 3).join("\n   ")}`);
  const legendLines = layoutText.split("\n").filter(l => l.includes("[") && l.includes("]"));
  console.log(`   📋 交互元素: ${legendLines.length} 个`);
  legendLines.slice(0, 8).forEach(l => console.log(`   ${l}`));

  // ═══ 5. 滚动页面（模拟真人） ═══
  console.log("\n📜 滚动页面...");
  for (let i = 0; i < 3; i++) {
    await tool("browser_scroll", { direction: "down", amount: 600 });
    await new Promise(r => setTimeout(r, 1500));
    console.log(`   第 ${i + 1} 次滚动`);
  }

  // ═══ 6. 滚动后重新获取页面信息 ═══
  console.log("\n📄 滚动后页面信息");
  const info2 = await tool("browser_get_page_info");
  const info2Text = getText(info2);
  console.log(`   ${info2Text.split("\n").slice(0, 3).join("\n   ")}`);

  // ═══ 7. 获取链接（滚动后更多内容） ═══
  console.log("\n🔗 滚动后链接");
  const links = await tool("browser_get_links");
  const linksText = getText(links);
  console.log(`   ${linksText.split("\n").slice(0, 3).join("\n   ")}`);

  // ═══ 8. 获取 Cookie 检查登录态 ═══
  console.log("\n🍪 Cookie（登录态）");
  const ck = await tool("browser_get_all_cookies");
  const ckText = getText(ck);
  console.log(`   ${ckText.split("\n").slice(0, 4).join("\n   ")}`);
  // 查找知乎认证 Cookie
  const zhihuCookies = ckText.split("\n").filter(l => l.includes("z_c0") || l.includes("d_c0") || l.includes("SESSIONID"));
  if (zhihuCookies.length > 0) {
    console.log(`   🔑 知乎登录Cookie: ${zhihuCookies.join(", ")}`);
  }

  // ═══ 9. 点击操作 ═══
  console.log("\n🖱️ 测试鼠标操作");
  try {
    await tool("browser_mouse_move", { x: 500, y: 300, steps: 8 });
    console.log("   ✅ 鼠标移动 (500, 300)");
  } catch(e) { console.log(`   ⚠️ 鼠标移动: ${e.message}`); }
  
  try {
    await tool("browser_mouse_click", { x: 500, y: 300 });
    console.log("   ✅ 鼠标点击 (500, 300)");
  } catch(e) { console.log(`   ⚠️ 鼠标点击: ${e.message}`); }

  // ═══ 10. 键盘操作 ═══
  console.log("\n⌨️ 键盘操作");
  try {
    await tool("browser_press_key", { key: "Escape" });
    console.log("   ✅ 按下 Escape");
  } catch(e) { console.log(`   ⚠️ 按键: ${e.message}`); }

  // ═══ 11. 回顶部 ═══
  console.log("\n⬆️ 回到顶部");
  await tool("browser_scroll", { direction: "top" });
  console.log("   ✅ 已回顶部");

  console.log("\n" + "=".repeat(50));
  console.log("✅ 知乎全面测试完成");
  console.log("=".repeat(50));
  
  server.kill();
  process.exit(0);
}

main().catch(e => {
  console.error("❌", e.message);
  server.kill();
  process.exit(1);
});
