/**
 * 国际化工具
 * 负责语言检测、翻译文本加载和管理
 */

// 多语言资源（从 JSON 文件加载）
let locales = {};
let currentLang = 'en';

/**
 * 检测系统语言
 */
function detectLanguage() {
  const language = navigator.language || navigator.userLanguage || 'en';

  // 检查完整语言代码（如 zh-CN）
  if (locales[language]) {
    return language;
  }

  // 检查语言代码（如 zh）
  const langCode = language.split('-')[0];
  const supportedLanguages = Object.keys(locales);

  // 查找匹配的语言（如 zh-CN 或 zh-TW）
  for (const supportedLang of supportedLanguages) {
    if (supportedLang.startsWith(langCode)) {
      return supportedLang;
    }
  }

  // 默认返回英文
  return 'en';
}

/**
 * 获取翻译文本
 * @param {string} key - 翻译键名，支持嵌套键如 'status.checking'
 * @param {string|null} lang - 指定语言，如果为 null 则使用当前语言
 * @returns {string} 翻译后的文本
 */
function t(key, lang = null) {
  const langToUse = lang || currentLang;
  const translations = locales[langToUse] || locales.en || {};

  // 支持嵌套键，如 'status.checking'
  const keys = key.split('.');
  let value = translations;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // 如果找不到翻译，回退到英文
      const enTranslations = locales.en || {};
      value = enTranslations;
      for (const enKey of keys) {
        if (value && typeof value === 'object' && enKey in value) {
          value = value[enKey];
        } else {
          return key; // 如果英文也找不到，返回键名
        }
      }
      break;
    }
  }

  return typeof value === 'string' ? value : key;
}

/**
 * 加载语言包
 * @returns {Promise<void>}
 */
async function loadLocales() {
  const languageFiles = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];

  // 获取当前页面的基础路径
  const currentPath = window.location.href;
  const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);

  const loadPromises = languageFiles.map(async (lang) => {
    try {
      // 尝试从不同路径加载
      const possiblePaths = [
        `${basePath}i18n/${lang}.json`,
        `${basePath}../i18n/${lang}.json`,
        `./i18n/${lang}.json`,
        `i18n/${lang}.json`,
      ];

      for (const langPath of possiblePaths) {
        try {
          const response = await fetch(langPath);
          if (response.ok) {
            const data = await response.json();
            locales[lang] = data;
            return;
          }
        } catch (e) {
          // 继续尝试下一个路径
        }
      }

      // 如果所有路径都失败，使用默认英文（如果可用）
      if (lang === 'en') {
        // 如果英文也加载失败，使用硬编码的默认值
        locales.en = {
          title: 'Starting Service',
          subtitle: 'Please wait, initializing backend service',
          status: {
            checking: 'Checking service status',
            starting: 'Starting backend service',
            waiting: 'Waiting for service response',
            initializing: 'Service is initializing',
            almostDone: 'Almost done',
            ready: 'Service is ready, loading application',
          },
        };
      }
    } catch (error) {
      console.warn(`Failed to load locale ${lang}:`, error);
    }
  });

  await Promise.all(loadPromises);

  // 检测并设置当前语言
  currentLang = detectLanguage();

  // 更新 HTML lang 属性
  if (document.documentElement) {
    document.documentElement.lang = currentLang;
  }
}

/**
 * 初始化国际化
 * @returns {Promise<void>}
 */
async function initI18n() {
  await loadLocales();
  return currentLang;
}

/**
 * 获取当前语言
 * @returns {string}
 */
function getCurrentLanguage() {
  return currentLang;
}

/**
 * 获取所有已加载的语言
 * @returns {string[]}
 */
function getSupportedLanguages() {
  return Object.keys(locales);
}

// 导出函数（如果在浏览器环境中，挂载到 window 对象）
if (typeof window !== 'undefined') {
  window.i18n = {
    t,
    detectLanguage,
    loadLocales,
    initI18n,
    getCurrentLanguage,
    getSupportedLanguages,
    get locales() {
      return locales;
    },
    get currentLang() {
      return currentLang;
    },
  };
}

// 如果在 Node.js 环境中（用于测试）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    t,
    detectLanguage,
    loadLocales,
    initI18n,
    getCurrentLanguage,
    getSupportedLanguages,
  };
}
