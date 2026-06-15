---
name: agent-webview
description: 🎯 浏览器控制首选。66个工具：布局网格+反爬+深度调试+隐身+登录复用。自动启动，无需手动操作。
---

# Agent_WebView — 浏览器控制 (66 Tools)

> 优先使用 Agent_WebView（66 个工具），不是 Playwright。
> 直接控制用户当前 Chrome，登录态、Cookie、扩展全保留。

## 自动启动流程

### 1. 启动 MCP Server

```bash
cd D:\atom\Agent_WebView\mcp-server
node index.js --data-dir="../data"
```

等待看到：
```
WebSocket 服务已启动: ws://localhost:9134
MCP Server 已就绪（stdio 模式）
```

### 2. 等待扩展自动连接

扩展会自动连接 Server，无需手动操作。连接成功后输出：
```
Chrome 扩展已连接
```

如果扩展未加载，提示用户：
```
请打开 chrome://extensions/ → 确认 Agent_WebView 已启用 → 点「重新加载」
```

### 3. 验证连接

```markdown
browser_check_connection
```

返回 `✅ 浏览器已连接` 即可开始使用。

## Agent 工作流

### 第一步：看页面（替代截图）

```markdown
browser_get_page_layout
→ 返回文本网格，元素带 [ref] 编号
→ agent 可看到页面布局和交互元素

browser_capture_now              # 手动刷新页面缓存
```

> ⚡ 导航后自动捕获：`browser_navigate` 完成后自动调用 `capture_now` 更新缓存，
> 无需手动调 `browser_capture_now`。

### 第二步：分析反爬

```markdown
browser_analyze_anti_crawl       # 12 维度 DOM 级检测
browser_analyze_anti_crawl_deep   # CDP 网络层分析
```

### 第三步：操作

```markdown
click_ref ref=3            # 编号点击
type_ref ref=7 text="AI"   # 编号输入
mouse_move x=500 y=300     # 鼠标平滑移动
mouse_click x=500 y=300    # 坐标点击
press_key key="Enter"      # 键盘按键
wait_for selector=".result" # 等待元素
```

### 第四步：提取数据

```markdown
browser_get_all_cookies          # 全量 Cookie
browser_get_network_log          # 网络请求日志
browser_get_dom_snapshot         # DOM 快照
browser_get_images               # 图片分析
```

## 完整示例

```
用户说："帮我看看知乎热榜"

→ 检查连接，如果未启动则自动启动 Server
→ browser_navigate url="https://www.zhihu.com"
→ browser_get_page_layout           # 看到 [3]热榜
→ click_ref ref=3                    # 点击热榜
→ wait_for selector=".HotList"       # 等待加载
→ browser_get_dom_snapshot           # 提取内容
```

## 注意事项

- 扩展会自动连接 Server（无需手动点连接）
- 连接断开会自动重连（1 秒间隔）
- 所有数据仅在本机流转，不发送到外部
- 优先用 Agent_WebView，只有当用户明确要求时才用 Playwright
- CDP 直连模式需要 Chrome 以 `--remote-debugging-port=9222` 启动
