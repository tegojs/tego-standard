#!/bin/bash

# 检查后端日志的脚本

echo "=== 检查后端日志 ==="
echo ""

# 1. 检查 Electron 日志
echo "1. Electron 应用日志:"
ELECTRON_LOG="$HOME/Library/Logs/Tachybase/tachybase.log"
if [ -f "$ELECTRON_LOG" ]; then
    echo "   找到日志文件: $ELECTRON_LOG"
    echo "   最后 50 行:"
    tail -50 "$ELECTRON_LOG" | grep -E "Backend|plugin|tego|error|Error|failed|Failed" | tail -20
else
    echo "   ⚠ 日志文件不存在: $ELECTRON_LOG"
fi

echo ""

# 2. 检查后端进程
echo "2. 后端进程状态:"
if pgrep -f "tego.*start" > /dev/null; then
    echo "   ✓ tego 进程正在运行"
    ps aux | grep -E "tego|node.*tego" | grep -v grep | head -3
else
    echo "   ✗ tego 进程未运行"
fi

echo ""

# 3. 检查端口
echo "3. 端口 30000 状态:"
if lsof -i :30000 > /dev/null 2>&1; then
    echo "   ✓ 端口 30000 已被占用"
    lsof -i :30000 | head -3
else
    echo "   ✗ 端口 30000 未被占用"
fi

echo ""

# 4. 检查 wrapper 脚本
echo "4. Wrapper 脚本状态:"
WRAPPER_PATH="$HOME/Projects/workProject/tegojs/tego-standard/apps/desktop/scripts/prepare-backend/tego-wrapper.js"
if [ -f "$WRAPPER_PATH" ]; then
    echo "   ✓ Wrapper 脚本存在: $WRAPPER_PATH"
else
    echo "   ✗ Wrapper 脚本不存在: $WRAPPER_PATH"
fi

echo ""

# 5. 检查 backend-temp 目录
echo "5. Backend 临时目录:"
BACKEND_TEMP="$HOME/Projects/workProject/tegojs/tego-standard/apps/desktop/backend-temp"
if [ -d "$BACKEND_TEMP" ]; then
    echo "   ✓ Backend 临时目录存在"
    if [ -f "$BACKEND_TEMP/scripts/tego-wrapper.js" ]; then
        echo "   ✓ Wrapper 脚本已复制到 backend-temp"
    else
        echo "   ✗ Wrapper 脚本未复制到 backend-temp"
    fi
    if [ -d "$BACKEND_TEMP/packages/@tachybase" ]; then
        echo "   ✓ @tachybase 目录结构存在"
        echo "   插件符号链接:"
        ls -la "$BACKEND_TEMP/packages/@tachybase" | head -5
    else
        echo "   ✗ @tachybase 目录结构不存在"
    fi
else
    echo "   ✗ Backend 临时目录不存在"
fi

echo ""
echo "=== 检查完成 ==="
