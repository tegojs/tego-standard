import { Action, actions, Context, Controller, Inject, InjectLog, Logger, Next } from '@tego/server';

import { CloudCompiler } from '../services/cloud-compiler';

@Controller('cloudLibraries')
export class CloudLibrariesController {
  @Inject(() => CloudCompiler)
  compiler: CloudCompiler;

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
}
