// 验证 Agent_WebView 连接并测试基本功能
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:9134");

ws.on("open", () => {
  console.log("✅ 已连接到 MCP Server WebSocket\n");
  testAll();
});

let msgId = 1;
const pending = new Map();

ws.on("message", (raw) => {
  try {
    const resp = JSON.parse(raw.toString());
    if (resp.msgId && pending.has(resp.msgId)) {
      const { resolve, label } = pending.get(resp.msgId);
      pending.delete(resp.msgId);
      if (resp.error) {
        console.log(`  ❌ ${label}: ${resp.error}`);
      } else {
        console.log(`  ✅ ${label}`);
        resolve(resp);
      }
    }
  } catch(e) {}
});

function send(cmd) {
  return new Promise((resolve) => {
    const id = Date.now() + "_" + (msgId++);
    pending.set(id, { resolve, label: cmd.label || cmd.type });
    ws.send(JSON.stringify({ ...cmd, msgId: id }));
  });
}

async function testAll() {
  // 1. 检查连接
  console.log("📋 测试 1: check_connection");
  await send({ type: "check_connection", label: "连接检查" });

  // 2. 获取当前页面信息
  console.log("\n📋 测试 2: 获取当前页面");
  const page = await send({ type: "get_all_data", label: "页面数据" });
  if (page.title) console.log(`   标题: ${page.title}`);
  if (page.url) console.log(`   URL: ${page.url}`);
  if (page.links) console.log(`   链接: ${page.links.length} 个`);
  if (page.images) console.log(`   图片: ${page.images.length} 张`);

  // 3. Cookie
  console.log("\n📋 测试 3: Cookie");
  const ck = await send({ type: "get_cookies", label: "Cookie获取" });
  if (ck.cookies) console.log(`   ${ck.cookies.length} 个 Cookie`);

  // 4. 反爬分析
  console.log("\n📋 测试 4: 反爬分析");
  const ac = await send({ type: "analyze_anti_crawl", label: "反爬分析" });
  if (ac.analysis?.summary) {
    ac.analysis.summary.forEach(s => console.log(`   ${s}`));
  }

  // 5. 页面布局
  console.log("\n📋 测试 5: 布局网格");
  const ev = await send({ type: "evaluate", code: `
    (function() {
      const els = Array.from(document.querySelectorAll('a[href], button, input')).slice(0,20);
      return JSON.stringify(els.map((e,i) => ({
        ref: i+1,
        tag: e.tagName,
        text: (e.textContent || e.placeholder || '').trim().slice(0,30)
      })));
    })()
  `, label: "布局网格" });
  if (ev.success && ev.result) {
    const items = JSON.parse(ev.result);
    items.slice(0, 8).forEach(item => console.log(`   [${item.ref}] <${item.tag}> ${item.text || '(无文字)'}`));
  }

  // 6. 网络监控
  console.log("\n📋 测试 6: 网络监控");
  await send({ type: "start_network_monitor", label: "启动网络监控" });
  await send({ type: "scroll", direction: "down", amount: 300, label: "滚动触发新请求" });
  await new Promise(r => setTimeout(r, 2000));
  const net = await send({ type: "get_network_log", count: 20, label: "网络日志" });
  if (net.logs) {
    const blocked = net.logs.filter(r => r.failed || (r.response?.status >= 400));
    console.log(`   总请求: ${net.logs.length}, 异常: ${blocked.length}`);
    blocked.slice(0, 3).forEach(r => console.log(`   ⚠️ ${r.response?.status || '失败'} ${(r.url||'').slice(0,80)}`));
  }

  console.log("\n" + "=".repeat(45));
  console.log("✅ 测试完成！所有功能正常。");
  console.log("=".repeat(45));
  
  ws.close();
  process.exit(0);
}
