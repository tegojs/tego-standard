import { createServer, Server } from 'node:http';
import PluginWorkflow, { EXECUTION_STATUS, JOB_STATUS, Processor } from '@tachybase/plugin-workflow';
import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { RequestConfig } from '../RequestInstruction';

const HOST = 'localhost';

function getRandomPort() {
  const minPort = 1024;
  const maxPort = 49151;
  return Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort;
}

class MockAPI {
  server: Server;
  port: number;
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
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${HOST}`);

      if (url.pathname === '/api/400') {
        res.writeHead(400).end();
        return;
      }

      if (url.pathname === '/api/timeout') {
        await sleep(2000);
        res.writeHead(204).end();
        return;
      }

      if (url.pathname === '/api/data') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const text = Buffer.concat(chunks).toString();
        const body = text ? JSON.parse(text) : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            meta: { title: url.searchParams.get('title') ?? undefined },
            data: { title: body.title },
          }),
        );
        return;
      }

      res.writeHead(404).end();
    });
  }

  async start() {
    return new Promise((resolve) => {
      this.server.listen(0, () => {
        this.port = this.server.address()['port'];
        resolve(true);
      });
    });
  }

  async close() {
    return new Promise((resolve) => {
      this.server.close(() => {
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

  beforeEach(async () => {
    api = new MockAPI();
    api.start();
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result).toMatchObject({ data: {} });
    });

    it('timeout', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_TIMEOUT,
          method: 'GET',
          timeout: 250,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await sleep(1000);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.FAILED);

      expect(job.result.error).toMatchObject({
        code: 'ECONNABORTED',
        name: 'AxiosError',
        message: 'timeout of 250ms exceeded',
      });

      // NOTE: to wait for the response to finish and avoid non finished promise.
      await sleep(1500);
    });

    it('ignoreFail', async () => {
      await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_TIMEOUT,
          method: 'GET',
          timeout: 250,
          ignoreFail: true,
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await sleep(1000);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result.error).toMatchObject({
        code: 'ECONNABORTED',
        name: 'AxiosError',
        message: 'timeout of 250ms exceeded',
      });
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.FAILED);
      expect(job.result.error.status).toBe(400);
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result.error.status).toBe(400);
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result.data).toEqual({ title: 't1' });
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();
      expect(job.status).toEqual(JOB_STATUS.RESOLVED);
      expect(job.result.data).toEqual({ title });
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

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      expect(execution.status).toEqual(EXECUTION_STATUS.RESOLVED);
      const jobs = await execution.getJobs({ order: [['id', 'ASC']] });
      expect(jobs.length).toBe(3);
      expect(jobs.map((item) => item.status)).toEqual(Array(3).fill(JOB_STATUS.RESOLVED));
      expect(jobs[0].result).toBe(2);
    });
  });

  describe('request db resource', () => {
    it('request db resource', async () => {
      const user = await db.getRepository('users').create({});

      const token = app.authManager.jwt.sign(
        {
          userId: user.id,
        },
        {
          expiresIn: '1d',
        },
      );

      const n1 = await workflow.createNode({
        type: 'request',
        config: {
          url: api.URL_DATA,
          method: 'POST',
          data: { title: 'category from request' },
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        } as RequestConfig,
      });

      await PostRepo.create({ values: { title: 't1' } });

      await sleep(500);

      const [execution] = await workflow.getExecutions();
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      const [job] = await execution.getJobs();
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      expect(job.result.data).toEqual({ title: 'category from request' });
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

      const workflowPlugin = (app.pm.get('workflow') || app.pm.get(PluginWorkflow)) as PluginWorkflow;
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
