const fs = require('fs');
const path = '/Users/bai/Library/Logs/Tachybase/tachybase.log';

// 读取日志文件
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n').filter((l) => l.trim());

// 获取当前时间（UTC）
const now = new Date();
const threeMinutesAgo = new Date(now.getTime() - 3 * 60 * 1000);

console.log('当前时间 (UTC):', now.toISOString());
console.log('3分钟前 (UTC):', threeMinutesAgo.toISOString());
console.log('\n分析最近3分钟内的日志...\n');

// 解析时间戳并筛选最近3分钟的日志
const recentLogs = [];
for (const line of lines) {
  const match = line.match(/^\[([^\]]+)\]/);
  if (match) {
    try {
      const timestamp = new Date(match[1]);
      if (!isNaN(timestamp.getTime()) && timestamp >= threeMinutesAgo) {
        recentLogs.push({ timestamp, line });
      }
    } catch (e) {
      // 忽略无法解析的时间戳
    }
  }
}

console.log(`找到 ${recentLogs.length} 条最近3分钟内的日志\n`);

if (recentLogs.length === 0) {
  console.log('没有找到最近3分钟内的日志，显示最后20条日志：\n');
  lines.slice(-20).forEach((l) => console.log(l));
  process.exit(0);
}

// 分析错误和关键信息
const errors = [];
const warnings = [];
const electronLogs = [];
const backendLogs = [];
const gatewayLogs = [];
const maintainingLogs = [];
const moduleNotFoundLogs = [];

for (const { timestamp, line } of recentLogs) {
  if (line.includes('[Electron]')) {
    electronLogs.push(line);
  }
  if (line.includes('[Backend Server]')) {
    backendLogs.push(line);
    if (line.includes('error') || line.includes('Error') || line.includes('Cannot find module')) {
      errors.push(line);
    }
    if (line.includes('warn')) {
      warnings.push(line);
    }
    if (line.includes('Gateway')) {
      gatewayLogs.push(line);
    }
    if (line.includes('maintaining')) {
      maintainingLogs.push(line);
    }
    if (line.includes('Cannot find module')) {
      moduleNotFoundLogs.push(line);
    }
  }
}

console.log('=== Electron 日志 ===');
electronLogs.forEach((l) => console.log(l));

console.log('\n=== 后端错误 ===');
if (errors.length > 0) {
  errors.forEach((e) => console.log(e));
} else {
  console.log('无错误');
}

console.log('\n=== 模块未找到错误 ===');
if (moduleNotFoundLogs.length > 0) {
  moduleNotFoundLogs.forEach((e) => console.log(e));
} else {
  console.log('无模块未找到错误');
}

console.log('\n=== 后端警告 ===');
if (warnings.length > 0) {
  warnings.slice(-10).forEach((w) => console.log(w));
} else {
  console.log('无警告');
}

console.log('\n=== Gateway 相关日志 ===');
if (gatewayLogs.length > 0) {
  gatewayLogs.forEach((g) => console.log(g));
} else {
  console.log('无 Gateway 启动日志（这可能表示 Gateway 未启动）');
}

console.log('\n=== Maintaining 状态日志 ===');
if (maintainingLogs.length > 0) {
  maintainingLogs.forEach((m) => console.log(m));
} else {
  console.log('无 maintaining 状态日志');
}

console.log('\n=== 最后10条后端日志 ===');
backendLogs.slice(-10).forEach((l) => console.log(l));

// 总结
console.log('\n=== 问题总结 ===');
if (moduleNotFoundLogs.length > 0) {
  console.log('❌ 发现模块未找到错误，这可能导致后端无法完全启动');
}
if (gatewayLogs.length === 0) {
  console.log('⚠️  未发现 Gateway 启动日志，Gateway 可能未启动');
}
if (maintainingLogs.length > 0) {
  console.log('⚠️  发现 maintaining 状态，后端可能还在启动中');
}
if (errors.length === 0 && gatewayLogs.length > 0) {
  console.log('✓ 未发现错误，Gateway 已启动');
}
