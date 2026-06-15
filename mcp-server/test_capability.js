// 全面能力测试：识别缺什么，需要加什么
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

function call(method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeout = setTimeout(() => reject(new Error("超时")), timeoutMs);
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

function tool(name, args = {}, timeout = 20000) {
  return call("tools/call", { name, arguments: args }, timeout);
}

const R = []; // results

async function t(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const res = await fn();
    const ok = !(res?.error || res?.result?.isError);
    R.push({ name, ok, detail: ok ? "✅" : "⚠️" });
    process.stdout.write(`${ok ? "✅" : "⚠️"}\n`);
    return res;
  } catch (e) {
    R.push({ name, ok: false, detail: e.message });
    process.stdout.write(`❌ ${e.message}\n`);
  }
}

async function main() {
  console.log("⏳ 启动...");
  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 10; i++) {
    if (extConnected) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!extConnected) { console.log("❌ 扩展未连接"); server.kill(); process.exit(1); }
  
  // 先导航到知乎
  console.log("\n🌐 导航到知乎");
  await tool("browser_navigate", { url: "https://www.zhihu.com" });
  await new Promise(r => setTimeout(r, 4000));

  console.log("\n" + "=".repeat(55));
  console.log("📋 能力测试");
  console.log("=".repeat(55) + "\n");

  // 1. 页面导航
  console.log("📄 1. 页面导航");
  await t("导航到URL", () => tool("browser_navigate", { url: "https://www.zhihu.com/question/301476273" }));
  await new Promise(r => setTimeout(r, 3000));
  await t("获取页面信息", () => tool("browser_get_page_info"));
  await t("前进", () => tool("browser_go_forward").catch(() => ({ error: "n/a" })));
  await t("后退", () => tool("browser_go_back").catch(() => ({ error: "n/a" })));

  // 2. 页面内容提取
  console.log("\n📋 2. 页面内容提取");
  await t("全文内容", () => tool("browser_get_content", { maxLength: 500 }));
  await t("文章提取", () => tool("browser_extract_article"));
  await t("标题结构", () => tool("browser_get_headings"));
  await t("链接提取", () => tool("browser_get_links"));
  await t("图片信息", () => tool("browser_get_images"));
  await t("表格提取", () => tool("browser_get_tables"));
  await t("表单分析", () => tool("browser_get_forms"));

  // 3. 页面操作
  console.log("\n🖱️ 3. 页面操作");
  await t("滚动", () => tool("browser_scroll", { direction: "down", amount: 500 }));
  await t("鼠标移动", () => tool("browser_mouse_move", { x: 300, y: 200, steps: 5 }));
  await t("鼠标点击", () => tool("browser_mouse_click", { x: 300, y: 200 }));
  await t("按键Escape", () => tool("browser_press_key", { key: "Escape" }));
  await t("等待元素", () => tool("browser_wait_for", { sleep: 500 }));
  await t("高亮元素", () => tool("browser_highlight", { selector: "h1" }).catch(() => ({ error: "n/a" })));

  // 4. 标签页管理
  console.log("\n🌐 4. 标签页管理");
  await t("列出标签页", () => tool("browser_list_tabs"));
  await t("打开新标签页", () => tool("browser_new_tab", { url: "https://www.baidu.com" }));
  await new Promise(r => setTimeout(r, 2000));
  const tabs = await tool("browser_list_tabs");
  const tabList = tabs.result?.content?.[0]?.text || "";
  const tabIds = [...tabList.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1]));
  if (tabIds.length > 0) {
    await t("切换标签页", () => tool("browser_switch_tab", { tabId: tabIds[0] }));
    await t("关闭标签页", () => tool("browser_close_tab", { tabId: tabIds[tabIds.length-1] }));
  } else {
    console.log("  ⚠️ 切换/关闭: 无法获取标签页ID");
    R.push({ name: "切换标签页", ok: false, detail: "无标签页ID" });
    R.push({ name: "关闭标签页", ok: false, detail: "无标签页ID" });
  }
  await t("刷新页面", () => tool("browser_reload"));
  await new Promise(r => setTimeout(r, 2000));

  // 5. 截图
  console.log("\n📸 5. 截图");
  await t("页面截图", () => tool("browser_screenshot"));

  // 6. Cookie/存储
  console.log("\n🍪 6. Cookie/存储");
  await t("全量Cookie", () => tool("browser_get_all_cookies").catch(() => ({ error: "n/a via extension" })));
  await t("JS Cookie", () => tool("browser_execute_stealth", { code: "document.cookie.slice(0,200)" }));
  await t("localStorage", () => tool("browser_execute_stealth", { code: "JSON.stringify(Object.keys(localStorage).slice(0,10))" }));

  // 7. 网络监控
  console.log("\n📡 7. 网络监控");
  await t("启动网络监控", () => tool("browser_start_network_monitor").catch(() => ({ error: "n/a" })));
  await tool("browser_scroll", { direction: "down", amount: 200 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  await t("获取网络日志", () => tool("browser_get_network_log", { count: 10 }).catch(() => ({ error: "n/a" })));

  // 8. 反爬分析
  console.log("\n🔬 8. 反爬分析");
  await t("DOM反爬分析", () => tool("browser_analyze_anti_crawl").catch(() => ({ error: "n/a" })));
  await t("CDP深度反爬", () => tool("browser_analyze_anti_crawl_deep").catch(() => ({ error: "n/a" })));

  // 9. 调试
  console.log("\n🎛️ 9. 调试");
  await t("控制台日志", () => tool("browser_get_console_logs").catch(() => ({ error: "n/a" })));
  await t("JS错误", () => tool("browser_get_js_errors").catch(() => ({ error: "n/a" })));
  await t("性能信息", () => tool("browser_get_performance"));
  await t("调试信息", () => tool("browser_get_debug_info").catch(() => ({ error: "n/a" })));

  // ═══ 汇总 ═══
  console.log("\n\n" + "=".repeat(55));
  console.log("📊 能力总评");
  console.log("=".repeat(55));
  
  const ok = R.filter(r => r.ok);
  const fail = R.filter(r => !r.ok);
  console.log(`\n✅ 可用: ${ok.length}/${R.length} (${(ok.length/R.length*100).toFixed(0)}%)`);
  console.log(`❌ 缺失/不稳定: ${fail.length}`);
  
  if (fail.length > 0) {
    console.log(`\n⚠️ 不稳定的功能:`);
    fail.forEach(f => console.log(`  ${f.name}: ${f.detail}`));
  }

  console.log(`\n${"=".repeat(55)}`);
  console.log("🔍 识别到的缺失能力:");
  console.log("=".repeat(55));
  const gaps = [
    ["图片下载", "browser_download_image", "获取图片URL后下载到本地"],
    ["文件下载", "browser_download_file", "触发并保存文件下载"],
    ["弹窗处理", "browser_handle_dialog", "alert/confirm/prompt 对话框"],
    ["文件上传", "browser_file_upload", "向 input[type=file] 上传文件"],
    ["广告识别", "browser_detect_ads", "识别并报告页面广告元素"],
    ["广告屏蔽", "browser_block_ads", "隐藏/移除广告"],
    ["Cookie注入", "browser_set_cookie", "设置/修改 Cookie"],
    ["iframe支持", "browser_get_frames", "获取并操作 iframe 内容"],
    ["元素截图", "browser_screenshot_element", "截取指定元素"],
    ["下载管理", "browser_list_downloads", "查看和管理下载文件"],
    ["登录流程", "—", "多步登录（验证码、OAuth、扫码）"],
    ["数据导出", "—", "页面数据导出为 JSON/CSV"],
  ];
  
  console.log(`\n目前已覆盖 35+ 项功能，识别到 ${gaps.length} 个可补充的能力:\n`);
  gaps.forEach(([name, tool, desc], i) => {
    console.log(`  ${i+1}. ${tool || name}`);
    console.log(`     ${desc}`);
  });

  console.log(`\n💡 建议优先补充: 弹窗处理 → Cookie注入 → 广告识别`);
  
  server.kill();
  process.exit(0);
}

main().catch(e => { console.error(e); server.kill(); process.exit(1); });
