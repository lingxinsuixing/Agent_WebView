@echo off
chcp 65001 >nul
echo ============================================
echo  Agent_WebView — 快速启动
echo ============================================
echo.
echo 选择模式：
echo  1 - CDP直连 + 加载扩展（推荐）
echo  2 - 仅 MCP Server（等扩展手动连接）
echo  3 - Playwright MCP + 扩展
echo.

set EXT_DIR="D:\atom\Agent_WebView\extension"
set PROFILES_DIR="D:\atom\Agent_WebView\profiles\default"
set DATA_DIR="D:\atom\Agent_WebView\data"
set MCP_DIR="D:\atom\Agent_WebView\mcp-server"
set CHROME_PATH="C:\Program Files\Google\Chrome Dev\Application\chrome.exe"

set /p mode="请选择 (1/2/3): "

if "%mode%"=="1" (
  echo.
  echo 正在启动 Chrome（调试端口 + 扩展已加载）...
  start "" %CHROME_PATH% ^
    --remote-debugging-port=9222 ^
    --load-extension=%EXT_DIR% ^
    --user-data-dir=%PROFILES_DIR% ^
    --disable-extensions-except=%EXT_DIR% ^
    --no-first-run
  echo.
  echo 启动 MCP Server（CDP模式）...
  cd /d %MCP_DIR%
  start "Agent_WebView MCP" cmd /c "node index.js --cdp --data-dir=%DATA_DIR%"
  echo.
  echo ✅ Chrome 已启动，扩展已加载
  echo ✅ MCP Server 运行中 (51 tools)
  echo.
  pause
)

if "%mode%"=="2" (
  echo.
  echo 启动 MCP Server（等扩展手动连接）...
  cd /d %MCP_DIR%
  node index.js --data-dir=%DATA_DIR%
  pause
)

if "%mode%"=="3" (
  echo.
  echo 启动 Playwright MCP（持久配置 + 扩展需手动安装一次）...
  echo.
  echo 首次使用：浏览器打开后，请手动安装扩展：
  echo   chrome://extensions/ → 开发者模式 → 加载 %EXT_DIR%
  echo.
  pause
  npx @playwright/mcp@latest ^
    --browser chrome ^
    --user-data-dir="D:\atom\playwright-data" ^
    --caps vision,devtools
)

echo.
pause
