#!/usr/bin/env node

/**
 * 自动生成 CHANGELOG 脚本
 * 基于 git commits 和 conventional commits 格式生成更新日志
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 类型映射（英文）
const TYPE_MAP_EN = {
  feat: 'Added',
  fix: 'Fixed',
  docs: 'Documentation',
  style: 'Style',
  refactor: 'Refactored',
  perf: 'Performance',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  chore: 'Chore',
  revert: 'Reverted',
};

// 类型映射（中文）
const TYPE_MAP_ZH = {
  feat: '新增',
  fix: '修复',
  docs: '文档',
  style: '样式',
  refactor: '重构',
  perf: '性能',
  test: '测试',
  build: '构建',
  ci: 'CI',
  chore: '维护',
  revert: '回退',
};

// 翻译文本（使用 Google Translate 免费 API）
/**
 * @param {string} text - 要翻译的文本
 * @param {string} from - 源语言，默认 'en'
 * @param {string} to - 目标语言，默认 'zh-CN'
 * @returns {Promise<string>} 翻译后的文本
 */
async function translateText(text, from = 'en', to = 'zh-CN') {
  if (!text || text.trim().length === 0) {
    return text;
  }

  // 如果文本已经是中文，直接返回
  if (/[\u4e00-\u9fa5]/.test(text)) {
    return text;
  }

  try {
    // 使用 Google Translate 免费 API
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodedText}`;

    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
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
              resolve(text); // 翻译失败，返回原文
            }
          } catch (error) {
            console.warn(`Translation failed for "${text}":`, error.message);
            resolve(text); // 翻译失败，返回原文
          }
        });
      }).on('error', (error) => {
        console.warn(`Translation error for "${text}":`, error.message);
        resolve(text); // 网络错误，返回原文
      });
    });
  } catch (error) {
    console.warn(`Translation error for "${text}":`, error.message);
    return text; // 出错时返回原文
  }
}

// 批量翻译文本（带缓存和去重）
const translationCache = new Map();

/**
 * @param {string[]} texts - 要翻译的文本数组
 * @returns {Promise<string[]>} 翻译后的文本数组
 */
async function translateTexts(texts) {
  const uniqueTexts = [...new Set(texts)];
  const results = new Map();

  // 从缓存中获取已翻译的文本
  for (const text of uniqueTexts) {
    if (translationCache.has(text)) {
      results.set(text, translationCache.get(text));
    }
  }

  // 翻译未缓存的文本
  const textsToTranslate = uniqueTexts.filter((text) => !results.has(text));

  if (textsToTranslate.length > 0) {
    console.log(`Translating ${textsToTranslate.length} items...`);

    // 批量翻译，添加延迟以避免频率限制
    for (let i = 0; i < textsToTranslate.length; i++) {
      const text = textsToTranslate[i];
      const translated = await translateText(text);
      results.set(text, translated);
      translationCache.set(text, translated);

      // 添加延迟以避免频率限制（每 100ms 翻译一个）
      if (i < textsToTranslate.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  // 返回原始顺序的翻译结果
  return texts.map((text) => results.get(text) || text);
}

// 检查 tag 是否存在
function tagExists(tag) {
  try {
    execSync(`git rev-parse --verify ${tag}`, { encoding: 'utf-8', cwd: rootDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 获取两个版本之间的 commits
/**
 * @param {string | undefined} fromTag
 * @param {string | undefined} toTag
 */
function getCommitsBetweenTags(fromTag, toTag) {
  try {
    // 检查 toTag 是否存在，如果不存在则使用 HEAD
    let actualToTag = toTag;
    if (toTag && !tagExists(toTag)) {
      console.log(`Tag ${toTag} does not exist, using HEAD instead`);
      actualToTag = 'HEAD';
    }

    let range;
    if (fromTag) {
      // 检查 fromTag 是否存在
      if (!tagExists(fromTag)) {
        console.warn(`Warning: Tag ${fromTag} does not exist, using HEAD as start point`);
        range = `HEAD..${actualToTag || 'HEAD'}`;
      } else {
        range = `${fromTag}..${actualToTag || 'HEAD'}`;
      }
    } else {
      // 获取最新的 tag，如果不存在则从第一个 commit 开始
      try {
        const latestTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf-8', cwd: rootDir }).trim();
        range = `${latestTag}..${actualToTag || 'HEAD'}`;
        console.log(`Using latest tag ${latestTag} as start point`);
      } catch {
        // 如果没有 tag，从第一个 commit 开始
        const firstCommit = execSync('git rev-list --max-parents=0 HEAD', { encoding: 'utf-8', cwd: rootDir }).trim();
        range = `${firstCommit}..${actualToTag || 'HEAD'}`;
        console.log(`No tags found, using first commit as start point`);
      }
    }

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

// 解析 conventional commit
function parseCommit(commit) {
  const { subject, body } = commit;

  // 检查 subject 是否存在
  if (!subject) {
    return null;
  }

  // 匹配格式: type(scope): description
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?: (.+)$/);

  if (!match) {
    return null;
  }

  const [, type, scope, description] = match;

  // 检查是否是 breaking change
  const isBreaking = subject.includes('!') || (body && body.includes('BREAKING CHANGE'));

  return {
    type: type.toLowerCase(),
    scope: scope || '',
    description: description.trim(),
    body: (body || '').trim(),
    isBreaking,
  };
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
      // 未匹配的 commit 归类到 chore
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

// 生成英文 changelog 条目
function generateChangelogEntryEN(grouped, version, date) {
  const lines = [`## [${version}] - ${date}`, ''];

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
  const other = [
    ...grouped.style,
    ...grouped.test,
    ...grouped.build,
    ...grouped.ci,
    ...grouped.chore,
  ];
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

  return lines.join('\n');
}

