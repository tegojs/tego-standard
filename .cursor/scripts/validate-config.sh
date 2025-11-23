#!/bin/bash

# Cursor Configuration Validation Script
# 验证 Cursor 配置文件的正确性

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CURSOR_DIR="$PROJECT_ROOT/.cursor"

echo "🔍 Validating Cursor configuration..."
echo ""

# 检查必需文件
required_files=(
  "$CURSOR_DIR/cli.json"
  "$CURSOR_DIR/skill-rules.json"
  "$CURSOR_DIR/rules/index.md"
  "$CURSOR_DIR/worktrees.json"
)

missing_files=0
for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "❌ Missing required file: $file"
    missing_files=$((missing_files + 1))
  else
    echo "✅ Found: $(basename "$file")"
  fi
done

if [ $missing_files -gt 0 ]; then
  echo ""
  echo "❌ Validation failed: $missing_files required file(s) missing"
  exit 1
fi

# 检查 JSON 格式
echo ""
echo "🔍 Validating JSON files..."

if command -v jq &> /dev/null; then
  json_files=(
    "$CURSOR_DIR/cli.json"
    "$CURSOR_DIR/skill-rules.json"
    "$CURSOR_DIR/worktrees.json"
  )

  json_errors=0
  for file in "${json_files[@]}"; do
    if jq empty "$file" 2>/dev/null; then
      echo "✅ Valid JSON: $(basename "$file")"
    else
      echo "❌ Invalid JSON: $(basename "$file")"
      json_errors=$((json_errors + 1))
    fi
  done

  if [ $json_errors -gt 0 ]; then
    echo ""
    echo "❌ Validation failed: $json_errors JSON file(s) have errors"
    exit 1
  fi
else
  echo "⚠️  jq not found, skipping JSON validation"
  echo "   Install jq for JSON validation: brew install jq (macOS) or apt-get install jq (Linux)"
fi

# 检查规则文件是否有 frontmatter
echo ""
echo "🔍 Checking rule files for frontmatter..."

rule_files=$(find "$CURSOR_DIR/rules" -name "*.md" -type f ! -name "index.md")
frontmatter_missing=0

for file in $rule_files; do
  if head -n 1 "$file" | grep -q "^---"; then
    echo "✅ Has frontmatter: $(basename "$file")"
  else
    echo "⚠️  Missing frontmatter: $(basename "$file")"
    frontmatter_missing=$((frontmatter_missing + 1))
  fi
done

if [ $frontmatter_missing -gt 0 ]; then
  echo ""
  echo "⚠️  Warning: $frontmatter_missing rule file(s) missing frontmatter"
  echo "   Consider adding YAML frontmatter for better Cursor integration"
else
  echo ""
  echo "✅ All rule files have frontmatter"
fi

# 检查 hooks 配置
echo ""
echo "🔍 Checking hooks configuration..."

if [ -f "$CURSOR_DIR/hooks.json" ]; then
  echo "✅ Found hooks.json"

  if [ -d "$CURSOR_DIR/hooks" ]; then
    hook_scripts=$(find "$CURSOR_DIR/hooks" -name "*.sh" -type f)
    if [ -n "$hook_scripts" ]; then
      echo "✅ Found hook scripts:"
      for script in $hook_scripts; do
        if [ -x "$script" ]; then
          echo "   ✅ Executable: $(basename "$script")"
        else
          echo "   ⚠️  Not executable: $(basename "$script")"
        fi
      done
    else
      echo "⚠️  No hook scripts found in hooks/ directory"
    fi
  else
    echo "⚠️  hooks/ directory not found"
  fi
else
  echo "⚠️  hooks.json not found (optional)"
fi

# 总结
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $missing_files -eq 0 ] && [ ${json_errors:-0} -eq 0 ]; then
  echo "✅ Configuration validation passed!"
  if [ $frontmatter_missing -gt 0 ]; then
    echo "⚠️  Some rule files are missing frontmatter (non-critical)"
  fi
  exit 0
else
  echo "❌ Configuration validation failed!"
  exit 1
fi
