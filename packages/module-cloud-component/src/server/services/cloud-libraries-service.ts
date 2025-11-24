import { createContext, Script } from 'node:vm';
import { App, Application, Database, Db, Inject, InjectLog, Logger, Service } from '@tego/server';

import * as babelParser from '@babel/parser';
import traverse from '@babel/traverse';
import Topo from '@hapi/topo';

import { getModuleMappings, resolveModuleName } from '../config/module-mapping';
import { CloudCompiler } from './cloud-compiler';
import { RemoteCodeFetcher } from './remote-code-fetcher';

@Service()
export class CloudLibrariesService {
  @Db()
  db: Database;

  @App()
  app: Application;

  @InjectLog()
  private logger: Logger;

  @Inject(() => CloudCompiler)
  private compiler: CloudCompiler;

  @Inject(() => RemoteCodeFetcher)
  private remoteCodeFetcher: RemoteCodeFetcher;

  async compileLibraries() {
    const libRepo = this.app.db.getRepository('cloudLibraries');
    const libs = await libRepo.find({
      filter: {
        enabled: true,
      },
    });

    const repo = this.app.db.getRepository('effectLibraries');
    for (const lib of libs) {
      const {
        name,
        code: debugCode,
        codeSource = 'local',
        codeType,
        codeUrl,
        codeBranch = 'main',
        codePath,
        codeCache,
        module,
        isClient,
        isServer,
        serverPlugin,
        clientPlugin,
        enabled,
        version,
        component,
        versions,
      } = lib;

      // 根据代码来源确定使用哪份代码
      let code: string;

      if (codeSource === 'remote' && codeUrl && codeType) {
        // 代码来源为远程：使用远程代码
        try {
          // 检查缓存
          if (this.remoteCodeFetcher.isCacheValid(codeCache)) {
            this.logger.info(`[${module}] Using cached remote code`);
            code = codeCache.content;
          } else {
            // 从远程获取代码（使用前端指定的类型）
            this.logger.info(`[${module}] Fetching remote code from ${codeUrl} (type: ${codeType})`);
            code = await this.remoteCodeFetcher.fetchCode(codeUrl, codeType, codeBranch, codePath);

            // 更新缓存
            const libRepo = this.app.db.getRepository('cloudLibraries');
            await libRepo.update({
              filterByTk: lib.id,
              values: {
                codeCache: {
                  content: code,
                  timestamp: Date.now(),
                },
              },
            });
            this.logger.info(`[${module}] Remote code fetched and cached successfully`);
          }
        } catch (error) {
          this.logger.error(`[${module}] Failed to fetch remote code`, {
            error: error instanceof Error ? error.message : String(error),
          });
          // 如果远程获取失败，使用缓存或本地代码作为后备
          if (codeCache?.content) {
            this.logger.warn(`[${module}] Using cached code as fallback`);
            code = codeCache.content;
          } else {
            this.logger.warn(`[${module}] Remote code fetch failed, falling back to local code`);
            // 降级到本地代码
            code = debugCode;
            if (version && version !== 'debug') {
              code = versions[Number[version]].code;
            }
          }
        }
      } else {
        // 代码来源为本地：使用本地代码
        code = debugCode;
        // load specified version
        if (version && version !== 'debug') {
          code = versions[Number[version]].code;
        }
        this.logger.debug(`[${module}] Using local code (source: ${codeSource || 'local'})`);
      }

      const clientCode = this.compiler.toAmd(code);
      const serverCode = this.compiler.toCjs(code);
      repo.updateOrCreate({
        filterKeys: ['module'],
        values: {
          name,
          module,
          enabled,
          server: serverCode,
          client: clientCode,
          isClient,
          isServer,
          serverPlugin,
          clientPlugin,
          component,
        },
      });
    }
  }

