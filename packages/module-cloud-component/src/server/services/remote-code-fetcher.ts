import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { InjectLog, Logger, Service } from '@tego/server';

/**
 * 远程代码获取服务
 * 支持从 CDN 和 Git 仓库获取代码
 */
@Service()
export class RemoteCodeFetcher {
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
        'User-Agent': 'TegoCloudComponent/1.0',
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

      // 记录请求头（不记录敏感信息）
      const logHeaders = { ...headers };
      if (logHeaders['Authorization']) {
        const authHeader = logHeaders['Authorization'];
        if (authHeader.startsWith('Bearer ')) {
          logHeaders['Authorization'] = `Bearer ${authHeader.substring(7).substring(0, 4)}...`;
        } else if (authHeader.startsWith('Basic ')) {
          logHeaders['Authorization'] = `Basic [REDACTED]`;
        }
      }
      this.logger.debug(`Request headers: ${JSON.stringify(logHeaders)}`);

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
   * 检测是否是 Gitea 服务器
   */
  private isGiteaServer(hostname: string): boolean {
    // 可以通过域名特征或响应头判断，这里先简单判断
    // 如果后续需要更精确的判断，可以通过请求响应头中的 server 字段
    return hostname.includes('gitea') || hostname.includes('gitea.com');
  }

