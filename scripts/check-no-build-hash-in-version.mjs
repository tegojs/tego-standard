import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function getStagedPackageJsonFiles() {
  const output = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' });
  return output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((p) => p && p.endsWith('package.json'));
}

function hasBuildHashVersion(version) {
  if (typeof version !== 'string') return false;
  // 匹配形如 1.0.0-abcdef0 或 1.0.0-abcdef0@branch 的尾部哈希
  // 允许正常的预发布版本（如 -alpha.1、-rc.0 等）
  const buildHashPattern = /-[0-9a-f]{7}(?:@[^\s"']+)?$/i;
  return buildHashPattern.test(version);
}

function main() {
  const files = getStagedPackageJsonFiles();
  const offenders = [];

  for (const file of files) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf-8'));
      const version = json?.version;
      if (hasBuildHashVersion(version)) {
        offenders.push({ file, version });
      }
    } catch (e) {
      // ignore parse errors; lint-staged/prettier will handle
    }
  }

  if (offenders.length) {
    console.error('✖ 阻止提交：检测到包含 hash 的版本号');
    for (const o of offenders) {
      console.error(`   - ${o.file}: version=${o.version}`);
    }
    console.error('✅ 解决方法：\n   还原 package.json 的版本号为不带 hash 的基础版本，如 1.3.25');
    process.exit(1);
  }
}

main();
