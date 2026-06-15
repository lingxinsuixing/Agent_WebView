# Agent_WebView

让 AI Agent 直接控制你的 Chrome 浏览器。**66 个工具**，覆盖页面分析、空间布局、反爬对抗、网络监控、隐身采集。

无需 Playwright，无需重启浏览器，直接复用你当前的登录态。

```
Agent_WebView/
├── extension/          # Chrome 扩展
│   ├── manifest.json
│   ├── background.js   # Service Worker（自动连接 + 心跳保活）
│   ├── content.js      # 内容脚本（按需注入）
│   ├── panel.html/js   # 侧面板 UI
│   └── icons/
├── mcp-server/         # MCP 服务端 (66 tools)
│   ├── index.js
│   ├── cdp-client.js
│   └── package.json
├── start.bat           # Windows 启动
├── start.sh            # Linux/Mac 启动
└── README.md
```

## 快速开始

### 扩展模式（推荐）

```bash
# 1. 加载扩展
chrome://extensions/ → 加载已解压的扩展 → 选择 D:\atom\Agent_WebView\extension

# 2. 启动 MCP Server
cd D:\atom\Agent_WebView\mcp-server
node index.js --data-dir="../data"

# 3. 扩展自动连接，无需手动操作
```

### CDP 直连模式（服务器/无界面环境）

```bash
# 1. 启动 Chrome 调试端口
chrome --remote-debugging-port=9222

# 2. 启动 MCP Server（CDP 模式）
node index.js --cdp --data-dir="../data"
```

## 66 个工具

| 分类 | 工具数 | 功能 |
|------|--------|------|
| 🗺️ 布局网格 | 3 | `get_page_layout` / `click_ref` / `type_ref` |
| 📋 页面信息 | 6 | 标题/全文/文章/DOM快照/主动捕获 |
| 🖼️ 图片分析 | 2 | 图片详情/核心图片分析 |
| 🔗 结构提取 | 6 | 链接/标题/表格/表单(含独立搜索框)/选中文本 |
| 💾 存储调试 | 10 | Cookie/storage/控制台/JS错误/调试/性能 |
| 🎯 CDP深度 | 10 | 网络监控/全量Cookie/隐身JS/反爬 |
| 🖱️ DOM操作 | 14 | 元素/点击/输入/鼠标/键盘/等待/高亮/滚动 |
| 🌐 标签页 | 9 | 导航/标签管理/截图/前进后退 |
| 🔌 实用 | 3 | 连接检查/反爬分析/主动捕获 |
| 🆕 新增 | 3 | `get_form_cache`/`get_table_cache`/`set_input_value` |

## 核心特性

### ⚡ 导航后自动捕获
`browser_navigate` 完成后**自动刷新页面缓存**（pageCache），无需手动调用 `browser_capture_now`。

### 🔍 独立搜索框识别
支持检测不在 `<form>` 标签内的搜索框（知乎、百度、B站等），`get_page_layout` 中也会标注。

### 🖥️ 侧面板调试
扩展附带侧面板（F12 → 侧面板 → Agent_WebView），实时显示：
- 页面标题/URL/文本量
- Cookie 数量
- 图片数
- 链接数
- 表格/表单数

## Agent 工作流：看 → 分析 → 操作 → 提取

```markdown
1. browser_navigate url="..."   → 导航（自动刷新缓存）
2. browser_get_page_layout      → 页面文本网格 + [ref] 编号
3. browser_analyze_anti_crawl   → 反爬检测
4. click_ref / type_ref         → 通过编号操作
5. browser_get_dom_snapshot     → 提取数据
6. browser_get_all_cookies      → 获取登录态
```

## 隐身特性

- `navigator.webdriver = false`
- 无 content script 自动注入
- CDP 不留下 JS 可检测痕迹
- 鼠标模拟使用 ease-out 曲线
- CDP 直连模式下无任何扩展特征

## 连接稳定性

- 自动连接：扩展启动即连接 MCP Server
- 心跳保活：每 15 秒发送心跳，防止 Service Worker 休眠
- 快速重连：断开后 1 秒自动重连
- 无需手动点击连接

## 跨平台

| 平台 | 扩展模式 | CDP 模式 | 启动脚本 |
|------|---------|---------|---------|
| Windows | ✅ | ✅ | `start.bat` |
| Linux | ✅ | ✅ | `start.sh` |
| macOS | ✅ | ✅ | `start.sh` |

MCP Server 是 Node.js 应用，全平台通用。

## MCP 配置

```json
{
  "mcpServers": {
    "Agent_WebView": {
      "command": "node",
      "args": ["path/to/index.js", "--data-dir", "path/to/data"],
      "timeout_ms": 30000
    }
  }
}
```

支持：AtomCode、Claude Code、Cursor、Windsurf、Continue 等所有 MCP 兼容客户端。

## 启动脚本

### Windows（start.bat）

```batch
@echo off
cd /d %~dp0
start "MCP Server" cmd /k "cd mcp-server && node index.js --data-dir="../data"
echo MCP Server 已启动，扩展会自动连接...
```

### Linux/Mac（start.sh）

```bash
#!/bin/bash
cd "$(dirname "$0")/mcp-server"
node index.js --data-dir="../data" &
echo "MCP Server 已启动，扩展会自动连接..."
```

## 测试状态

```
压力测试：6 网站 × 8 项目 × 3 轮 = 97.8% ✅
高级测试：5 网站 × 4 项目 = 100% ✅
稳定性评估：🟢 优秀
```

## 开源许可

MIT
