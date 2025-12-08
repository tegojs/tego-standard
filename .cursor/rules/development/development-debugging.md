---
description: Debugging guidelines - debug logging with timestamps (Mandatory Rule)
globs:
  - packages/**/*.ts
  - packages/**/*.tsx
  - apps/**/*.ts
alwaysApply: true
---

# Debugging Guidelines / 调试指南

## Debug Logging / 调试日志

- **Mandatory Rule / 必须规则**: When adding debug logs, **MUST** include timestamp information.
- **必须规则**：添加调试日志时，**必须**包含时间戳信息
- Use ISO 8601 format timestamps for consistency.
- 使用 ISO 8601 格式的时间戳

## Debug Log Format / 调试日志格式

- Format: `[${timestamp}] [标签] 消息内容`
- Use `new Date().toISOString()` to generate timestamps.

## Example / 示例

```typescript
// ❌ Wrong - No timestamp / 错误 - 没有时间戳
console.log('[轮询调试] queryFieldList 被调用');

// ✅ Correct - With timestamp / 正确 - 有时间戳
const timestamp = new Date().toISOString();
console.log(`[${timestamp}] [轮询调试] queryFieldList 被调用`);
```
