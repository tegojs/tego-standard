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
   */
  private async fetchFromCDN(url: string, timeout: number = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const request = client.get(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          headers: {
            'User-Agent': 'TegoCloudComponent/1.0',
          },
          timeout,
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to fetch from CDN: HTTP ${res.statusCode}`));
            return;
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            resolve(data);
          });
        },
      );

      request.on('error', (error) => {
        reject(new Error(`Failed to fetch from CDN: ${error.message}`));
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * 从 Git 仓库获取代码（通过 Raw 文件 URL）
   */
  private async fetchFromGit(url: string, branch: string = 'main', path?: string): Promise<string> {
    try {
      const urlObj = new URL(url);
      let rawUrl = '';

      // GitHub Raw URL 格式: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
      if (urlObj.hostname === 'github.com') {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];
          const filePath = path || pathParts.slice(2).join('/') || 'index.tsx';
          rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
        } else {
          throw new Error('Invalid GitHub URL format');
        }
      }
      // GitLab Raw URL 格式: https://{host}/{owner}/{repo}/-/raw/{branch}/{path}
      else if (urlObj.hostname.includes('gitlab.com') || urlObj.hostname.includes('gitlab')) {
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 2) {
          const owner = pathParts[0];
          const repo = pathParts[1];
          const filePath = path || pathParts.slice(2).join('/') || 'index.tsx';
          rawUrl = `${urlObj.protocol}//${urlObj.hostname}/${owner}/${repo}/-/raw/${branch}/${filePath}`;
        } else {
          throw new Error('Invalid GitLab URL format');
        }
      } else {
        throw new Error(`Unsupported Git host: ${urlObj.hostname}`);
      }

      this.logger.info(`Fetching from Git: ${rawUrl}`);
      return await this.fetchFromCDN(rawUrl);
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
   */
  async fetchCode(codeUrl: string, codeType: 'cdn' | 'git', codeBranch?: string, codePath?: string): Promise<string> {
    if (!codeUrl) {
      throw new Error('Code URL is required');
    }

    if (codeType === 'cdn') {
      this.logger.info(`Fetching code from CDN: ${codeUrl}`);
      return await this.fetchFromCDN(codeUrl);
    } else if (codeType === 'git') {
      this.logger.info(`Fetching code from Git: ${codeUrl}, branch: ${codeBranch || 'main'}`);
      return await this.fetchFromGit(codeUrl, codeBranch || 'main', codePath);
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
