#!/bin/bash

# format.sh - 文件编辑后自动格式化脚本
# 此脚本由 Cursor 的 afterFileEdit hook 调用，用于自动格式化代码文件

# 从标准输入读取 JSON 输入
input=$(cat)

# 从 JSON 输入中解析文件路径
file_path=$(echo "$input" | jq -r '.file_path // empty')

# 如果没有文件路径，退出
if [ -z "$file_path" ]; then
  exit 0
fi

# 获取文件扩展名
file_ext="${file_path##*.}"

# 定义需要格式化的文件类型
formattable_extensions=("js" "jsx" "ts" "tsx" "json" "sql" "md")

# 检查文件是否需要格式化
should_format=false
for ext in "${formattable_extensions[@]}"; do
  if [ "$file_ext" = "$ext" ]; then
    should_format=true
    break
  fi
done

# 如果文件不需要格式化，直接退出
if [ "$should_format" = false ]; then
  exit 0
fi

# 检查文件是否存在
if [ ! -f "$file_path" ]; then
  exit 0
fi

# 获取项目根目录（hooks.json 所在目录的父目录）
project_root="$(cd "$(dirname "$0")/../.." && pwd)"

# 切换到项目根目录
cd "$project_root" || exit 0

# 检查 prettier 是否可用
if ! command -v prettier &> /dev/null; then
  # 尝试使用 pnpm 运行 prettier
  if command -v pnpm &> /dev/null; then
    pnpm exec prettier --write "$file_path" > /dev/null 2>&1
  elif command -v npx &> /dev/null; then
    npx prettier --write "$file_path" > /dev/null 2>&1
  fi
else
  # 直接运行 prettier
  prettier --write "$file_path" > /dev/null 2>&1
fi

# 成功退出
exit 0

