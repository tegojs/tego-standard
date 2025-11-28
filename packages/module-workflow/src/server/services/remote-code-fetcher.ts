import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { InjectLog, Logger, Service } from '@tego/server';

/**
 * 远程代码获取服务（Workflow 模块专用）
 * 支持从 CDN 和 Git 仓库获取代码
 */
@Service()
export class WorkflowRemoteCodeFetcher {
  @InjectLog()
  private logger: Logger;

  /**
   * 从 CDN 获取代码
   * @param url 代码 URL
   * @param timeout 超时时间（毫秒）
   * @param authType 认证类型: 'none' | 'token' | 'basic'
   * @param authToken Bearer Token 或 Basic Auth 的密码
   * @param authUsername Basic Auth 的用户名
   */
  private async fetchFromCDN(
    url: string,
    timeout: number = 10000,
    authType?: string,
    authToken?: string,
    authUsername?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      this.logger.info(`Fetching from URL: ${url}${authType && authType !== 'none' ? ` (with ${authType} auth)` : ''}`);

      // 构建请求头
      const headers: Record<string, string> = {
        'User-Agent': 'TegoWorkflow/1.0',
      };

      // 添加认证头
      if (authType === 'token' && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
        this.logger.info(`Using Bearer Token authentication (token length: ${authToken.length})`);
      } else if (authType === 'basic' && authUsername && authToken) {
        // Basic Auth: base64(username:password)
        const credentials = Buffer.from(`${authUsername}:${authToken}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
        this.logger.info(`Using Basic Auth authentication (username: ${authUsername})`);
      } else if (authType && authType !== 'none') {
        this.logger.warn(`Auth type is ${authType} but missing required credentials`);
      }

      const request = client.get(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          headers,
          timeout,
        },
        (res) => {
          // 处理重定向（301, 302, 303, 307, 308）
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = res.headers.location.startsWith('http')
              ? res.headers.location
              : `${urlObj.protocol}//${urlObj.hostname}${res.headers.location}`;
            this.logger.info(`Following redirect from ${url} to ${redirectUrl}`);
            // 递归跟随重定向（最多 5 次，防止无限重定向）
            request.destroy();
            return this.fetchFromCDN(redirectUrl, timeout, authType, authToken, authUsername)
              .then(resolve)
              .catch(reject);
          }

          if (res.statusCode !== 200) {
            const errorMsg = `Failed to fetch from URL: HTTP ${res.statusCode}. URL: ${url}`;
            this.logger.error(errorMsg);
            reject(new Error(errorMsg));
            return;
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            this.logger.info(`Successfully fetched ${data.length} bytes from ${url}`);
            resolve(data);
          });
        },
      );

      request.on('error', (error) => {
        const errorMsg = `Failed to fetch from URL: ${error.message}. URL: ${url}`;
        this.logger.error(errorMsg);
        reject(new Error(errorMsg));
      });

      request.on('timeout', () => {
        request.destroy();
        const errorMsg = `Request timeout after ${timeout}ms. URL: ${url}`;
        this.logger.error(errorMsg);
        reject(new Error(errorMsg));
      });
    });
  }

  /**
   * 检测 URL 是否已经是 Raw 文件 URL（可以直接访问）
   */
  private isRawFileUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return (
        urlObj.hostname.includes('raw.githubusercontent.com') ||
        urlObj.pathname.includes('/-/raw/') ||
        urlObj.pathname.includes('/raw/branch/')
      );
    } catch {
      return false;
    }
  }

  /**
   * 从 URL 中解析分支和文件路径
   */
  private parseGitUrl(url: string): { owner: string; repo: string; branch?: string; filePath?: string } | null {
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
      // 处理 GitLab 格式: /owner/repo/-/blob/branch/path
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
      // 处理 raw 文件 URL
      else if (this.isRawFileUrl(url)) {
        if (pathParts.length >= 3) {
          branch = pathParts[2];
          if (pathParts.length > 3) {
            filePath = pathParts.slice(3).join('/');
          }
        }
      }

      return { owner, repo, branch, filePath };
    } catch {
      return null;
    }
  }

  /**
   * 从 Git 仓库获取代码（通过 Raw 文件 URL）
   */
  private async fetchFromGit(
    url: string,
    branch: string = 'main',
    path?: string,
    authType?: string,
    authToken?: string,
    authUsername?: string,
  ): Promise<string> {
    try {
      const urlObj = new URL(url);
      let rawUrl = '';

      // 如果 URL 已经是 raw 文件 URL，直接使用
      if (this.isRawFileUrl(url)) {
        this.logger.info(`URL appears to be a raw file URL, using directly: ${url}`);
        return await this.fetchFromCDN(url, 10000, authType, authToken, authUsername);
      }

      // 尝试从 URL 中解析信息
      const parsed = this.parseGitUrl(url);
      const finalBranch = branch || parsed?.branch || 'main';
      const finalPath = path || parsed?.filePath;

      // GitHub Raw URL 格式: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
      if (urlObj.hostname === 'github.com' || urlObj.hostname.includes('github')) {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];

          if (parsed?.filePath) {
            rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${parsed.filePath}`;
          } else if (finalPath) {
            rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${finalPath}`;
          } else {
            const blobIndex = pathParts.findIndex((p) => p === 'blob');
            const treeIndex = pathParts.findIndex((p) => p === 'tree');
            let filePath: string | undefined;

            if (blobIndex !== -1 && blobIndex + 2 < pathParts.length) {
              filePath = pathParts.slice(blobIndex + 2).join('/');
            } else if (treeIndex !== -1 && treeIndex + 2 < pathParts.length) {
              const possiblePath = pathParts.slice(treeIndex + 2).join('/');
              if (possiblePath.match(/\.(tsx?|jsx?|ts|js)$/)) {
                filePath = possiblePath;
              }
            }

            if (filePath) {
              rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${filePath}`;
            } else {
              throw new Error(
                `Unable to determine file path from GitHub URL: ${url}. Please ensure the URL points to a specific file (e.g., /blob/branch/path/to/file.tsx) or provide codePath.`,
              );
            }
          }
        } else {
          throw new Error(`Invalid GitHub URL format: ${url}`);
        }
      }
      // GitLab Raw URL 格式
      else if (urlObj.hostname.includes('gitlab.com') || urlObj.hostname.includes('gitlab')) {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];

          if (parsed?.filePath) {
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${parsed.filePath}`;
          } else if (finalPath) {
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${finalPath}`;
          } else {
            throw new Error(
              `Unable to determine file path from GitLab URL: ${url}. Please ensure the URL points to a specific file or provide codePath.`,
            );
          }
        } else {
          throw new Error(`Invalid GitLab URL format: ${url}`);
        }
      }
      // Gitea 或其他自定义 Git 服务器
      else {
        if (parsed) {
          const { owner, repo } = parsed;

          if (urlObj.pathname.includes('/src/branch/')) {
            const actualPath = finalPath || parsed.filePath;
            if (!actualPath) {
              throw new Error(
                `Unable to determine file path from Gitea URL: ${url}. Please ensure the URL points to a specific file or provide codePath.`,
              );
            }
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/raw/branch/${finalBranch}/${actualPath}`;
          } else if (finalPath || parsed.filePath) {
            const filePath = finalPath || parsed.filePath;
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
          } else {
            throw new Error(
              `Unable to determine file path from URL: ${url}. Please provide codePath or use a URL that points to a specific file.`,
            );
          }
        } else {
          if (this.isRawFileUrl(url)) {
            rawUrl = url;
          } else {
            throw new Error(`Invalid Git URL format: ${url}`);
          }
        }
      }

      this.logger.info(`Fetching from Git: ${rawUrl}`);
      return await this.fetchFromCDN(rawUrl, 10000, authType, authToken, authUsername);
    } catch (error) {
      this.logger.error(`Failed to fetch from Git: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 获取远程代码
   * @param codeUrl 代码地址
   * @param codeType 代码类型：'cdn' 或 'git'
   * @param codeBranch Git 分支名称（仅 Git 类型需要）
   * @param codePath Git 文件路径（仅 Git 类型需要）
   * @param authType 认证类型: 'none' | 'token' | 'basic'
   * @param authToken Bearer Token 或 Basic Auth 的密码
   * @param authUsername Basic Auth 的用户名
   */
  async fetchCode(
    codeUrl: string,
    codeType: 'cdn' | 'git',
    codeBranch?: string,
    codePath?: string,
    authType?: string,
    authToken?: string,
    authUsername?: string,
  ): Promise<string> {
    if (!codeUrl) {
      throw new Error('Code URL is required');
    }

    if (codeType === 'cdn') {
      this.logger.info(`Fetching code from CDN: ${codeUrl}`);
      return await this.fetchFromCDN(codeUrl, 10000, authType, authToken, authUsername);
    } else if (codeType === 'git') {
      this.logger.info(`Fetching code from Git: ${codeUrl}, branch: ${codeBranch || 'main'}`);
      return await this.fetchFromGit(codeUrl, codeBranch || 'main', codePath, authType, authToken, authUsername);
    } else {
      throw new Error(`Unsupported code type: ${codeType}. Must be 'cdn' or 'git'`);
    }
  }

  /**
   * 检查缓存是否有效（默认缓存 1 小时）
   * @param cache 缓存对象，包含 content 和 timestamp
   * @param maxAge 最大缓存时间（毫秒），默认 1 小时 (3600000ms)
   */
  isCacheValid(cache: { content: string; timestamp: number } | null, maxAge: number = 3600000): boolean {
    if (!cache) {
      return false;
    }
    return Date.now() - cache.timestamp < maxAge;
  }
}