// 生成中文 changelog 条目（支持自动翻译）
/**
 * @param {any} grouped - 分组的 commits
 * @param {string} version - 版本号
 * @param {string} date - 日期
 * @param {boolean} autoTranslate - 是否自动翻译，默认 true
 */
async function generateChangelogEntryZH(grouped, version, date, autoTranslate = true) {
  const lines = [`## [${version}] - ${date}`, ''];

  // 收集所有需要翻译的文本和它们的位置信息
  const translations = [];

  // Breaking changes
  if (grouped.breaking.length > 0) {
    lines.push('### ⚠️ 破坏性变更', '');
    grouped.breaking.forEach((item) => {
      const scope = item.scope ? `**${item.scope}**: ` : '';
      if (autoTranslate && item.description) {
        translations.push({ text: item.description, scope, lineIndex: lines.length });
        lines.push(''); // 占位符，稍后替换
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

  // Other
  const other = [
    ...grouped.style,
    ...grouped.test,
    ...grouped.build,
    ...grouped.ci,
    ...grouped.chore,
  ];
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

    // 替换占位符
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

  return lines.join('\n');
}

// 获取最新版本号
function getLatestVersion() {
  try {
    const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8', cwd: rootDir })
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((tag) => /^v?\d+\.\d+\.\d+/.test(tag));

    if (tags.length > 0) {
      return tags[0].replace(/^v/, '');
    }
  } catch (error) {
    console.warn('Warning: Could not get tags:', error.message);
  }

  // 从 package.json 读取
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
    return pkg.version;
  } catch (error) {
    console.error('Error: Could not read package.json');
    process.exit(1);
  }
}

// 提取 [Unreleased] 部分的内容（不包含标题）
/**
 * @param {string} changelogContent
 * @param {string} unreleasedTitle - [Unreleased] 或 [未发布]
 * @returns {string | null}
 */
function extractUnreleasedContent(changelogContent, unreleasedTitle) {
  const titlePattern = `## [${unreleasedTitle}]`;
  const titleIndex = changelogContent.indexOf(titlePattern);

  if (titleIndex === -1) {
    return null;
  }

  // 找到标题行的结束位置
  const contentStart = changelogContent.indexOf('\n', titleIndex);
  if (contentStart === -1) {
    return null;
  }

  // 找到下一个版本标题或文件末尾
  const nextVersionIndex = changelogContent.indexOf('\n## [', contentStart + 1);
  const contentEnd = nextVersionIndex > -1 ? nextVersionIndex : changelogContent.length;

  // 提取内容（去除开头的空行）
  let content = changelogContent.slice(contentStart + 1, contentEnd).trim();

  // 如果内容为空或只有空行，返回 null
  if (!content || content.split('\n').every(line => !line.trim())) {
    return null;
  }

  return content;
}

// 将 [Unreleased] 内容转换为版本条目
/**
 * @param {string} unreleasedContent
 * @param {string} versionNumber
 * @param {string} date
 * @returns {string}
 */
function convertUnreleasedToVersionEntry(unreleasedContent, versionNumber, date) {
  // 添加版本标题和日期
  return `## [${versionNumber}] - ${date}\n\n${unreleasedContent}`;
}

// 移除已存在的版本条目
/**
 * @param {string} changelogContent
 * @param {string} versionNumber
 * @returns {string}
 */
function removeVersionEntry(changelogContent, versionNumber) {
  const lines = changelogContent.split('\n');
  const result = [];
  let skip = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检查是否是目标版本的标题行
    if (line.match(/^## \[.*\]/)) {
      if (line.includes(`[${versionNumber}]`)) {
        skip = true;
        continue;
      } else {
        skip = false;
      }
    }

    if (!skip) {
      result.push(line);
    }
  }

  return result.join('\n');
}

// 更新 CHANGELOG 文件
/**
 * @param {string} newVersion
 * @param {string | undefined} [fromTag]
 */
async function updateChangelog(newVersion, fromTag = undefined) {
  // 统一处理版本号格式：移除 v 前缀，统一使用不带 v 的版本号
  const versionNumber = newVersion.replace(/^v/, '');
  const versionTag = `v${versionNumber}`;

  const date = new Date().toISOString().split('T')[0];

  // 优先尝试从 [Unreleased] 部分提取内容
  const changelogENPath = join(rootDir, 'CHANGELOG.md');
  const changelogZHPath = join(rootDir, 'CHANGELOG.zh-CN.md');

  let changelogEN = readFileSync(changelogENPath, 'utf-8');
  let changelogZH = readFileSync(changelogZHPath, 'utf-8');

  const unreleasedContentEN = extractUnreleasedContent(changelogEN, 'Unreleased');
  const unreleasedContentZH = extractUnreleasedContent(changelogZH, '未发布');

  let entryEN, entryZH;

  // 如果 [Unreleased] 有内容，优先使用它
  if (unreleasedContentEN || unreleasedContentZH) {
    console.log('Using content from [Unreleased] section');

    if (unreleasedContentEN) {
      entryEN = convertUnreleasedToVersionEntry(unreleasedContentEN, versionNumber, date);
    } else {
      // 如果英文没有内容，从 git commits 生成
      const commits = getCommitsBetweenTags(fromTag, versionTag);
      const grouped = groupCommits(commits);
      entryEN = generateChangelogEntryEN(grouped, versionNumber, date);
    }

    if (unreleasedContentZH) {
      entryZH = convertUnreleasedToVersionEntry(unreleasedContentZH, versionNumber, date);
    } else {
      // 如果中文没有内容，从 git commits 生成并翻译
      const commits = getCommitsBetweenTags(fromTag, versionTag);
      const grouped = groupCommits(commits);
      const autoTranslate = process.env.CHANGELOG_AUTO_TRANSLATE !== 'false';
      entryZH = await generateChangelogEntryZH(grouped, versionNumber, date, autoTranslate);
    }
  } else {
    // 如果 [Unreleased] 没有内容，从 git commits 生成
    console.log('No [Unreleased] content found, generating from git commits');

    const commits = getCommitsBetweenTags(fromTag, versionTag);

    if (commits.length === 0 && !fromTag) {
      console.log('No commits found. Skipping changelog generation.');
      return;
    }

    const grouped = groupCommits(commits);

    // 检查是否有实际变更
    const hasChanges = Object.values(grouped).some((items) => items.length > 0);
    if (!hasChanges) {
      console.log('No conventional commits found. Skipping changelog generation.');
      return;
    }

    entryEN = generateChangelogEntryEN(grouped, versionNumber, date);

    // 检查是否启用自动翻译（通过环境变量控制，默认启用）
    const autoTranslate = process.env.CHANGELOG_AUTO_TRANSLATE !== 'false';
    entryZH = await generateChangelogEntryZH(grouped, versionNumber, date, autoTranslate);
  }

  // 智能混合模式：根据版本是否已发布决定是否允许覆盖
  // - 已发布的版本（有 tag）：保护已发布的版本信息，不允许覆盖
  // - 未发布的版本（无 tag）：允许覆盖，方便在发布前调整
  const isPublished = tagExists(versionTag);

  // 重新读取文件以检查当前状态
  changelogEN = readFileSync(changelogENPath, 'utf-8');

  if (isPublished) {
    // 版本已发布：如果 CHANGELOG 中已存在该版本，跳过更新以保护已发布信息
    if (changelogEN.includes(`[${versionNumber}]`)) {
      console.log(`⚠ Version ${versionNumber} already exists and is published (tag ${versionTag} exists), skipping update`);
      console.log(`  If you need to update a published version, please edit CHANGELOG files manually.`);
      return;
    }
  } else {
    // 版本未发布：如果 CHANGELOG 中已存在该版本，允许覆盖
    if (changelogEN.includes(`[${versionNumber}]`)) {
      console.log(`⚠ Version ${versionNumber} already exists in CHANGELOG.md but not published, replacing it`);
      changelogEN = removeVersionEntry(changelogEN, versionNumber);
    }
  }

  // 在 [Unreleased] 之后插入新版本条目，并清空 [Unreleased] 部分
  if (changelogEN.includes('## [Unreleased]')) {
    // 找到 [Unreleased] 部分的结束位置（下一个 ## 或文件末尾）
    const unreleasedIndex = changelogEN.indexOf('## [Unreleased]');
    const nextSectionIndex = changelogEN.indexOf('\n## [', unreleasedIndex + 1);

    if (nextSectionIndex > -1) {
      // 替换 [Unreleased] 部分为空，并在下一个版本之前插入新版本
      const beforeUnreleased = changelogEN.slice(0, unreleasedIndex);
      const afterNextSection = changelogEN.slice(nextSectionIndex);
      changelogEN = beforeUnreleased +
                    '## [Unreleased]\n\n' +
                    '\n\n' + entryEN +
                    afterNextSection;
    } else {
      // 替换 [Unreleased] 部分为空，并在文件末尾插入新版本
      const beforeUnreleased = changelogEN.slice(0, unreleasedIndex);
      changelogEN = beforeUnreleased +
                    '## [Unreleased]\n\n' +
                    '\n\n' + entryEN;
    }
  } else {
    // 在文件开头插入
    changelogEN = `## [Unreleased]\n\n\n\n${entryEN}${changelogEN}`;
  }

  // 更新链接
  changelogEN = changelogEN.replace(
    /\[Unreleased\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[Unreleased]: https://github.com/tegojs/tego-standard/compare/${versionTag}...HEAD`
  );

  // 更新或添加新版本的链接
  const versionLinkPattern = new RegExp(`\\[${versionNumber.replace(/\./g, '\\.')}\\]: https://github\\.com/[^/]+/[^/]+/releases/tag/[^\\s]+`, 'g');
  if (changelogEN.match(versionLinkPattern)) {
    // 如果链接已存在，更新它
    changelogEN = changelogEN.replace(
      versionLinkPattern,
      `[${versionNumber}]: https://github.com/tegojs/tego-standard/releases/tag/${versionTag}`
    );
  } else {
    // 如果链接不存在，添加它
    const linkMatch = changelogEN.match(/\[Unreleased\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/);
    if (linkMatch) {
      changelogEN = changelogEN.replace(
        linkMatch[0],
        `${linkMatch[0]}\n[${versionNumber}]: https://github.com/tegojs/tego-standard/releases/tag/${versionTag}`
      );
    }
  }

  writeFileSync(changelogENPath, changelogEN, 'utf-8');
  console.log(`✓ Updated CHANGELOG.md for version ${versionNumber}`);

  // 更新中文 CHANGELOG
  // 重新读取文件（已发布的版本在上面已经检查并返回了，这里只处理未发布的版本）
  changelogZH = readFileSync(changelogZHPath, 'utf-8');

  // 版本未发布：如果 CHANGELOG 中已存在该版本，允许覆盖
  if (changelogZH.includes(`[${versionNumber}]`)) {
    console.log(`⚠ Version ${versionNumber} already exists in CHANGELOG.zh-CN.md but not published, replacing it`);
    changelogZH = removeVersionEntry(changelogZH, versionNumber);
  }

  // 在 [未发布] 之后插入新版本条目，并清空 [未发布] 部分
  if (changelogZH.includes('## [未发布]')) {
    const unreleasedIndex = changelogZH.indexOf('## [未发布]');
    const nextSectionIndex = changelogZH.indexOf('\n## [', unreleasedIndex + 1);

    if (nextSectionIndex > -1) {
      // 替换 [未发布] 部分为空，并在下一个版本之前插入新版本
      const beforeUnreleased = changelogZH.slice(0, unreleasedIndex);
      const afterNextSection = changelogZH.slice(nextSectionIndex);
      changelogZH = beforeUnreleased +
                    '## [未发布]\n\n' +
                    '\n\n' + entryZH +
                    afterNextSection;
    } else {
      // 替换 [未发布] 部分为空，并在文件末尾插入新版本
      const beforeUnreleased = changelogZH.slice(0, unreleasedIndex);
      changelogZH = beforeUnreleased +
                    '## [未发布]\n\n' +
                    '\n\n' + entryZH;
    }
  } else {
    changelogZH = `## [未发布]\n\n\n\n${entryZH}${changelogZH}`;
  }

  // 更新链接
  changelogZH = changelogZH.replace(
    /\[未发布\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/g,
    `[未发布]: https://github.com/tegojs/tego-standard/compare/${versionTag}...HEAD`
  );

  // 更新或添加新版本的链接
  const versionLinkPattern = new RegExp(`\\[${versionNumber.replace(/\./g, '\\.')}\\]: https://github\\.com/[^/]+/[^/]+/releases/tag/[^\\s]+`, 'g');
  if (changelogZH.match(versionLinkPattern)) {
    // 如果链接已存在，更新它
    changelogZH = changelogZH.replace(
      versionLinkPattern,
      `[${versionNumber}]: https://github.com/tegojs/tego-standard/releases/tag/${versionTag}`
    );
  } else {
    // 如果链接不存在，添加它
    const linkMatch = changelogZH.match(/\[未发布\]: https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v[^\s]+\.\.\.HEAD/);
    if (linkMatch) {
      changelogZH = changelogZH.replace(
        linkMatch[0],
        `${linkMatch[0]}\n[${versionNumber}]: https://github.com/tegojs/tego-standard/releases/tag/${versionTag}`
      );
    }
  }

  writeFileSync(changelogZHPath, changelogZH, 'utf-8');
  console.log(`✓ Updated CHANGELOG.zh-CN.md for version ${versionNumber}`);
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const version = args[0];
  const fromTag = args[1] || undefined;

  if (!version) {
    console.error('Usage: node generate-changelog.mjs <version> [fromTag]');
    console.error('Example: node generate-changelog.mjs 1.5.2 v1.5.1');
    console.error('');
    console.error('Environment variables:');
    console.error('  CHANGELOG_AUTO_TRANSLATE=false  Disable auto translation');
    process.exit(1);
  }

  await updateChangelog(version, fromTag);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

