#!/bin/bash
# Agent_WebView — Linux/Mac 快速启动脚本

set -e

# ═══ 配置 ═══
EXT_DIR="$(cd "$(dirname "$0")/extension" && pwd)"
PROFILES_DIR="$(cd "$(dirname "$0")/profiles/default" 2>/dev/null || mkdir -p "$(dirname "$0")/profiles/default" && echo "$(cd "$(dirname "$0")/profiles/default" && pwd)")"
DATA_DIR="$(cd "$(dirname "$0")/data" 2>/dev/null || mkdir -p "$(dirname "$0")/data" && echo "$(cd "$(dirname "$0")/data" && pwd)")"
MCP_DIR="$(cd "$(dirname "$0")/mcp-server" && pwd)"

# 自动检测 Chrome/Chromium
detect_chrome() {
  if command -v google-chrome &>/dev/null; then
    echo "google-chrome"
  elif command -v google-chrome-stable &>/dev/null; then
    echo "google-chrome-stable"
  elif command -v chromium-browser &>/dev/null; then
    echo "chromium-browser"
  elif command -v chromium &>/dev/null; then
    echo "chromium"
  elif [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  else
    echo ""
  fi
}

CHROME=$(detect_chrome)

echo "============================================"
echo "  Agent_WebView — 快速启动"
echo "============================================"
echo ""
echo "Chrome: ${CHROME:-未检测到}"
echo "数据目录: $PROFILES_DIR"
echo ""

if [ -z "$CHROME" ]; then
  echo "❌ 未找到 Chrome/Chromium"
  echo "请安装 Chrome 或设置 CHROME_PATH 环境变量"
  echo "   export CHROME_PATH=/path/to/chrome"
  exit 1
fi

echo "选择模式："
echo "  1 - CDP直连 + 加载扩展（推荐）"
echo "  2 - 仅 MCP Server（等扩展手动连接）"
echo "  3 - Chrome 调试模式（仅启动浏览器）"
read -p "请选择 (1/2/3): " mode

case $mode in
  1)
    echo ""
    echo "正在启动 Chrome（调试端口 + 扩展已加载）..."
    mkdir -p "$PROFILES_DIR"
    "$CHROME" \
      --remote-debugging-port=9222 \
      --load-extension="$EXT_DIR" \
      --user-data-dir="$PROFILES_DIR" \
      --no-first-run \
      --new-window "about:blank" &
    echo "Chrome PID: $!"
    echo ""
    echo "启动 MCP Server（CDP模式）..."
    cd "$MCP_DIR"
    node index.js --cdp --data-dir="$DATA_DIR"
    ;;
  2)
    echo ""
    echo "启动 MCP Server（等扩展手动连接）..."
    cd "$MCP_DIR"
    node index.js --data-dir="$DATA_DIR"
    ;;
  3)
    echo ""
    echo "启动 Chrome 调试模式..."
    mkdir -p "$PROFILES_DIR"
    "$CHROME" \
      --remote-debugging-port=9222 \
      --load-extension="$EXT_DIR" \
      --user-data-dir="$PROFILES_DIR" \
      --no-first-run \
      --new-window "about:blank" &
    echo "Chrome PID: $!"
    echo ""
    echo "然后手动启动 MCP Server:"
    echo "  cd $MCP_DIR && node index.js --cdp --data-dir=\"$DATA_DIR\""
    ;;
  *)
    echo "无效选项"
    exit 1
    ;;
esac