  /**
   * 检测 URL 是否已经是 Raw 文件 URL（可以直接访问）
   */
  private isRawFileUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      // 常见的 raw 文件 URL 标识
      const hasFileExtension = !!urlObj.pathname.match(/\.(tsx?|jsx?|ts|js)$/);
      return (
        urlObj.hostname.includes('raw.githubusercontent.com') ||
        urlObj.pathname.includes('/-/raw/') ||
        // Gitea 使用 /raw/branch/ 格式
        (urlObj.pathname.includes('/raw/branch/') && !urlObj.pathname.includes('/-/raw/')) ||
        // 自定义 Git 服务器的 raw URL 格式，如：/owner/repo/src/branch/main/path/to/file.tsx
        // 注意：/src/branch/ 格式需要转换，不是真正的 raw URL
        false // 暂时禁用，因为 /src/branch/ 需要转换
      );
    } catch {
      return false;
    }
  }

  /**
   * 从 URL 中解析分支和文件路径
   * 支持多种格式：
   * - GitHub: https://github.com/owner/repo/blob/branch/path/to/file.tsx
   * - GitHub: https://github.com/owner/repo/tree/branch/path/to/dir
   * - GitLab: https://gitlab.com/owner/repo/-/blob/branch/path/to/file.tsx
   * - GitLab: https://gitlab.com/owner/repo/-/tree/branch/path/to/dir
   * - Gitea: https://gitea.com/owner/repo/src/branch/branch-name/path/to/file.tsx
   * - Raw URLs: https://raw.githubusercontent.com/owner/repo/branch/path/to/file.tsx
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
      else if (this.isRawFileUrl(url)) {
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
   * 从 Git 仓库获取代码（通过 Raw 文件 URL）
   * @param url Git 仓库 URL
   * @param branch 分支名称
   * @param path 文件路径
   * @param authType 认证类型
   * @param authToken 认证 Token
   * @param authUsername 认证用户名（Basic Auth）
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

          // 如果 URL 是 blob 或 tree 格式，需要转换为 raw URL
          if (parsed?.filePath) {
            // 从解析结果中获取文件路径
            rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${parsed.filePath}`;
          } else if (finalPath) {
            // 使用提供的 codePath
            rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${finalBranch}/${finalPath}`;
          } else {
            // 尝试从 URL 路径中提取文件路径（移除 blob/tree 等关键字）
            const blobIndex = pathParts.findIndex((p) => p === 'blob');
            const treeIndex = pathParts.findIndex((p) => p === 'tree');
            let filePath: string | undefined;

            if (blobIndex !== -1 && blobIndex + 2 < pathParts.length) {
              // 跳过 blob 和 branch，获取文件路径
              filePath = pathParts.slice(blobIndex + 2).join('/');
            } else if (treeIndex !== -1 && treeIndex + 2 < pathParts.length) {
              // tree 格式通常指向目录，需要文件扩展名才能确定是文件
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
          throw new Error(
            `Invalid GitHub URL format: ${url}. Expected format: https://github.com/owner/repo/blob/branch/path/to/file.tsx`,
          );
        }
      }
      // GitLab 或 GitLab 风格的 Raw URL 格式: https://{host}/{owner}/{repo}/-/raw/{branch}/{path}
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
            // 尝试从 URL 路径中提取文件路径
            const dashIndex = pathParts.findIndex((p) => p === '-');
            if (dashIndex !== -1 && dashIndex + 1 < pathParts.length) {
              const nextPart = pathParts[dashIndex + 1];
              if ((nextPart === 'blob' || nextPart === 'tree') && dashIndex + 3 < pathParts.length) {
                const filePath = pathParts.slice(dashIndex + 3).join('/');
                if (filePath && filePath.match(/\.(tsx?|jsx?|ts|js)$/)) {
                  rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
                } else {
                  throw new Error(
                    `Unable to determine file path from GitLab URL: ${url}. Please ensure the URL points to a specific file (e.g., /-/blob/branch/path/to/file.tsx) or provide codePath.`,
                  );
                }
              } else {
                throw new Error(
                  `Unable to determine file path from GitLab URL: ${url}. Please ensure the URL points to a specific file or provide codePath.`,
                );
              }
            } else {
              throw new Error(
                `Invalid GitLab URL format: ${url}. Expected format: https://gitlab.com/owner/repo/-/blob/branch/path/to/file.tsx`,
              );
            }
          }
        } else {
          throw new Error(`Invalid GitLab URL format: ${url}`);
        }
      }
      // 自定义 Git 服务器（包括 Gitea）
      else {
        if (parsed) {
          const { owner, repo } = parsed;

          // 检查是否是 Gitea 的 /src/branch/ 格式（需要转换为 /raw/branch/ 格式）
          if (urlObj.pathname.includes('/src/branch/')) {
            // Gitea 的浏览 URL: /owner/repo/src/branch/branch-name/path/to/file
            // 需要转换为 raw URL: /owner/repo/raw/branch/branch-name/path/to/file
            const actualPath = finalPath || parsed.filePath;

            if (!actualPath) {
              throw new Error(
                `Unable to determine file path from Gitea URL: ${url}. Please ensure the URL points to a specific file (e.g., /src/branch/main/path/to/file.tsx) or provide codePath.`,
              );
            }

            // Gitea 的 raw URL 格式: /owner/repo/raw/branch/branch-name/path/to/file
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/raw/branch/${finalBranch}/${actualPath}`;
            this.logger.info(`Converting Gitea URL from /src/branch/ to /raw/branch/ format: ${rawUrl}`);
          } else if (finalPath || parsed.filePath) {
            // 尝试多种常见的 raw URL 格式
            const filePath = finalPath || parsed.filePath;

            // 格式1: GitLab 风格 - https://{host}/{owner}/{repo}/-/raw/{branch}/{path}
            rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${filePath}`;
            this.logger.info(`Attempting GitLab-style raw URL for custom Git server: ${rawUrl}`);
          } else {
            // 如果没有提供 filePath，尝试从 URL 中解析
            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            if (pathParts.length > 2) {
              // 尝试从 URL 路径中提取文件路径（查找包含文件扩展名的部分）
              const possibleFilePath = pathParts.slice(2).join('/');
              if (possibleFilePath && possibleFilePath.match(/\.(tsx?|jsx?|ts|js)$/)) {
                rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${finalBranch}/${possibleFilePath}`;
                this.logger.info(`Inferred file path from URL, attempting: ${rawUrl}`);
              } else {
                throw new Error(
                  `Unable to determine file path from URL: ${url}. Please ensure the URL points to a specific file (with .tsx, .ts, .jsx, or .js extension) or provide codePath.`,
                );
              }
            } else {
              throw new Error(
                `Unable to determine file path from URL: ${url}. Please provide codePath or use a URL that points to a specific file.`,
              );
            }
          }
        } else {
          // 如果无法解析 URL，检查是否是 raw URL
          if (this.isRawFileUrl(url)) {
            this.logger.info(`URL appears to be a raw file URL, using directly: ${url}`);
            rawUrl = url;
          } else {
            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            if (pathParts.length >= 2) {
              // 尝试使用基本格式，但需要 codePath
              throw new Error(
                `Unable to parse Git URL: ${url}. Please ensure the URL format is correct (e.g., https://git.example.com/owner/repo/blob/branch/path/to/file.tsx) or provide codePath.`,
              );
            } else {
              throw new Error(
                `Invalid Git URL format: ${url}. Expected format: https://git.example.com/owner/repo/blob/branch/path/to/file.tsx or provide codePath.`,
              );
            }
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
   * @param codeType 代码类型：'cdn' 或 'git'（由前端指定）
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
   */
  isCacheValid(cache: { content: string; timestamp: number } | null, maxAge: number = 3600000): boolean {
    if (!cache) {
      return false;
    }
    return Date.now() - cache.timestamp < maxAge;
  }
}
