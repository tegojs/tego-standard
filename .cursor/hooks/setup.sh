#!/bin/bash

# setup.sh - 快速设置 Cursor Hooks 的脚本
# 将项目中的 hooks 配置复制到用户主目录

set -e

# 获取脚本所在目录（项目 .cursor 目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 用户主目录的 .cursor 目录
USER_CURSOR_DIR="$HOME/.cursor"
USER_HOOKS_DIR="$USER_CURSOR_DIR/hooks"

echo "正在设置 Cursor Hooks..."
echo "项目目录: $PROJECT_ROOT"
echo "目标目录: $USER_CURSOR_DIR"

# 创建用户主目录的 .cursor 目录
mkdir -p "$USER_HOOKS_DIR"

# 复制 hooks.json
if [ -f "$SCRIPT_DIR/../hooks.json" ]; then
  cp "$SCRIPT_DIR/../hooks.json" "$USER_CURSOR_DIR/hooks.json"
  echo "✓ 已复制 hooks.json 到 $USER_CURSOR_DIR/hooks.json"
else
  echo "✗ 未找到 hooks.json"
  exit 1
fi

# 复制格式化脚本
if [ -f "$SCRIPT_DIR/format.sh" ]; then
  cp "$SCRIPT_DIR/format.sh" "$USER_HOOKS_DIR/format.sh"
  chmod +x "$USER_HOOKS_DIR/format.sh"
  echo "✓ 已复制 format.sh 到 $USER_HOOKS_DIR/format.sh"
else
  echo "✗ 未找到 format.sh"
  exit 1
fi

# 复制翻译同步脚本
if [ -f "$SCRIPT_DIR/sync-locale.sh" ]; then
  cp "$SCRIPT_DIR/sync-locale.sh" "$USER_HOOKS_DIR/sync-locale.sh"
  chmod +x "$USER_HOOKS_DIR/sync-locale.sh"
  echo "✓ 已复制 sync-locale.sh 到 $USER_HOOKS_DIR/sync-locale.sh"
else
  echo "✗ 未找到 sync-locale.sh"
  exit 1
fi

echo ""
echo "设置完成！"
echo ""
echo "下一步："
echo "1. 重启 Cursor 以使 hooks 生效"
echo "2. 在 Cursor 设置的 Hooks 选项卡中查看已配置的 hooks"
echo "3. 编辑任何支持的文件后，会自动运行代码格式化"
echo "4. 编辑 locale 文件夹下的文件后，会自动同步新增的翻译键到所有语言包"
echo ""
echo "支持的文件类型：.js, .jsx, .ts, .tsx, .json, .sql, .md"
echo "翻译同步：支持 .json 和 .ts 格式的 locale 文件"

