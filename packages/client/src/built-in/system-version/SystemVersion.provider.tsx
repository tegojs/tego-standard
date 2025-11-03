import React, { useEffect } from 'react';

import { useTranslation } from 'react-i18next';

import { useCurrentAppInfo } from '../../common/appInfo/CurrentAppInfoProvider';
import { useCurrentUserSettingsMenu } from '../../user/CurrentUserSettingsMenuProvider';

const CORE_REPO_URL = 'https://github.com/tegojs/tego';
const APP_REPO_URL = 'https://github.com/tegojs/tego-standard';

/**
 * 解析版本号并生成 GitHub 链接
 * @param version 版本号，例如 "1.0.0" 或 "1.0.0-abc1234@branch"
 * @param repoUrl 仓库 URL
 * @returns GitHub 链接地址
 */
function getVersionUrl(version: string | null | undefined, repoUrl: string): string | null {
  if (!version) {
    return null;
  }

  // 匹配带 hash 的版本格式：1.0.0-hash@branch 或 1.0.0-hash
  // hash 必须是 7 位十六进制字符（与后端 check-no-build-hash-in-version.mjs 保持一致）
  const hashMatch = version.match(/^\d+\.\d+\.\d+-([0-9a-f]{7})(?:@.+)?$/i);

  if (hashMatch) {
    // 有 hash，链接到 commit
    const hash = hashMatch[1];
    return `${repoUrl}/commit/${hash}`;
  } else {
    // 没有 hash，链接到 release tag
    // 版本号已经是完整的，直接用作 tag（可能已经带 v 前缀）
    const tag = version.startsWith('v') ? version : `v${version}`;
    return `${repoUrl}/releases/tag/${tag}`;
  }
}

const CoreVersion = () => {
  const info = useCurrentAppInfo();
  const { t } = useTranslation();
  const version = info?.data?.version?.core;
  const url = getVersionUrl(version, CORE_REPO_URL);

  return (
    <span>
      {t('Core Version')} -{' '}
      {url ? (
        <a href={url} target="_blank">
          {version}
        </a>
      ) : (
        version
      )}
    </span>
  );
};

const AppVersion = () => {
  const info = useCurrentAppInfo();
  const { t } = useTranslation();
  const version = info?.data?.version?.app;
  const url = getVersionUrl(version, APP_REPO_URL);

  return (
    <span>
      {t('App Version')} -{' '}
      {url ? (
        <a href={url} target="_blank">
          {version}
        </a>
      ) : (
        version
      )}
    </span>
  );
};

export const SystemVersionProvider = ({ children }) => {
  const { addMenuItem } = useCurrentUserSettingsMenu();

  useEffect(() => {
    addMenuItem(
      {
        key: 'system-version-app',
        label: <AppVersion />,
      },
      { before: 'divider_1' },
    );
    addMenuItem(
      {
        key: 'system-version-core',
        label: <CoreVersion />,
      },
      { before: 'divider_1' },
    );
  }, [addMenuItem]);

  return <>{children}</>;
};
