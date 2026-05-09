import { Application } from '@tego/server';

import { EVENT_SOURCE_QUEUE_COLLECTION, EVENT_SOURCE_QUEUE_STATUS } from '../constants';
import { WebhookController } from '../webhooks/webhooks';

type QueueStage = 'beforeResource' | 'afterResource' | 'customAction';

type QueueJobInput = {
  sourceId: number;
  stage: QueueStage;
  resourceName?: string;
  actionName?: string;
  workflowKey?: string;
  payload: any;
  contextLite?: {
    userId?: number;
    roleName?: string;
  };
  maxAttempts?: number;
  retryBackoffMs?: number;
};

export class EventSourceQueueWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollMs = Number(process.env.EVENT_SOURCE_QUEUE_POLL_MS || 1000);
  private readonly batchSize = Number(process.env.EVENT_SOURCE_QUEUE_BATCH_SIZE || 20);

  constructor(private app: Application) {}

  async enqueue(input: QueueJobInput) {
    const repo = this.app.db.getRepository(EVENT_SOURCE_QUEUE_COLLECTION);
    return repo.create({
      values: {
        sourceId: input.sourceId,
        stage: input.stage,
        resourceName: input.resourceName,
        actionName: input.actionName,
        workflowKey: input.workflowKey,
        payload: input.payload,
        contextLite: input.contextLite || {},
        status: EVENT_SOURCE_QUEUE_STATUS.PENDING,
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 3,
        retryBackoffMs: input.retryBackoffMs ?? 3000,
        nextRunAt: new Date(),
      },
    });
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.app.logger.error('[event-source-queue] tick failed', error);
      });
    }, this.pollMs);
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const repo = this.app.db.getRepository(EVENT_SOURCE_QUEUE_COLLECTION);
      const jobs = await repo.find({
        filter: {
          status: {
            $in: [EVENT_SOURCE_QUEUE_STATUS.PENDING, EVENT_SOURCE_QUEUE_STATUS.FAILED],
          },
          nextRunAt: {
            $lte: new Date(),
          },
        },
        sort: ['createdAt'],
        limit: this.batchSize,
      });

      for (const job of jobs as any[]) {
        await this.processJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: any) {
    const repo = this.app.db.getRepository(EVENT_SOURCE_QUEUE_COLLECTION);
    const attempt = (job.attempt || 0) + 1;
    try {
      await repo.update({
        filter: { id: job.id },
        values: {
          status: EVENT_SOURCE_QUEUE_STATUS.PROCESSING,
          lockedAt: new Date(),
          lockedBy: this.app.name,
          attempt,
        },
      });

      const pseudoCtx = await this.createPseudoContext(job.contextLite);
      const controller = new WebhookController();
      await controller.triggerWorkflow(
        pseudoCtx as any,
        {
          workflowKey: job.workflowKey,
          options: {
            useHttpContext: false,
          },
        },
        job.payload,
      );

      await repo.update({
        filter: { id: job.id },
        values: {
          status: EVENT_SOURCE_QUEUE_STATUS.SUCCESS,
          lastError: null,
        },
      });
    } catch (error) {
      const maxAttempts = Number(job.maxAttempts || 3);
      const retryBackoffMs = Number(job.retryBackoffMs || 3000);
      const dead = attempt >= maxAttempts;
      await repo.update({
        filter: { id: job.id },
        values: {
          status: dead ? EVENT_SOURCE_QUEUE_STATUS.DEAD : EVENT_SOURCE_QUEUE_STATUS.FAILED,
          nextRunAt: dead ? null : new Date(Date.now() + retryBackoffMs),
          lastError: error?.stack || `${error}`,
        },
      });
      this.app.logger.error(
        `[event-source-queue] process failed, jobId=${job.id}, sourceId=${job.sourceId}, attempt=${attempt}, dead=${dead}`,
        error,
      );
    }
  }

  private async createPseudoContext(contextLite?: { userId?: number; roleName?: string }) {
    let currentUser = null;
    if (contextLite?.userId) {
      const userRepo = this.app.db.getRepository('users');
      currentUser = await userRepo.findOne({
        filter: { id: contextLite.userId },
      });
      currentUser = currentUser?.toJSON?.() || currentUser;
    }
    return {
      db: this.app.db,
      tego: this.app,
      state: {
        currentUser,
        currentRole: contextLite?.roleName || null,
      },
    };
  }
}
