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
    const { name, code, module, isClient, isServer, serverPlugin, clientPlugin, enabled, component } =
      ctx.action.params.values;
    if (code) {
      const clientCode = this.compiler.toAmd(code);
      const serverCode = this.compiler.toCjs(code);
      const { db } = ctx;
      const repo = db.getRepository('effectLibraries');
      // FIXME 这里可能不适合取客户端的数据
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
    const { code, module, isClient, isServer, serverPlugin, clientPlugin, enabled, component } =
      ctx.action.params.values;
    if (code) {
      const clientCode = this.compiler.toAmd(code);
      const serverCode = this.compiler.toCjs(code);
      const { db } = ctx;
      const repo = db.getRepository('effectLibraries');
      // FIXME 这里可能不适合取客户端的数据
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
