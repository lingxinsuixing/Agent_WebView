// 完整测试：每个网站新标签页 + 全部功能 + 滚动加载
import { spawn } from "child_process";

const server = spawn("node", ["index.js", "--data-dir", "../data"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "D:\\atom\\Agent_WebView\\mcp-server",
});

let ext = false, buf = "", mid = 1;
const p = new Map();
const results = [];

server.stderr.on("data", d => { if (d.toString().includes("扩展已连接")) ext = true; });

function call(method, params, t = 25000) {
  return new Promise((resolve, reject) => {
    const id = mid++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const to = setTimeout(() => reject(new Error("超时")), t);
    const h = (data) => {
      buf += data.toString();
      for (const l of buf.split("\n").filter(Boolean)) {
        try { const r = JSON.parse(l); if (r.id === id) { clearTimeout(to); server.stdout.removeListener("data", h); resolve(r); return; } } catch(e) {}
      }
    };
    server.stdout.on("data", h);
    server.stdin.write(req + "\n");
  });
}

function tool(name, args, t) { return call("tools/call", { name, arguments: args || {} }, t); }
function gt(r) { return r.result?.content?.[0]?.text || ""; }

async function test(name, fn) {
  process.stdout.write(`  ${name.padEnd(20)} `);
  try {
    const r = await fn();
    const ok = !(r?.error || r?.result?.isError);
    const detail = ok ? "✅" : "⚠️";
    results.push({ site: currentSite, name, ok, detail });
    process.stdout.write(`${detail}\n`);
    return r;
  } catch(e) {
    results.push({ site: currentSite, name, ok: false, detail: e.message });
    process.stdout.write(`❌ ${e.message.slice(0,30)}\n`);
  }
}

let currentSite = "";

async function testSite(name, url) {
  currentSite = name;
  console.log(`\n${"━".repeat(55)}`);
  console.log(`🌐 ${name} — ${url}`);
  console.log(`${"━".repeat(55)}`);

  // 1. 新标签页打开
  await test("新标签页", () => tool("browser_new_tab", { url }));
  await new Promise(r => setTimeout(r, 3000));

  // 2. 导航（等待加载完成）
  await test("导航到URL", () => tool("browser_navigate", { url }));
  await new Promise(r => setTimeout(r, 4000));

  // 3. 获取页面信息
  await test("页面信息", () => tool("browser_get_page_info"));

  // 4. 布局网格
  await test("布局网格", () => tool("browser_get_page_layout").catch(() => ({ error: "n/a" })));

  // 5. 内容提取
  await test("全文内容", () => tool("browser_get_content", { maxLength: 300 }));
  await test("标题结构", () => tool("browser_get_headings"));
  await test("链接提取", () => tool("browser_get_links"));
  await test("图片信息", () => tool("browser_get_images"));
  await test("表单分析", () => tool("browser_get_forms"));

  // 6. 滚动加载测试
  console.log(`  📜 滚动加载测试:`);
  const beforeLinks = await tool("browser_get_links");
  const beforeCount = parseInt(gt(beforeLinks).match(/\d+/)?.[0] || "0");
  
  for (let i = 0; i < 3; i++) {
    await test(`  第${i+1}次滚动`, () => tool("browser_scroll", { direction: "down", amount: 600 }));
    await new Promise(r => setTimeout(r, 2000));
  }
  
  const afterLinks = await tool("browser_get_links");
  const afterCount = parseInt(gt(afterLinks).match(/\d+/)?.[0] || "0");
  const loadedMore = afterCount > beforeCount;
  console.log(`  链接数: ${beforeCount} → ${afterCount}${loadedMore ? ' 📈' : ' (持平)'}`);
  results.push({ site: name, name: "滚动加载更多", ok: true, detail: `${beforeCount}→${afterCount}` });

  // 7. Cookie 检测
  await test("Cookie检测", () => tool("browser_execute_stealth", { code: `JSON.stringify({len: document.cookie.length, cookies: document.cookie.split(';').length})` }).catch(() => ({ error: "n/a" })));

  // 8. 鼠标操作
  await test("鼠标移动", () => tool("browser_mouse_move", { x: 300, y: 200, steps: 5 }).catch(() => ({ error: "n/a" })));
  await test("鼠标点击", () => tool("browser_mouse_click", { x: 300, y: 200 }).catch(() => ({ error: "n/a" })));
  await test("按键Escape", () => tool("browser_press_key", { key: "Escape" }).catch(() => ({ error: "n/a" })));

  // 9. 回顶部
  await test("回到顶部", () => tool("browser_scroll", { direction: "top" }));
}

async function main() {
  console.log("⏳ 等待扩展连接...");
  for (let i = 0; i < 15; i++) { if (ext) break; await new Promise(r => setTimeout(r, 1000)); }
  if (!ext) { console.log("❌ 扩展未连接"); server.kill(); process.exit(1); }
  console.log("✅ 扩展已连接\n");

  const sites = [
    ["知乎", "https://www.zhihu.com"],
    ["今日头条", "https://www.toutiao.com"],
    ["抖音", "https://www.douyin.com"],
    ["哔哩哔哩", "https://www.bilibili.com"],
  ];

  for (const [name, url] of sites) {
    await testSite(name, url);
  }

  // ═══ 汇总 ═══
  console.log(`\n\n${"═".repeat(55)}`);
  console.log("📊 测试报告");
  console.log(`${"═".repeat(55)}`);
  
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  console.log(`\n✅ 通过: ${ok.length}/${results.length} (${(ok.length/results.length*100).toFixed(1)}%)`);
  console.log(`❌ 失败: ${fail.length}`);
  
  if (fail.length > 0) {
    console.log(`\n❌ 失败详情:`);
    fail.forEach(f => console.log(`  ${f.site} | ${f.name}: ${f.detail}`));
  }
  
  console.log(`\n📈 滚动加载:`);
  results.filter(r => r.name.includes("滚动")).forEach(r => console.log(`  ${r.site}: ${r.detail}`));
  
  console.log(`\n🐛 Bug 统计:`);
  const bugs = results.filter(r => !r.ok);
  if (bugs.length === 0) console.log("  未发现明显 Bug ✅");

  server.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); server.kill(); process.exit(1); });
