import { createServer, Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import PluginWorkflow, { EXECUTION_STATUS, JOB_STATUS, Processor } from '@tachybase/plugin-workflow';
import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import jwt from 'jsonwebtoken';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';

import { waitForAssertion, waitForWorkflowIdle, waitForWorkflowJob } from '../../../__tests__/utils';
import { RequestConfig } from '../RequestInstruction';

const HOST = 'localhost';
const REQUEST_TIMEOUT_MS = 200;
const SLOW_RESPONSE_MS = 300;
const REQUEST_JOB_WAIT_OPTIONS = { timeout: 30000 };

async function listen(server: Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

async function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

class MockAPI {
  app: Koa;
  server: Server;
  port: number;
  sockets = new Set<Socket>();
  get URL_DATA() {
    return `http://${HOST}:${this.port}/api/data`;
  }
  get URL_400() {
    return `http://${HOST}:${this.port}/api/400`;
  }
  get URL_TIMEOUT() {
    return `http://${HOST}:${this.port}/api/timeout`;
  }
  constructor() {
    this.app = new Koa();
    this.app.use(bodyParser());

    this.app.use(async (ctx, next) => {
      if (ctx.path === '/api/400') {
        return ctx.throw(400);
      }
      if (ctx.path === '/api/timeout') {
        await sleep(SLOW_RESPONSE_MS);
        ctx.status = 204;
        return;
      }
      if (ctx.path === '/api/data') {
        await sleep(100);
        ctx.body = {
          meta: { title: ctx.query.title },
          data: { title: ctx.request.body['title'] },
        };
      }
      await next();
    });
  }

  async start() {
    return new Promise((resolve) => {
      this.server = createServer(this.app.callback());
      this.server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => {
          this.sockets.delete(socket);
        });
      });
      this.server.listen(0, () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(true);
      });
    });
  }

  async close() {
    return new Promise((resolve, reject) => {
      const forceCloseTimer = setTimeout(() => {
        for (const socket of this.sockets) {
          socket.destroy();
        }
      }, SLOW_RESPONSE_MS + 1000);
      forceCloseTimer.unref?.();

      this.server.close((error) => {
        clearTimeout(forceCloseTimer);
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  }
}

describe('workflow > instructions > request', () => {
  let app: MockServer;
  let db: Database;
  let PostRepo;
  let PostCollection;
  let ReplyRepo;
  let WorkflowModel;
  let workflow;
  let api: MockAPI;

  beforeAll(async () => {
    api = new MockAPI();
    await api.start();

    app = await getApp({
      resourcer: {
        prefix: '/api',
      },
      plugins: ['users', 'auth', 'workflow-request'],
    });

    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostCollection = db.getCollection('posts');
    PostRepo = PostCollection.repository;
    ReplyRepo = db.getCollection('replies').repository;
  });

  beforeEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await db.getRepository('users').destroy({ filter: {} });
    await db.getRepository('categories').destroy({ filter: {} });
    await PostRepo.destroy({ filter: {} });
    await ReplyRepo.destroy({ filter: {} });

    workflow = await WorkflowModel.create({
      enabled: true,
      type: 'collection',
      config: {
        mode: 1,
        collection: 'posts',
      },
    });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(async () => {
    await api.close();
    await app.destroy();
  });

  describe('request static app routes', () => {
    it('get data', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_DATA,
          method: 'GET',
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
          expect(job.status).toEqual(JOB_STATUS.RESOLVED);
          expect(job.result).toMatchObject({ meta: {}, data: {} });
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it('timeout', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_TIMEOUT,
          method: 'GET',
          timeout: REQUEST_TIMEOUT_MS,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.FAILED);

          expect(job.result).toMatchObject({
            error: {
              code: 'ECONNABORTED',
              message: `timeout of ${REQUEST_TIMEOUT_MS}ms exceeded`,
            },
          });
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it('ignoreFail', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_TIMEOUT,
          method: 'GET',
          timeout: REQUEST_TIMEOUT_MS,
          ignoreFail: true,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.RESOLVED);
          expect(job.result).toMatchObject({
            error: {
              code: 'ECONNABORTED',
              message: `timeout of ${REQUEST_TIMEOUT_MS}ms exceeded`,
            },
          });
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it('response 400', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_400,
          method: 'GET',
          ignoreFail: false,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.FAILED);
          expect(job.result.error.status).toBe(400);
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it('response 400 ignoreFail', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_400,
          method: 'GET',
          timeout: 1000,
          ignoreFail: true,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.RESOLVED);
          expect(job.result.error.status).toBe(400);
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it('request with data', async () => {
      const n1 = await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_DATA,
          method: 'POST',
          data: { title: '{{$context.data.title}}' },
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.RESOLVED);
          expect(job.result.data).toEqual({ title: 't1' });
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    // TODO(bug): should not use ejs
    it('request json data with multiple lines', async () => {
      const n1 = await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_DATA,
          method: 'POST',
          data: { title: '{{$context.data.title}}' },
        } as RequestConfig,
      });

      const title = 't1\n\nline 2';
      await PostRepo.create({
        values: { title },
      });

      await waitForWorkflowJob(
        workflow,
        (execution, [job]) => {
          expect(job.status).toEqual(JOB_STATUS.RESOLVED);
          expect(job.result.data).toEqual({ title });
        },
        REQUEST_JOB_WAIT_OPTIONS,
      );
    });

    it.skip('request inside loop', async () => {
      const n1 = await workflow.createNode({
        type: 'loop',
        config: {
          target: 2,
        },
      });

      const n2 = await workflow.createNode({
        type: 'request',
        upstreamId: n1.id,
        branchIndex: 0,
        config: {
          url: api.URL_DATA,
          method: 'GET',
        },
      });

      await PostRepo.create({ values: { title: 't1' } });

      await waitForWorkflowJob(
        workflow,
        (execution, jobs) => {
          expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
          expect(jobs.length).toBe(3);
          expect(jobs.map((item) => item.status)).toEqual(Array(3).fill(JOB_STATUS.RESOLVED));
          expect(jobs[0].result).toBe(2);
        },
        { jobOptions: { order: [['id', 'ASC']] } },
      );
    });
  });

  describe('request db resource', () => {
    it('request db resource', async () => {
      const user = await db.getRepository('users').create({});

      const token = jwt.sign(
        {
          userId: user.id,
        },
        process.env.APP_KEY,
        {
          expiresIn: '1d',
        },
      );

      const server = createServer(app.callback());
      const port = await listen(server);

      try {
        const n1 = await workflow.createNode({
          type: 'request',
          config: {
            url: `http://localhost:${port}/api/categories`,
            method: 'POST',
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
          } as RequestConfig,
        });

        await PostRepo.create({ values: { title: 't1' } });

        await waitForAssertion(async () => {
          const category = await db.getRepository('categories').findOne({});
          expect(category).toBeTruthy();

          const [execution] = await workflow.getExecutions();
          expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
          const [job] = await execution.getJobs();
          expect(job.status).toBe(JOB_STATUS.RESOLVED);
          expect(job.result.data).toMatchObject({});
        });
      } finally {
        await close(server);
      }
    });
  });

  describe('sync request', () => {
    it('sync trigger', async () => {
      const syncFlow = await WorkflowModel.create({
        type: 'syncTrigger',
        enabled: true,
      });
      await syncFlow.createNode({
        type: 'request',
        config: {
          url: api.URL_DATA,
          method: 'GET',
        } as RequestConfig,
      });

      const workflowPlugin = app.pm.get('workflow') as PluginWorkflow;
      const processor = (await workflowPlugin.trigger(syncFlow, { data: { title: 't1' } })) as Processor;

      const [execution] = await syncFlow.getExecutions();
      expect(processor.execution.id).toEqual(execution.id);
      expect(processor.execution.status).toEqual(execution.status);
      expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result).toMatchObject({ meta: {}, data: {} });
    });
  });
});
