#!/usr/bin/env node
/**
 * Changelog 工具函数库
 * 包含 update-unreleased.mjs 和 generate-changelog.mjs 的公共逻辑
 */

import { execSync } from 'node:child_process';
import https from 'https';

// 翻译缓存
const translationCache = new Map();

/**
 * 解析 commit 消息
 * @param {{subject: string, body?: string}} commit
 * @returns {{type: string, scope: string, description: string, body: string, isBreaking: boolean} | null}
 */
export function parseCommit(commit) {
  const { subject } = commit;
  if (!subject) {
    return null;
  }

  // Conventional Commits 格式: type(scope): description 或 type(scope)!: description
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

/**
 * 解析 git log 输出（使用 \0 分隔符）
 * @param {string} output - git log 输出
 * @returns {Array<{hash: string, subject: string, body: string, author: string}>}
 */
export function parseGitLogOutput(output) {
  if (!output) {
    return [];
  }

  // git log 输出格式：每个 commit 可能跨多行，格式为 hash\0subject\0body\0author\n
  // body 可能包含换行符，所以需要找到前三个 \0 的位置来分割
  const commits = [];
  let remaining = output;

  while (remaining.length > 0) {
    // 找到前三个 \0 的位置
    const firstNull = remaining.indexOf('\0');
    if (firstNull === -1) break;

    const secondNull = remaining.indexOf('\0', firstNull + 1);
    if (secondNull === -1) break;

    const thirdNull = remaining.indexOf('\0', secondNull + 1);
    if (thirdNull === -1) break;

    // 提取 hash, subject, body (body 可能包含换行符)
    const hash = remaining.substring(0, firstNull).trim();
    const subject = remaining.substring(firstNull + 1, secondNull).trim();
    const bodyStart = secondNull + 1;

    // 从 thirdNull 之后开始，找到第一个 \n 或文件结束，这就是 author
    let authorEnd = remaining.indexOf('\n', thirdNull + 1);
    if (authorEnd === -1) {
      // 这是最后一个 commit
      authorEnd = remaining.length;
    }

    const body = remaining.substring(bodyStart, thirdNull).trim();
    const author = remaining.substring(thirdNull + 1, authorEnd).trim().replace(/\n/g, '');

    // 验证 hash 是有效的 40 位十六进制字符串
    if (hash && /^[0-9a-f]{40}$/.test(hash) && subject) {
      commits.push({ hash, subject, body, author });
    }

    // 移动到下一个 commit（跳过 author 和换行符）
    remaining = remaining.substring(authorEnd + 1);
  }

  return commits;
}

/**
 * 分组 commits
 * @param {Array<{hash: string, subject: string, body: string, author: string}>} commits
 * @param {boolean} includeCommitLink - 是否包含 commit 链接（用于 Unreleased）
 * @returns {Object}
 */
export function groupCommits(commits, includeCommitLink = false) {
  const grouped = {
    feat: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    fix: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    docs: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    style: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    refactor: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    perf: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    test: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    build: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    ci: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    chore: /** @type {Array<string | {type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string, subject?: string}>} */ ([]),
    revert: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
    breaking: /** @type {Array<{type: string, scope: string, description: string, body: string, isBreaking: boolean, full: string, hash?: string, shortHash?: string, commitLink?: string, author?: string}>} */ ([]),
  };

  commits.forEach((commit) => {
    const parsed = parseCommit(commit);
    const author = commit.author || '';

    if (!parsed) {
      // 对于无法解析的 commit，直接使用 subject 字符串
      grouped.chore.push(commit.subject);
      return;
    }

    // 如果需要包含 commit 链接（用于 Unreleased）
    let commitInfo;
    if (includeCommitLink) {
      const shortHash = commit.hash ? commit.hash.substring(0, 7) : '';
      const commitLink = shortHash
        ? `[${shortHash}](https://github.com/tegojs/tego-standard/commit/${commit.hash})`
        : '';
      commitInfo = {
        ...parsed,
        full: commit.subject,
        hash: commit.hash,
        shortHash,
        commitLink,
        author,
      };
    } else {
      commitInfo = {
        ...parsed,
        full: commit.subject,
        author,
      };
    }

    if (parsed.isBreaking) {
      grouped.breaking.push(commitInfo);
    }

    const type = parsed.type;
    if (grouped[type]) {
      grouped[type].push(commitInfo);
    } else {
      grouped.chore.push(commitInfo);
    }
  });

  return grouped;
}

/**
 * 将 PR 编号转换为链接
 * 例如: (#271) -> [#271](https://github.com/tegojs/tego-standard/pull/271)
 * 支持中文括号: （#271） -> [#271](https://github.com/tegojs/tego-standard/pull/271)
 * @param {string} text
 * @returns {string}
 */
export function convertPRNumbersToLinks(text) {
  if (!text) return text;
  // 匹配 (#数字) 或 （#数字） 格式，转换为链接
  // 同时匹配英文括号和中文括号
  // 注意：中文括号是 （ 和 ），需要完整匹配
  const chineseLeft = '（';
  const chineseRight = '）';
  return text
    .replace(/\(#(\d+)\)/g, '([#$1](https://github.com/tegojs/tego-standard/pull/$1))')
    .replace(new RegExp(`${chineseLeft}#(\\d+)${chineseRight}`, 'g'), '([#$1](https://github.com/tegojs/tego-standard/pull/$1))');
}

/**
 * 去除重复的行（保留第一次出现）
 * @param {string} content
 * @returns {string}
 */
export function deduplicateContent(content) {
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

/**
 * 翻译文本（使用 Google Translate API）
 * @param {string} text - 要翻译的文本
 * @param {string} from - 源语言，默认 'en'
 * @param {string} to - 目标语言，默认 'zh-CN'
 * @returns {Promise<string>} 翻译后的文本
 */
export async function translateText(text, from = 'en', to = 'zh-CN') {
  if (!text || text.trim().length === 0) {
    return text;
  }
  // 如果已经包含中文，不需要翻译
  if (/[\u4e00-\u9fa5]/.test(text)) {
    return text;
  }
  try {
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodedText}`;
    return new Promise((resolve) => {
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

/**
 * 批量翻译文本（带缓存和去重）
 * @param {string[]} texts - 要翻译的文本数组
 * @returns {Promise<string[]>} 翻译后的文本数组
 */
export async function translateTexts(texts) {
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

