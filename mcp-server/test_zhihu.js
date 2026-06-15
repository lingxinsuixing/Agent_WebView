// 测试：连接 MCP → 打开知乎 → 查看页面
import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let buf = "";
let extConnected = false;
let msgId = 1;
const pending = new Map();

server.stderr.on("data", (d) => {
  const s = d.toString();
  if (s.includes("Chrome 扩展已连接")) extConnected = true;
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = setTimeout(() => { reject(new Error("超时")); }, 20000);
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

function tool(name, args = {}) {
  return call("tools/call", { name, arguments: args });
}

async function main() {
  console.log("⏳ MCP Server 启动中...");
  await new Promise(r => setTimeout(r, 2000));

  // 等待扩展连接
  console.log("⏳ 等待扩展自动连接...");
  for (let i = 0; i < 15; i++) {
    if (extConnected) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!extConnected) {
    console.log("❌ 扩展未连接，请确认已加载并 reload");
    server.kill();
    process.exit(1);
  }
  console.log("✅ 扩展已自动连接\n");

  // 1. 检查连接
  console.log("🔌 检查连接状态...");
  const conn = await tool("browser_check_connection");
  const connText = conn.result?.content?.[0]?.text || "";
  console.log(`   ${connText.split("\n")[0]}`);

  // 2. 打开知乎
  console.log("\n🌐 打开知乎...");
  await tool("browser_navigate", { url: "https://www.zhihu.com" });
  console.log("   已发送导航命令");
  await new Promise(r => setTimeout(r, 3000));

  // 3. 获取页面信息
  console.log("\n📄 获取页面信息...");
  const info = await tool("browser_get_page_info");
  const infoText = info.result?.content?.[0]?.text || "";
  console.log(`   ${infoText.split("\n").slice(0, 4).join("\n   ")}`);

  // 4. 布局网格
  console.log("\n🗺️ 页面布局...");
  const layout = await tool("browser_get_page_layout");
  const layoutText = layout.result?.content?.[0]?.text || "";
  console.log(`   ${layoutText.split("\n").slice(0, 5).join("\n   ")}`);

  // 5. 标题结构
  console.log("\n📑 标题结构...");
  const hd = await tool("browser_get_headings");
  const hdText = hd.result?.content?.[0]?.text || "";
  console.log(`   ${hdText.split("\n").slice(0, 6).join("\n   ")}`);

  // 6. Cookie
  console.log("\n🍪 Cookie...");
  const ck = await tool("browser_get_all_cookies");
  const ckText = ck.result?.content?.[0]?.text || "";
  console.log(`   ${ckText.split("\n").slice(0, 3).join("\n   ")}`);

  // 7. 反爬分析
  console.log("\n🔬 反爬分析...");
  const ac = await tool("browser_analyze_anti_crawl");
  const acText = ac.result?.content?.[0]?.text || "";
  console.log(`   ${acText.split("\n").slice(0, 6).join("\n   ")}`);

  console.log("\n" + "=".repeat(50));
  console.log("✅ 知乎测试完成");
  console.log("=".repeat(50));

  server.kill();
  process.exit(0);
}

main().catch(e => {
  console.error("❌", e.message);
  server.kill();
  process.exit(1);
});
