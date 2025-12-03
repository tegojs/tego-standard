import crypto from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { Context } from '@tego/server';

import { transform } from '@babel/core';
import dayjs from 'dayjs';
import jsonata from 'jsonata';
import _ from 'lodash';
import qrcode from 'qrcode';

import { FlowNodeModel, Instruction, JOB_STATUS, Processor } from '../..';
import { getRemoteCodeFetcher } from '../../utils/get-remote-code-fetcher';

export class ScriptInstruction extends Instruction {
  async run(node: FlowNodeModel, input: any, processor: Processor) {
    const {
      sourceArray,
      type,
      code = '',
      model,
      codeSource = 'local',
      codeType,
      codeUrl,
      codeBranch = 'main',
      codeAuthType,
      codeAuthToken,
      codeAuthUsername,
    } = node.config;

    // 如果配置了远程代码，先从远程获取代码
    let actualCode = code;
    if (codeSource === 'remote' && codeUrl && codeType) {
      try {
        const app = processor.options.plugin.app;
        // 获取 workflow 模块的 RemoteCodeFetcher 服务
        const remoteCodeFetcher = getRemoteCodeFetcher(app);

        if (remoteCodeFetcher) {
          // 直接使用数据库中的缓存（如果存在）
          const codeCache = node.config.codeCache as { content: string; timestamp?: number } | undefined;
          if (codeCache?.content) {
            app.logger.info(`[Workflow Node ${node.id}] Using cached remote code from database`);
            actualCode = codeCache.content;
          } else {
            // 缓存不存在，从远程获取代码（使用配置的分支和路径）
            app.logger.info(
              `[Workflow Node ${node.id}] No cache found, fetching remote code from ${codeUrl} (type: ${codeType}, branch: ${codeBranch || 'main'})`,
            );
            actualCode = await remoteCodeFetcher.fetchCode(
              codeUrl,
              codeType,
              codeBranch || 'main', // 使用配置的分支，默认为 'main'
              undefined, // codePath - 使用默认值
              codeAuthType,
              codeAuthToken,
              codeAuthUsername,
            );

            // 保存缓存到节点配置中（首次获取时）
            const nodeRepo = app.db.getRepository('flow_nodes');
            await nodeRepo.update({
              filterByTk: node.id,
              values: {
                config: {
                  ...node.config,
                  codeCache: {
                    content: actualCode,
                    timestamp: Date.now(), // 保留 timestamp 用于记录，但不用于验证
                  },
                },
              },
            });
            app.logger.info(`[Workflow Node ${node.id}] Remote code fetched and cached successfully`);
          }
        } else {
          // 使用简单的 HTTP 请求实现（fallback，当 RemoteCodeFetcher 服务不可用时）
          // 先检查缓存
          const codeCache = node.config.codeCache as { content: string; timestamp?: number } | undefined;
          if (codeCache?.content) {
            app.logger.info(`[Workflow Node ${node.id}] Using cached remote code from database (fallback mode)`);
            actualCode = codeCache.content;
          } else {
            // 缓存不存在，使用简单的 HTTP 请求获取代码
            const http = require('node:http');
            const https = require('node:https');
            const { URL } = require('node:url');

            const urlObj = new URL(codeUrl);
            const client = urlObj.protocol === 'https:' ? https : http;

            app.logger.info(
              `[Workflow Node ${node.id}] No cache found, fetching remote code via HTTP (type: ${codeType}, branch: ${codeBranch || 'main'})`,
            );

            actualCode = await new Promise<string>((resolve, reject) => {
              const headers: Record<string, string> = {
                'User-Agent': 'TegoWorkflow/1.0',
              };

              if (codeAuthType === 'token' && codeAuthToken) {
                headers['Authorization'] = `Bearer ${codeAuthToken}`;
              } else if (codeAuthType === 'basic' && codeAuthUsername && codeAuthToken) {
                const credentials = Buffer.from(`${codeAuthUsername}:${codeAuthToken}`).toString('base64');
                headers['Authorization'] = `Basic ${credentials}`;
              }

              const request = client.get(
                {
                  hostname: urlObj.hostname,
                  port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                  path: urlObj.pathname + urlObj.search,
                  headers,
                  timeout: 10000,
                },
                (res) => {
                  if (res.statusCode !== 200) {
                    reject(new Error(`Failed to fetch: HTTP ${res.statusCode}`));
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

              request.on('error', reject);
              request.on('timeout', () => {
                request.destroy();
                reject(new Error('Request timeout'));
              });
            });

            // 保存缓存到节点配置中（首次获取时）
            const nodeRepo = app.db.getRepository('flow_nodes');
            await nodeRepo.update({
              filterByTk: node.id,
              values: {
                config: {
                  ...node.config,
                  codeCache: {
                    content: actualCode,
                    timestamp: Date.now(), // 保留 timestamp 用于记录，但不用于验证
                  },
                },
              },
            });
            app.logger.info(`[Workflow Node ${node.id}] Remote code fetched and cached successfully (fallback mode)`);
          }
        }
      } catch (error) {
        const app = processor.options.plugin.app;
        app.logger.error('Failed to fetch remote code for script node', {
          error: error instanceof Error ? error.message : String(error),
          nodeId: node.id,
          codeUrl,
        });
        // 如果远程获取失败，尝试使用缓存作为后备
        const codeCache = node.config.codeCache as { content: string; timestamp?: number } | undefined;
        if (codeCache?.content) {
          app.logger.warn(`[Workflow Node ${node.id}] Remote fetch failed, using cached code as fallback`);
          actualCode = codeCache.content;
        } else if (!code) {
          // 如果没有缓存也没有本地代码，抛出错误
          throw new Error(`Failed to fetch remote code: ${error instanceof Error ? error.message : String(error)}`);
        } else {
          // 如果本地有代码，继续使用本地代码
          app.logger.warn(`[Workflow Node ${node.id}] Remote code fetch failed, falling back to local code`);
          actualCode = code;
        }
      }
    }
    // 1. 获取数据源
    let data = {};

    switch (sourceArray.length) {
      case 0: {
        // 无数据源,使用默认值
        data = {};
        break;
      }
      case 1: {
        // 单数据源, 平铺为单对象; 忽略keyName
        const keyName = sourceArray[0]['keyName'];
        const sourcePath = sourceArray[0]['sourcePath'];
        const rawData = processor.getParsedValue(sourcePath, node.id);
        // NOTE: 后来想了想, 发现还是统一用法比较好. 所以提供统一的用法, 同时保留原本的用法; 如果提供了keyName 就是统一的用法, 如果没有, 就是平铺.
        if (keyName) {
          data = {
            [keyName]: rawData,
          };
        } else {
          data = rawData;
        }
        break;
      }
      default: {
        // 多个数据源, 进行合并
        data = sourceArray.reduce(
          (cookedData, { keyName, sourcePath }) => ({
            ...cookedData,
            [keyName]: processor.getParsedValue(sourcePath, node.id),
          }),
          {},
        );
      }
    }

    try {
      // 2. 根据 type 类型, 对源数据进行复杂数据映射
      let result = {};
      switch (type) {
        case 'jsonata':
          result = await convertByJSONata(actualCode, data);
          break;
        case 'js':
          result = await convertByJsCode(actualCode, data);
          break;
        case 'ts':
          result = await convertByTsCode(actualCode, data, processor);
          break;
        default:
      }

      // 3. 将结果集, 进行简单数据映射
      if (typeof result === 'object' && result && model?.length) {
        if (Array.isArray(result)) {
          result = result.map((item) => mapModel(item, model));
        } else {
          result = mapModel(result, model);
        }
      }

      // 4. 返回结果集, 和节点执行状态
      return {
        result,
        status: JOB_STATUS.RESOLVED,
      };
    } catch (err) {
      return {
        result: err.toString(),
        status: JOB_STATUS.ERROR,
      };
    }
  }
}

// utils-JSONata
async function convertByJSONata(code, data) {
  const engine = (expression, data) => jsonata(expression).evaluate(data);
  const result = await engine(code, data);
  return result;
}

// utils-jsCode
async function convertByJsCode(code, data) {
  const ctx = {
    data,
    body: {},
  };
  await evalSimulate(code, {
    ctx,
    lib: {
      log: console.log,
      JSON,
      qrcode,
      crypto,
      jsonata,
      dayjs,
    },
  });

  return ctx.body;
}

async function convertByTsCode(code, data, processor: Processor) {
  const options = processor.options;
  const app = processor.options.plugin.app;

  const compiledCode = transform(code, {
    sourceType: 'module',
    filename: 'a.tsx',
    presets: [
      [
        require('@babel/preset-env'),
        {
          modules: 'commonjs',
          targets: {
            node: 'current',
          },
        },
      ],
      require('@babel/preset-react'),
      require('@babel/preset-typescript'),
    ],
  }).code;

  // 创建一个独立的模块上下文
  const script = new Script(compiledCode);

  const defaultFunction = async (event, context) => {
    return {};
  };

  const contextRequire = function (moduleName: string) {
    // FIXME
    if (moduleName === '@tachybase/utils/client') {
      return require.call(this, '@tachybase/utils');
    }
    if (moduleName === '@tachybase/module-pdf/client') {
      return require.call(this, '@tachybase/module-pdf');
    }
    if (moduleName === '@react-pdf/renderer') {
      return require.call(this, '@tachybase/module-pdf');
    }
    // 拦截逻辑：优先检查自定义模块表
    if (app.modules[moduleName]) {
      return app.modules[moduleName];
    }
    return require.call(this, moduleName);
  };
  Object.assign(contextRequire, require);

  // 创建上下文并加载 Node 的标准模块
  const sandbox = {
    module: {},
    exports: { default: defaultFunction },
    require: contextRequire,
    console,
  };
  createContext(sandbox);

  // 执行代码并导出结果
  try {
    script.runInContext(sandbox);
  } catch (error) {
    app.logger.error('Cloud Component ', { error });
  }

  // 执行默认导出的函数
  const func = sandbox.exports.default;

  const result = await func(data || {}, {
    ...options,
  });

  return result;
}

// utils
function mapModel(data, model) {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid data: data should be a non-null object');
  }

  const result = model.reduce((acc, { path, alias }) => {
    const key = alias ?? path.replace(/\./g, '_');
    const value = _.get(data, path);
    acc[key] = value;

    return acc;
  }, {});

  return result;
}

async function evalSimulate(jsCode, { ctx, lib }) {
  const AsyncFunction: any = async function () {}.constructor;
  return await new AsyncFunction('$root', `with($root) { ${jsCode}; }`)({
    ctx,
    // 允许用户覆盖，这个时候可以使用 _ctx
    __ctx: ctx,
    lib,
  });
}
