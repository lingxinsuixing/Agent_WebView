// 多网站测试：知乎、今日头条、抖音、B站
import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let ext = false;
let buf = "", mid = 1;
const p = new Map();

server.stderr.on("data", d => { if (d.toString().includes("扩展已连接")) ext = true; });

function call(method, params, t = 20000) {
  return new Promise((resolve, reject) => {
    const id = mid++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const to = setTimeout(() => reject(new Error("超时")), t);
    const h = (data) => {
      buf += data.toString();
      for (const l of buf.split("\n").filter(Boolean)) {
        try {
          const r = JSON.parse(l);
          if (r.id === id) { clearTimeout(to); server.stdout.removeListener("data", h); resolve(r); return; }
        } catch (e) {}
      }
    };
    server.stdout.on("data", h);
    server.stdin.write(req + "\n");
  });
}

function t(name, args = {}) { return call("tools/call", { name, arguments: args }); }
function gt(r) { return r.result?.content?.[0]?.text || ""; }

async function testSite(name, url) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🌐 ${name}`);
  console.log(`${"=".repeat(50)}`);
  
  process.stdout.write(`  导航 ${name}... `);
  await t("browser_navigate", { url });
  await new Promise(r => setTimeout(r, 4000));
  console.log("✅");
  
  process.stdout.write(`  页面信息... `);
  const info = await t("browser_get_page_info");
  const t2 = gt(info);
  const title = t2.split("\n").find(l => l.includes("title"))?.replace(/.*: "/, "").replace(/",?$/, "") || "?";
  const url2 = t2.split("\n").find(l => l.includes("url"))?.replace(/.*: "/, "").replace(/",?$/, "") || "?";
  const isLogin = !url2.includes("signin") && !url2.includes("login") && !url2.includes("passport");
  console.log(`${isLogin ? "🟢" : "🟡"} ${title?.slice(0, 40)}`);
  
  process.stdout.write(`  链接提取... `);
  const links = await t("browser_get_links");
  const lc = gt(links).split("\n")[0]?.match(/\d+/)?.[0] || "?";
  console.log(`${lc} 个`);
  
  process.stdout.write(`  图片信息... `);
  const imgs = await t("browser_get_images");
  const ic = gt(imgs).split("\n")[0]?.match(/\d+/)?.[0] || "?";
  console.log(`${ic} 张`);
  
  process.stdout.write(`  标题结构... `);
  const hds = await t("browser_get_headings");
  const hc = gt(hds).split("\n")[0]?.match(/\d+/)?.[0] || "0";
  console.log(`${hc} 个`);
  
  process.stdout.write(`  表单分析... `);
  const forms = await t("browser_get_forms");
  const fc = gt(forms).split("\n")[0]?.match(/\d+/)?.[0] || "0";
  console.log(`${fc} 个`);

  // Try Cookie via stealth
  process.stdout.write(`  Cookie(JS)... `);
  try {
    const ck = await t("browser_execute_stealth", { code: "document.cookie.length.toString()" });
    const cl = gt(ck) || "0";
    console.log(`${cl} 字符`);
  } catch(e) { console.log(`跳过`); }

  return { title, url, isLogin };
}

async function main() {
  console.log("⏳ 启动...");
  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 10; i++) { if (ext) break; await new Promise(r => setTimeout(r, 1000)); }
  if (!ext) { console.log("❌ 扩展未连接"); server.kill(); process.exit(1); }
  console.log("✅ 扩展已连接\n");

  const sites = [
    { name: "知乎", url: "https://www.zhihu.com" },
    { name: "今日头条", url: "https://www.toutiao.com" },
    { name: "抖音", url: "https://www.douyin.com" },
    { name: "哔哩哔哩", url: "https://www.bilibili.com" },
  ];

  for (const site of sites) {
    await testSite(site.name, site.url);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("✅ 全部测试完成");
  console.log("现在你可以扫码登录各网站，登录后重新测试查看登录态变化");
  console.log("=".repeat(50));
  
  server.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); server.kill(); process.exit(1); });
