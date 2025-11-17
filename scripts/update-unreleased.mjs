#!/usr/bin/env node
/**
 * 自动更新 CHANGELOG 的 [Unreleased] 部分
 * 从最新 tag 到 HEAD 的所有 commits 会被添加到 [Unreleased] 部分
 *
 * 使用方法：
 *   node scripts/update-unreleased.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const changelogENPath = join(rootDir, 'CHANGELOG.md');
const changelogZHPath = join(rootDir, 'CHANGELOG.zh-CN.md');

// 解析 commit 消息
function parseCommit(commit) {
  const { subject } = commit;
  if (!subject) {
    return null;
  }

  // Conventional Commits 格式: type(scope): description
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) {
    return null;
  }

  const [, type, scope, breaking, description] = match;
  const isBreaking = !!breaking || commit.body?.includes('BREAKING CHANGE');

  return {
    type: type.toLowerCase(),
    scope: scope || '',
    description: description.trim(),
    body: commit.body || '',
    isBreaking,
  };
}

// 获取两个版本之间的 commits
function getCommitsSinceLatestTag() {
  try {
    // 获取最新的 tag
    let latestTag;
    try {
      latestTag = execSync('git describe --tags --abbrev=0', {
        encoding: 'utf-8',
        cwd: rootDir,
      }).trim();
    } catch {
      // 如果没有 tag，从第一个 commit 开始
      const firstCommit = execSync('git rev-list --max-parents=0 HEAD', {
        encoding: 'utf-8',
        cwd: rootDir,
      }).trim();
      latestTag = firstCommit;
    }

    const range = `${latestTag}..HEAD`;
    const logFormat = '%H|%s|%b';
    const output = execSync(`git log ${range} --pretty=format:"${logFormat}" --no-merges`, {
      encoding: 'utf-8',
      cwd: rootDir,
    }).trim();

    if (!output) {
      return [];
    }

    const commits = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|');
        const hash = parts[0] || '';
        const subject = parts[1] || '';
        const body = parts.slice(2).join('|').trim();
        return { hash, subject, body };
      })
      .filter((commit) => commit.hash && commit.subject);

    return commits;
  } catch (error) {
    console.warn('Warning: Could not get commits:', error.message);
    return [];
  }
}

// 分组 commits
function groupCommits(commits) {
  const grouped = {
    feat: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    fix: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    docs: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    style: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    refactor: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    perf: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    test: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    build: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    ci: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    chore: /** @type {Array<string | {type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    revert: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
    breaking: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string}>} */ ([]),
  };

  commits.forEach((commit) => {
    const parsed = parseCommit(commit);
    if (!parsed) {
      grouped.chore.push(commit.subject);
      return;
    }

    if (parsed.isBreaking) {
      grouped.breaking.push({
        ...parsed,
        full: commit.subject,
      });
    }

    const type = parsed.type;
    if (grouped[type]) {
      grouped[type].push({
        ...parsed,
        full: commit.subject,
      });
    } else {
      grouped.chore.push(commit.subject);
    }
  });

  return grouped;
}

// 去除重复的行（保留第一次出现）
function deduplicateContent(content) {
  const contentLines = content.split('\n');
  const seen = new Set();
  const deduplicatedLines = [];

  for (const line of contentLines) {
    // 对于列表项（以 "- " 开头），检查是否重复
    if (line.trim().startsWith('- ')) {
      const normalized = line.trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        deduplicatedLines.push(line);
      }
    } else {
      // 非列表项（标题、空行等）直接保留
      deduplicatedLines.push(line);
    }
  }

  return deduplicatedLines.join('\n');
}

