import { Action, actions, Context, Controller, Inject, InjectLog, Logger, Next } from '@tego/server';

import { CloudCompiler } from '../services/cloud-compiler';
import { RemoteCodeFetcher } from '../services/remote-code-fetcher';

@Controller('cloudLibraries')
export class CloudLibrariesController {
  @Inject(() => CloudCompiler)
  compiler: CloudCompiler;

  @Inject(() => RemoteCodeFetcher)
  remoteCodeFetcher: RemoteCodeFetcher;

  @InjectLog()
  private logger: Logger;

  @Action('update')
  async update(ctx: Context, next: Next) {
    const {
      name,
      code,
      codeSource = 'local',
      codeType,
      codeUrl,
      codeBranch = 'main',
      codePath,
      module,
      isClient,
      isServer,
      serverPlugin,
      clientPlugin,
      enabled,
      component,
    } = ctx.action.params.values;

    // 根据代码来源决定使用哪份代码进行编译
    let codeToCompile = code;

    // 如果是远程代码，需要从远程获取（这里主要用于保存时的预览编译）
    // 实际运行时的编译在 compileLibraries 中处理
    if (codeSource === 'remote' && codeUrl && codeType && code) {
      // 保存时，如果配置了远程代码，仍然使用本地编辑的代码进行编译
      // 这样可以预览远程代码的修改效果
      // 实际部署时会使用 compileLibraries 中的逻辑
      codeToCompile = code;
    }

    if (codeToCompile) {
      const clientCode = this.compiler.toAmd(codeToCompile);
      const serverCode = this.compiler.toCjs(codeToCompile);
      const { db } = ctx;
      const repo = db.getRepository('effectLibraries');
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

    await actions.update(ctx, next);
  }

  @Action('publish')
  async publish(ctx: Context, next: Next) {
    const {
      code,
      codeSource = 'local',
      codeType,
      codeUrl,
      codeBranch = 'main',
      codePath,
      module,
      isClient,
      isServer,
      serverPlugin,
      clientPlugin,
      enabled,
      component,
    } = ctx.action.params.values;

    // 发布时，根据代码来源决定使用哪份代码
    // 如果是远程代码，实际会在 compileLibraries 中从远程获取
    // 这里主要用于保存配置
    let codeToCompile = code;

    if (codeSource === 'remote' && codeUrl && codeType && code) {
      // 发布时，如果配置了远程代码，使用本地编辑的代码进行编译
      // 实际部署时会使用 compileLibraries 中的逻辑从远程获取
      codeToCompile = code;
    }

    if (codeToCompile) {
      const clientCode = this.compiler.toAmd(codeToCompile);
      const serverCode = this.compiler.toCjs(codeToCompile);
      const { db } = ctx;
      const repo = db.getRepository('effectLibraries');
      repo.updateOrCreate({
        filterKeys: ['module'],
        values: {
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

    await actions.update(ctx, next);
  }

  @Action('destroy')
  async destroy(ctx: Context, next: Next) {
    const { filterByTk } = ctx.action.params;
    const cloudRepo = ctx.db.getRepository('cloudLibraries');
    const effectRepo = ctx.db.getRepository('effectLibraries');
    try {
      await ctx.db.sequelize.transaction(async (transaction) => {
        const cloudComponent = await cloudRepo.findOne({
          filterByTk,
          transaction,
        });

        if (!cloudComponent) {
          throw new Error(`Cloud component with id ${filterByTk} not found`);
        }

        await effectRepo.destroy({
          filter: {
            name: cloudComponent.name,
            module: cloudComponent.module,
          },
          transaction,
        });
        await cloudRepo.destroy({
          filterByTk,
          transaction,
        });
      });
    } catch (error) {
      this.logger.error('Error deleting cloud component:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        filterByTk,
      });
      // 重新抛出错误，让上层处理
      throw error;
    }
  }

  /**
   * 同步远程代码
   * 从远程地址获取代码并返回
   * 注意：此函数用于手动同步，总是获取最新代码，不检查缓存
   * 缓存机制在 cloud-libraries-service.ts 中的编译时使用
   */
  @Action('syncRemoteCode')
  async syncRemoteCode(ctx: Context, next: Next) {
    const params = ctx.action.params.values || ctx.action.params || {};
    const {
      codeUrl,
      codeType,
      codeBranch = 'main',
      codePath,
      codeAuthType,
      codeAuthToken,
      codeAuthUsername,
      recordId,
    } = params;

    if (!codeUrl || !codeType) {
      this.logger.warn('syncRemoteCode: Missing required parameters', { params });
      ctx.throw(400, 'codeUrl and codeType are required');
    }

    try {
      // 手动同步总是获取最新代码，不检查缓存
      this.logger.info(
        `Syncing remote code (force refresh): ${codeUrl} (type: ${codeType}, branch: ${codeBranch || 'main'})`,
      );

      const code = await this.remoteCodeFetcher.fetchCode(
        codeUrl,
        codeType,
        codeBranch,
        codePath,
        codeAuthType,
        codeAuthToken,
        codeAuthUsername,
      );
      ctx.body = {
        code,
      };

      // 如果提供了记录 ID 且同步成功，更新记录的最后同步时间
      if (recordId && code) {
        try {
          const repository = ctx.db.getRepository('cloudLibraries');
          await repository.update({
            filterByTk: recordId,
            values: {
              lastSyncTime: new Date(),
            },
          });
        } catch (error) {
          // 记录错误但不影响同步结果
          this.logger.warn('Failed to update lastSyncTime', {
            error: error instanceof Error ? error.message : String(error),
            recordId,
          });
        }
      }

      await next();
    } catch (error) {
      // 如果错误是 ctx.throw 抛出的，直接重新抛出
      if (ctx.status && ctx.status !== 200) {
        throw error;
      }

      this.logger.error('Failed to sync remote code', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        params,
      });

      ctx.throw(500, `Failed to fetch remote code: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