  async loadServerLibraries() {
    this.logger.info(`load cloudLibrarie: start`);
    const repo = this.app.db.getRepository('effectLibraries');
    const cloudLibraries = await repo.find({
      filter: {
        enabled: true,
        isServer: true,
      },
    });

    const sorter = new Topo.Sorter<{ module: string; server: string }>();

    for (const cloudLibrary of cloudLibraries) {
      // 使用 Babel 解析代码为 AST
      const ast = babelParser.parse(cloudLibrary.server, {
        sourceType: 'script', // CommonJS 使用 script 模式
      });

      // 存储 require 依赖的数组
      const dependencies = [];

      // 遍历 AST 节点
      traverse(ast, {
        CallExpression(path) {
          const callee = path.get('callee');
          if (callee.isIdentifier({ name: 'require' })) {
            const args = path.get('arguments');
            if (args.length > 0 && args[0].isStringLiteral()) {
              dependencies.push(args[0].node.value);
            }
          }
        },
      });
      sorter.add(cloudLibrary, {
        after: dependencies,
        group: cloudLibrary.module,
      });
    }

    // 执行超时时间（毫秒），默认 30 秒
    const EXECUTION_TIMEOUT = 30000;

    for (const cloudLibrary of sorter.nodes) {
      this.logger.info(`Loading cloud library: ${cloudLibrary.module}`);
      const compiledCode = cloudLibrary.server;

      try {
        // 创建一个独立的模块上下文
        const script = new Script(compiledCode);

        const defaultFunction = async (event, context) => {
          return {};
        };

        const that = this;
        const moduleMappings = getModuleMappings();

        const contextRequire = function (moduleName: string) {
          // 1. 优先检查自定义模块表（动态加载的云组件）
          if (that.app.modules[moduleName]) {
            return that.app.modules[moduleName];
          }

          // 2. 应用模块映射规则
          const resolvedModuleName = resolveModuleName(moduleName, moduleMappings);

          // 3. 尝试加载模块
          try {
            return require.call(this, resolvedModuleName);
          } catch (error) {
            // 如果映射后的模块名也找不到，尝试原始模块名
            if (resolvedModuleName !== moduleName) {
              try {
                return require.call(this, moduleName);
              } catch (originalError) {
                that.logger.warn(`Module not found: ${moduleName} (mapped to ${resolvedModuleName})`, {
                  module: cloudLibrary.module,
                  originalError: originalError instanceof Error ? originalError.message : String(originalError),
                  mappedError: error instanceof Error ? error.message : String(error),
                });
                return {};
              }
            } else {
              that.logger.warn(`Module not found: ${moduleName}`, {
                module: cloudLibrary.module,
                meta: error instanceof Error ? error.message : String(error),
              });
              return {};
            }
          }
        };
        Object.assign(contextRequire, require);

        // 创建安全的 console 对象，限制危险操作
        const safeConsole = {
          log: console.log.bind(console),
          info: console.info.bind(console),
          warn: console.warn.bind(console),
          error: console.error.bind(console),
          // 禁止使用 console.clear 和 console.trace 等可能影响调试的操作
        };

        // 创建上下文并加载 Node 的标准模块
        const sandbox = {
          module: {},
          exports: { default: defaultFunction },
          require: contextRequire,
          console: safeConsole,
          // 禁止访问全局对象
          global: undefined,
          process: undefined,
          Buffer: undefined,
          // 禁止使用 eval 和 Function 构造函数
          eval: undefined,
          Function: undefined,
        };
        createContext(sandbox);

        // 执行代码并导出结果
        // 注意：runInContext 是同步的，无法真正中断
        // 我们通过限制沙箱 API 和监控执行时间来增强安全性
        const startTime = Date.now();
        script.runInContext(sandbox);
        const executionTime = Date.now() - startTime;

        if (executionTime > EXECUTION_TIMEOUT) {
          this.logger.warn(
            `Cloud library ${cloudLibrary.module} execution took ${executionTime}ms, exceeding timeout threshold`,
          );
        } else {
          this.logger.debug(`Cloud library ${cloudLibrary.module} executed in ${executionTime}ms`);
        }

        // 将结果存储在 app.modules 中
        this.app.modules[cloudLibrary.module] = sandbox.exports;
        this.logger.info(`Successfully loaded cloud library: ${cloudLibrary.module}`);
      } catch (error) {
        this.logger.error(`Failed to load cloud library: ${cloudLibrary.module}`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        // 继续加载其他库，不中断整个流程
      }
    }
  }

  async load() {
    this.app.acl.allow('effectLibraries', 'list', 'public');
    this.app.on('afterStart', async () => {
      await this.compileLibraries();
      await this.loadServerLibraries();
    });
    this.app.acl.addFixedParams('cloudLibraries', 'destroy', () => {
      return {
        filter: {
          enabled: false,
        },
      };
    });
    this.app.acl.registerSnippet({
      name: 'pm.business-components.cloud-component',
      actions: ['cloudLibraries:*'],
    });
  }
}
