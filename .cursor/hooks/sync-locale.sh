#!/bin/bash

# sync-locale.sh - 检测 locale 文件编辑并提醒 AI 同步翻译
# 此脚本由 Cursor 的 afterFileEdit hook 调用
# 注意：虽然 hook 会在所有文件编辑后触发，但此脚本会立即检查并只处理 locale 文件

# 从标准输入读取 JSON 输入
input=$(cat)

# 快速检查：如果没有输入，立即退出
if [ -z "$input" ]; then
  exit 0
fi

# 快速检查：解析文件路径（如果 jq 不可用，尝试简单提取）
if command -v jq &> /dev/null; then
  file_path=$(echo "$input" | jq -r '.file_path // empty' 2>/dev/null)
else
  # 简单的 JSON 路径提取（作为后备方案）
  file_path=$(echo "$input" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
fi

# 快速退出：如果没有文件路径，立即退出
if [ -z "$file_path" ]; then
  exit 0
fi

# 快速退出：检查文件路径是否包含 locale 目录（这是最关键的检查）
# 如果不是 locale 文件，立即退出，不执行任何后续操作
if [[ ! "$file_path" =~ /locale/ ]]; then
  exit 0
fi

# 快速退出：检查文件扩展名（只处理 JSON 和 TypeScript）
file_ext="${file_path##*.}"
if [ "$file_ext" != "json" ] && [ "$file_ext" != "ts" ]; then
  exit 0
fi

# 快速退出：检查文件是否存在
if [ ! -f "$file_path" ]; then
  exit 0
fi

# 获取文件所在目录和文件名
file_dir=$(dirname "$file_path")
file_name=$(basename "$file_path")

# 查找同目录下的其他语言文件
other_lang_files=$(find "$file_dir" -maxdepth 1 -type f \( -name "*.json" -o -name "*.ts" \) ! -name "$file_name" 2>/dev/null | wc -l)

# 如果有其他语言文件，输出提示信息（AI 可以看到）
if [ "$other_lang_files" -gt 0 ]; then
  echo "⚠️  检测到 locale 文件编辑: $file_path"
  echo "📝 请检查并同步新增的翻译键到同目录下的所有语言文件:"
  find "$file_dir" -maxdepth 1 -type f \( -name "*.json" -o -name "*.ts" \) ! -name "$file_name" 2>/dev/null | while read -r lang_file; do
    echo "   - $(basename "$lang_file")"
  done
fi

# 成功退出
exit 0