// 生成 Unreleased 部分的英文内容
function generateUnreleasedContentEN(grouped) {
  const lines = [];

  // Breaking changes
  if (grouped.breaking.length > 0) {
    lines.push('### ⚠️ Breaking Changes', '');
    grouped.breaking.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Added
  if (grouped.feat.length > 0) {
    lines.push('### Added', '');
    grouped.feat.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Fixed
  if (grouped.fix.length > 0) {
    lines.push('### Fixed', '');
    grouped.fix.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Changed (refactor, perf)
  const changed = [...grouped.refactor, ...grouped.perf];
  if (changed.length > 0) {
    lines.push('### Changed', '');
    changed.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Documentation
  if (grouped.docs.length > 0) {
    lines.push('### Documentation', '');
    grouped.docs.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      lines.push(`- ${scope}${item.description}`);
    });
    lines.push('');
  }

  // Other (style, test, build, ci, chore)
  // Note: 以下类型的提交默认不包含在 changelog 中，因为它们是内部维护性改动，对用户无直接影响：
  // - style: 代码格式（空格、分号等）
  // - test: 测试相关改动
  // - build: 构建系统改动
  // - ci: CI 配置改动
  // - chore: 维护性改动
  // 如果需要在 changelog 中包含这些类型，可以通过环境变量 CHANGELOG_INCLUDE_INTERNAL=true 启用
  const includeInternal = process.env.CHANGELOG_INCLUDE_INTERNAL === 'true';
  const other = includeInternal
    ? [
        ...grouped.style,
        ...grouped.test,
        ...grouped.build,
        ...grouped.ci,
        ...grouped.chore,
      ]
    : [];
  if (other.length > 0) {
    lines.push('### Other', '');
    other.forEach((item) => {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else if (item && typeof item === 'object') {
        const scope = item.scope ? `**${item.scope}**: ` : '';
        const description = item.description || item.full || '';
        if (description) {
          lines.push(`- ${scope}${description}`);
        }
      }
    });
    lines.push('');
  }

  const content = lines.join('\n');
  return deduplicateContent(content);
}

// 翻译文本（使用 Google Translate API）
async function translateText(text, from = 'en', to = 'zh-CN') {
  if (!text || text.trim().length === 0) {
    return text;
  }
  // 如果已经包含中文，不需要翻译
  if (/[\u4e00-\u9fa5]/.test(text)) {
    return text;
  }
  try {
    const https = await import('https');
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodedText}`;
    return new Promise((resolve) => {
      https.default.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result && result[0] && result[0][0] && result[0][0][0]) {
              resolve(result[0][0][0]);
            } else {
              resolve(text);
            }
          } catch (error) {
            console.warn(`Translation failed for "${text}":`, error.message);
            resolve(text);
          }
        });
      }).on('error', (error) => {
        console.warn(`Translation error for "${text}":`, error.message);
        resolve(text);
      });
    });
  } catch (error) {
    console.warn(`Translation error for "${text}":`, error.message);
    return text;
  }
}

// 批量翻译文本
async function translateTexts(texts) {
  const results = [];
  for (const text of texts) {
    results.push(await translateText(text));
    // 添加延迟以避免频率限制
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return results;
}

// 生成 Unreleased 部分的中文内容
async function generateUnreleasedContentZH(grouped, autoTranslate = true) {
  const lines = [];
  const translations = [];

  // Breaking changes
  if (grouped.breaking.length > 0) {
    lines.push('### ⚠️ 破坏性变更', '');
    grouped.breaking.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符
      } else {
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  // Added
  if (grouped.feat.length > 0) {
    lines.push('### 新增', '');
    grouped.feat.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符
      } else {
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  // Fixed
  if (grouped.fix.length > 0) {
    lines.push('### 修复', '');
    grouped.fix.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符
      } else {
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  // Changed
  const changed = [...grouped.refactor, ...grouped.perf];
  if (changed.length > 0) {
    lines.push('### 变更', '');
    changed.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符
      } else {
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  // Documentation
  if (grouped.docs.length > 0) {
    lines.push('### 文档', '');
    grouped.docs.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符
      } else {
        lines.push(`- ${scope}${item.description}`);
      }
    });
    lines.push('');
  }

  // Other (style, test, build, ci, chore)
  // Note: 以下类型的提交默认不包含在 changelog 中，因为它们是内部维护性改动，对用户无直接影响：
  // - style: 代码格式（空格、分号等）
  // - test: 测试相关改动
  // - build: 构建系统改动
  // - ci: CI 配置改动
  // - chore: 维护性改动
  // 如果需要在 changelog 中包含这些类型，可以通过环境变量 CHANGELOG_INCLUDE_INTERNAL=true 启用
  const includeInternal = process.env.CHANGELOG_INCLUDE_INTERNAL === 'true';
  const other = includeInternal
    ? [
        ...grouped.style,
        ...grouped.test,
        ...grouped.build,
        ...grouped.ci,
        ...grouped.chore,
      ]
    : [];
  if (other.length > 0) {
    lines.push('### 其他', '');
    other.forEach((item) => {
      if (typeof item === 'string') {
        if (autoTranslate) {
          translations.push({ text: item, scope: '', lineIndex: lines.length, isString: true });
          lines.push(''); // 占位符
        } else {
          lines.push(`- ${item}`);
        }
      } else if (item && typeof item === 'object') {
        const scope = item.scope ? `**${item.scope}**: ` : '';
        const description = item.description || item.full || '';
        if (description) {
          if (autoTranslate) {
            translations.push({ text: description, scope, lineIndex: lines.length });
            lines.push(''); // 占位符
          } else {
            lines.push(`- ${scope}${description}`);
          }
        }
      }
    });
    lines.push('');
  }

  // 如果需要翻译，执行翻译并替换占位符
  if (autoTranslate && translations.length > 0) {
    const textsToTranslate = translations.map((t) => t.text);
    const translatedTexts = await translateTexts(textsToTranslate);
    translations.forEach((translation, index) => {
      const translated = translatedTexts[index];
      const lineIndex = translation.lineIndex;
      if (translation.isString) {
        lines[lineIndex] = `- ${translated}`;
      } else {
        lines[lineIndex] = `- ${translation.scope}${translated}`;
      }
    });
  }

  const content = lines.join('\n');
  return deduplicateContent(content);
}

// 获取最新版本号
function getLatestVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8',
      cwd: rootDir,
    }).trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

// 更新 changelog 中的 [Unreleased] 或 [未发布] 部分
function updateChangelogSection(changelog, sectionTitle, sectionLinkPattern, newContent, versionTag) {
  if (changelog.includes(sectionTitle)) {
    // 找到部分的开始和结束位置
    const sectionIndex = changelog.indexOf(sectionTitle);
    const nextSectionIndex = changelog.indexOf('\n## [', sectionIndex + 1);

    // 提取部分之前的内容
    const beforeSection = changelog.slice(0, sectionIndex);

    // 提取部分之后的内容（下一个版本部分或链接部分）
    let afterSection = '';
    if (nextSectionIndex > -1) {
      // 有下一个版本部分
      afterSection = changelog.slice(nextSectionIndex);
    } else {
      // 没有下一个版本部分，查找链接部分
      const linkMatch = changelog.match(sectionLinkPattern);
      if (linkMatch) {
        const linkIndex = changelog.indexOf(linkMatch[0]);
        // 提取链接行及其后面的内容
        const linkLineEnd = changelog.indexOf('\n', linkIndex);
        if (linkLineEnd > -1) {
          afterSection = changelog.slice(linkLineEnd);
        } else {
          afterSection = '';
        }
        // 保留链接
        afterSection = linkMatch[0] + (afterSection ? '\n' + afterSection : '');
      }
    }

    // 重新构建：标题 + 新内容 + 后续内容
    return beforeSection + sectionTitle + '\n\n' + newContent + (afterSection ? '\n\n' + afterSection : '');
  } else {
    // 如果没有该部分，在文件开头添加
    return sectionTitle + '\n\n' + newContent + '\n\n' + changelog;
  }
}

// 更新 Unreleased 部分
async function updateUnreleased() {
  const commits = getCommitsSinceLatestTag();

  if (commits.length === 0) {
    console.log('No new commits since latest tag. Skipping update.');
    return;
  }

  const grouped = groupCommits(commits);

  // 检查是否有对用户有价值的变更（排除内部维护性改动）
  // 只检查：feat, fix, perf, refactor, docs, revert, breaking
  const includeInternal = process.env.CHANGELOG_INCLUDE_INTERNAL === 'true';
  const userFacingTypes = ['feat', 'fix', 'perf', 'refactor', 'docs', 'revert', 'breaking'];
  const hasUserFacingChanges = userFacingTypes.some(
    (type) => grouped[type] && grouped[type].length > 0
  );

  // 如果启用了包含内部改动，也检查内部类型
  const hasInternalChanges = includeInternal
    ? ['style', 'test', 'build', 'ci', 'chore'].some(
        (type) => grouped[type] && grouped[type].length > 0
      )
    : false;

  if (!hasUserFacingChanges && !hasInternalChanges) {
    console.log('No user-facing changes found (only internal maintenance commits). Skipping update.');
    return;
  }

  const contentEN = generateUnreleasedContentEN(grouped);

  // 检查生成的内容是否为空（去除空行后）
  const contentENTrimmed = contentEN.trim();
  if (!contentENTrimmed) {
    console.log('Generated changelog content is empty. Skipping update.');
    return;
  }

  // 检查是否启用自动翻译（通过环境变量控制，默认启用）
  const autoTranslate = process.env.CHANGELOG_AUTO_TRANSLATE !== 'false';
  const contentZH = await generateUnreleasedContentZH(grouped, autoTranslate);

  // 检查中文内容是否为空
  const contentZHTrimmed = contentZH.trim();
  if (!contentZHTrimmed) {
    console.log('Generated Chinese changelog content is empty. Skipping update.');
    return;
  }

  // 获取最新版本号用于更新链接
  const latestVersion = getLatestVersion();
  const versionTag = latestVersion ? `v${latestVersion}` : 'HEAD';

  // 更新英文 CHANGELOG
  let changelogEN = readFileSync(changelogENPath, 'utf-8');
  changelogEN = updateChangelogSection(
    changelogEN,
    '## [Unreleased]',
    /\[Unreleased\]:\s*https:\/\/[^\s]+/,
    contentEN,
    versionTag
  );

  // 更新链接
  changelogEN = changelogEN.replace(
    /\[Unreleased\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[Unreleased]: https://github.com/tegojs/tego-standard/compare/${versionTag}...HEAD`
  );

  writeFileSync(changelogENPath, changelogEN, 'utf-8');
  console.log(`✓ Updated CHANGELOG.md [Unreleased] section`);

  // 更新中文 CHANGELOG
  let changelogZH = readFileSync(changelogZHPath, 'utf-8');
  changelogZH = updateChangelogSection(
    changelogZH,
    '## [未发布]',
    /\[未发布\]:\s*https:\/\/[^\s]+/,
    contentZH,
    versionTag
  );

  // 更新链接
  changelogZH = changelogZH.replace(
    /\[未发布\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[未发布]: https://github.com/tegojs/tego-standard/compare/${versionTag}...HEAD`
  );

  writeFileSync(changelogZHPath, changelogZH, 'utf-8');
  console.log(`✓ Updated CHANGELOG.zh-CN.md [未发布] section`);
}

// 主函数
async function main() {
  try {
    await updateUnreleased();
  } catch (error) {
    console.error('Error updating Unreleased section:', error);
    process.exit(1);
  }
}

main();

