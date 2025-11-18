import { Plugin } from '@tego/server';

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { KoaAdapter } from '@bull-board/koa';
import { Queue } from 'bullmq';

export class PluginAdapterBullmqServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    const redisOptions = {
      port: Number(ctx.tego.environment.getVariables().REDIS_PORT || 6379),
      host: ctx.tego.environment.getVariables().REDIS_HOST || 'localhost',
      password: ctx.tego.environment.getVariables().REDIS_PASSWORD || '',
    };

    const defaultQueue = new Queue(ctx.tego.environment.getVariables().MSG_QUEUE_NAME || 'default', {
      connection: redisOptions,
    });

    const serverAdapter = new KoaAdapter();
    createBullBoard({
      queues: [new BullMQAdapter(defaultQueue)],
      serverAdapter,
    });
    const EXTENSION_UI_BASE_PATH = ctx.tego.environment.getVariables().EXTENSION_UI_BASE_PATH || '/adapters/';
    serverAdapter.setBasePath(EXTENSION_UI_BASE_PATH + 'mqui');
    this.app.use(serverAdapter.registerPlugin(), { before: 'bodyParser' });

    this.app.on('beforeStop', async () => {
      await defaultQueue?.close?.();
    });
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginAdapterBullmqServer;
