import React, { useMemo } from 'react';
import { useForm } from '@tachybase/schema';

import { Alert } from 'antd';

import { useTranslation } from '../locale';

// 默认分支名称
const DEFAULT_BRANCH = 'main' as const;

// 支持的文件扩展名
const SUPPORTED_FILE_EXTENSIONS = /\.(tsx?|jsx?|ts|js)$/;

/**
 * 从 URL 中解析分支和文件路径（与后端逻辑保持一致）
 */
function parseGitUrl(url: string): { owner: string; repo: string; branch?: string; filePath?: string } | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    if (pathParts.length < 2) {
      return null;
    }

    const owner = pathParts[0];
    const repo = pathParts[1];
    let branch: string | undefined;
    let filePath: string | undefined;

    // 处理 GitHub 格式: /owner/repo/blob/branch/path 或 /owner/repo/tree/branch/path
    if (urlObj.hostname === 'github.com' || urlObj.hostname.includes('github')) {
      const blobIndex = pathParts.findIndex((p) => p === 'blob');
      const treeIndex = pathParts.findIndex((p) => p === 'tree');

      if (blobIndex !== -1 && blobIndex + 1 < pathParts.length) {
        branch = pathParts[blobIndex + 1];
        if (blobIndex + 2 < pathParts.length) {
          filePath = pathParts.slice(blobIndex + 2).join('/');
        }
      } else if (treeIndex !== -1 && treeIndex + 1 < pathParts.length) {
        branch = pathParts[treeIndex + 1];
        if (treeIndex + 2 < pathParts.length) {
          filePath = pathParts.slice(treeIndex + 2).join('/');
        }
      }
    }
    // 处理 GitLab 格式: /owner/repo/-/blob/branch/path 或 /owner/repo/-/tree/branch/path
    else if (urlObj.hostname.includes('gitlab.com') || urlObj.hostname.includes('gitlab')) {
      const dashIndex = pathParts.findIndex((p) => p === '-');
      if (dashIndex !== -1 && dashIndex + 1 < pathParts.length) {
        const nextPart = pathParts[dashIndex + 1];
        if (nextPart === 'blob' || nextPart === 'tree') {
          if (dashIndex + 2 < pathParts.length) {
            branch = pathParts[dashIndex + 2];
            if (dashIndex + 3 < pathParts.length) {
              filePath = pathParts.slice(dashIndex + 3).join('/');
            }
          }
        } else if (nextPart === 'raw') {
          // GitLab raw URL: /owner/repo/-/raw/branch/path
          if (dashIndex + 2 < pathParts.length) {
            branch = pathParts[dashIndex + 2];
            if (dashIndex + 3 < pathParts.length) {
              filePath = pathParts.slice(dashIndex + 3).join('/');
            }
          }
        }
      }
    }
    // 处理 Gitea 格式: /owner/repo/src/branch/branch-name/path
    else if (urlObj.pathname.includes('/src/branch/')) {
      const srcIndex = pathParts.findIndex((p) => p === 'src');
      if (srcIndex !== -1 && pathParts[srcIndex + 1] === 'branch' && srcIndex + 2 < pathParts.length) {
        branch = pathParts[srcIndex + 2];
        if (srcIndex + 3 < pathParts.length) {
          filePath = pathParts.slice(srcIndex + 3).join('/');
        }
      }
    }
    // 处理 raw 文件 URL: /owner/repo/branch/path (如 raw.githubusercontent.com)
    else if (
      urlObj.hostname.includes('raw.githubusercontent.com') ||
      urlObj.pathname.includes('/-/raw/') ||
      urlObj.pathname.includes('/raw/branch/')
    ) {
      if (pathParts.length >= 3) {
        branch = pathParts[2];
        if (pathParts.length > 3) {
          filePath = pathParts.slice(3).join('/');
        }
      }
    }
    // 处理自定义 Git 服务器，尝试查找常见的关键字
    else {
      const branchKeywords = ['branch', 'blob', 'tree', 'raw'];
      const branchIndex = pathParts.findIndex((part, index) => {
        return branchKeywords.includes(part.toLowerCase()) && index > 1;
      });

      if (branchIndex !== -1 && branchIndex + 1 < pathParts.length) {
        branch = pathParts[branchIndex + 1];
        if (branchIndex + 2 < pathParts.length) {
          filePath = pathParts.slice(branchIndex + 2).join('/');
        }
      }
    }

    return { owner, repo, branch, filePath };
  } catch {
    return null;
  }
}

/**
 * 检测是否是 Raw 文件 URL
 */
function isRawFileUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hasFileExtension = SUPPORTED_FILE_EXTENSIONS.test(urlObj.pathname);
    return (
      urlObj.hostname.includes('raw.githubusercontent.com') ||
      urlObj.pathname.includes('/-/raw/') ||
      (urlObj.pathname.includes('/raw/branch/') && !urlObj.pathname.includes('/-/raw/')) ||
      hasFileExtension
    );
  } catch {
    return false;
  }
}

