import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let buf = "";
let msgId = 1;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = setTimeout(() => reject(new Error("超时")), 15000);
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

async function main() {
  // 直接获取当前页面信息（不导航）
  console.log("📄 当前页面信息:");
  const info = await tool("browser_get_page_info");
  const t = info.result?.content?.[0]?.text || "";
  console.log(`  ${t.split("\n").slice(0,4).join("\n  ")}`);

  // 打开知乎
  console.log("\n🌐 打开知乎...");
  await tool("browser_navigate", { url: "https://www.zhihu.com" });
  await new Promise(r => setTimeout(r, 4000));

  // 页面信息
  console.log("\n📄 知乎页面:");
  const info2 = await tool("browser_get_page_info");
  const t2 = info2.result?.content?.[0]?.text || "";
  console.log(`  ${t2.split("\n").slice(0,4).join("\n  ")}`);

  // 标题
  const hd = await tool("browser_get_headings");
  const hdText = hd.result?.content?.[0]?.text || "";
  console.log(`\n📑 标题:\n  ${hdText.split("\n").slice(0,4).join("\n  ")}`);

  // 链接数
  const links = await tool("browser_get_links");
  const l = links.result?.content?.[0]?.text || "";
  console.log(`\n🔗 链接:\n  ${l.split("\n").slice(0,3).join("\n  ")}`);

  // Cookie 数
  const ck = await tool("browser_get_all_cookies");
  const ckt = ck.result?.content?.[0]?.text || "";
  console.log(`\n🍪 Cookie:\n  ${ckt.split("\n").slice(0,3).join("\n  ")}`);

  console.log("\n✅ 完成");
  server.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); server.kill(); process.exit(1); });