/**
 * Git URL 预览组件
 * 根据用户输入的 URL，预览最终会解析的地址格式（使用与后端相同的解析逻辑）
 */
export const GitUrlPreview: React.FC = () => {
  const form = useForm();
  const { t } = useTranslation();

  const codeSource = form.values?.codeSource;
  const codeType = form.values?.codeType;
  const codeUrl = form.values?.codeUrl;
  // 从数据库读取的字段值（作为后备）
  const codeBranch = form.values?.codeBranch || DEFAULT_BRANCH;
  const codePath = form.values?.codePath;

  const previewUrl = useMemo(() => {
    // 只在远程代码且类型为 Git 时显示预览
    if (codeSource !== 'remote' || codeType !== 'git' || !codeUrl) {
      return null;
    }

    try {
      const urlObj = new URL(codeUrl);
      let rawUrl = '';

      // 如果 URL 已经是 raw 文件 URL，直接使用
      if (isRawFileUrl(codeUrl)) {
        return codeUrl;
      }

      // 尝试从 URL 中解析信息（与后端逻辑一致）
      const parsed = parseGitUrl(codeUrl);
      // 优先级：数据库字段 > URL 解析 > 默认值
      const finalBranch = codeBranch || parsed?.branch || DEFAULT_BRANCH;
      const finalPath = codePath || parsed?.filePath;

      // GitHub Raw URL 格式: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
      if (urlObj.hostname === 'github.com' || urlObj.hostname.includes('github')) {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];

          // 优先使用解析结果或提供的路径
          const filePath = finalPath || parsed?.filePath;
          if (filePath) {
            rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${filePath}`;
          } else {
            // 尝试从 URL 路径中提取文件路径
            const blobIndex = pathParts.findIndex((p) => p === 'blob');
            const treeIndex = pathParts.findIndex((p) => p === 'tree');
            let filePath: string | undefined;

            if (blobIndex !== -1 && blobIndex + 2 < pathParts.length) {
              filePath = pathParts.slice(blobIndex + 2).join('/');
            } else if (treeIndex !== -1 && treeIndex + 2 < pathParts.length) {
              const possiblePath = pathParts.slice(treeIndex + 2).join('/');
              if (SUPPORTED_FILE_EXTENSIONS.test(possiblePath)) {
                filePath = possiblePath;
              }
            }

            if (filePath) {
              rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${filePath}`;
            } else {
              return null; // 无法确定文件路径，不显示预览
            }
          }
        } else {
          return null;
        }
      }
      // GitLab 或 GitLab 风格的 Raw URL 格式: https://{host}/{owner}/{repo}/-/raw/{branch}/{path}
      else if (urlObj.hostname.includes('gitlab.com') || urlObj.hostname.includes('gitlab')) {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];

          // 优先使用解析结果或提供的路径
          const filePath = finalPath || parsed?.filePath;
          if (filePath) {
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
          } else {
            // 尝试从 URL 路径中提取文件路径
            const dashIndex = pathParts.findIndex((p) => p === '-');
            if (dashIndex !== -1 && dashIndex + 1 < pathParts.length) {
              const nextPart = pathParts[dashIndex + 1];
              if ((nextPart === 'blob' || nextPart === 'tree') && dashIndex + 3 < pathParts.length) {
                const filePath = pathParts.slice(dashIndex + 3).join('/');
                if (filePath && SUPPORTED_FILE_EXTENSIONS.test(filePath)) {
                  rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
                } else {
                  return null;
                }
              } else {
                return null;
              }
            } else {
              return null;
            }
          }
        } else {
          return null;
        }
      }
      // 自定义 Git 服务器（包括 Gitea）
      else {
        if (parsed) {
          const { owner, repo } = parsed;

          // 优先使用解析结果或提供的路径
          const filePath = finalPath || parsed.filePath;

          // 检查是否是 Gitea 的 /src/branch/ 格式
          if (urlObj.pathname.includes('/src/branch/')) {
            if (filePath) {
              rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/raw/branch/${finalBranch}/${filePath}`;
            } else {
              return null;
            }
          } else if (filePath) {
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
          } else {
            return null; // 无法确定文件路径
          }
        } else {
          return null; // 无法解析 URL
        }
      }

      return rawUrl;
    } catch (error) {
      // URL 格式无效
      return null;
    }
  }, [codeSource, codeType, codeUrl, codeBranch, codePath]);

  if (!previewUrl) {
    return null;
  }

  return (
    <Alert
      message={t('Resolved URL')}
      description={
        <div style={{ wordBreak: 'break-all', marginTop: 8 }}>
          <code style={{ fontSize: '12px', color: '#1890ff' }}>{previewUrl}</code>
        </div>
      }
      type="info"
      showIcon
      style={{ marginTop: 8 }}
    />
  );
};
