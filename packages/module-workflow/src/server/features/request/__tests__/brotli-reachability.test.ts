import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import PluginWorkflow, { EXECUTION_STATUS, JOB_STATUS } from '@tachybase/plugin-workflow';
import { getApp } from '@tachybase/plugin-workflow-test';
import type { MockServer } from '@tachybase/test';
import { Gateway } from '@tego/server';

import { waitForWorkflowJob } from '../../../__tests__/utils';

// Safe reachability probes only: every Brotli response is generated from ordinary JSON.
describe('workflow Brotli reachability and permissions', () => {
  let app: MockServer;
  let fixture: http.Server;
  let appServer: http.Server;
  let origin: string;
  let member: ReturnType<MockServer['agent']>;
  let userId: number;
  let decoderCalls = 0;
  const hits: Array<{ url: string; body: string }> = [];
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createBrotliDecompress')!;
  const nativeDecoder = zlib.createBrotliDecompress;
  const downloadedFiles = new Set<string>();
  const marker = { safeProbe: true };

  beforeAll(async () => {
    Object.defineProperty(zlib, 'createBrotliDecompress', {
      ...descriptor,
      value: (...args: Parameters<typeof nativeDecoder>) => {
        decoderCalls++;
        return nativeDecoder(...args);
      },
    });
    fixture = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      hits.push({ url: req.url!, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
      res.end(zlib.brotliCompressSync(Buffer.from(JSON.stringify(marker))));
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    app = await getApp({
      database: { dialect: 'sqlite', storage: ':memory:' },
      registerActions: true,
      acl: true,
      resourcer: { prefix: '/api' },
      plugins: ['users', 'auth', 'acl', 'data-source-manager', 'workflow-request'],
    });
    const user = await app.db.getRepository('users').create({
      values: { username: 'brotli-workflow-member', roles: ['member'] },
    });
    userId = user.id;
    member = app.agent().login(user).set('X-Role', 'member');
    app.db.collection({ name: 'brotli_probe_docs', fields: [{ type: 'json', name: 'file', interface: 'attachment' }] });
    await app.db.sync();
    // Only the post-download storage action is stubbed; URL requests and decoding are real.
    app.resourcer.define({
      name: 'attachments',
      actions: {
        create: async (ctx) => {
          ctx.body = { id: 1, filename: 'safe.json', url: '/safe.json' };
        },
      },
    });
    app.acl.allow('attachments', 'create', 'loggedIn');
    appServer = http.createServer(app.callback());
    await new Promise<void>((resolve) => appServer.listen(Gateway.getInstance().port, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    Object.defineProperty(zlib, 'createBrotliDecompress', descriptor);
    vi.restoreAllMocks();
    for (const server of [appServer, fixture]) {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await app?.destroy();
    for (const file of downloadedFiles) if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  async function makeFlow(config, type = 'request') {
    const flow = await app.db.getCollection('workflows').model.create({ type: 'syncTrigger', enabled: true });
    const node = await flow.createNode({ type, config });
    return { flow, node };
  }

  async function execute(flow, data = {}) {
    const plugin = app.pm.get('workflow') as PluginWorkflow;
    const processor = await plugin.trigger(flow, { data, user: { id: userId } });
    expect(processor).toBeTruthy();
    await waitForWorkflowJob(flow, (execution, [job]) => {
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.status).toBe(JOB_STATUS.RESOLVED);
    });
    const [execution] = await flow.getExecutions();
    const [job] = await execution.getJobs();
    return job;
  }

  it('blocks anonymous workflow triggering before any request or decoding', async () => {
    const { flow } = await makeFlow({ url: `${origin}/anonymous`, method: 'GET', params: [] });
    const before = [hits.length, decoderCalls];
    const res = await app
      .agent()
      .resource('workflows')
      .trigger({
        filterByTk: flow.id,
        updateData: encodeURIComponent(JSON.stringify({})),
      });
    expect([401, 403]).toContain(res.status);
    expect([hits.length, decoderCalls]).toEqual(before);
  });

  it('blocks member node creation and configuration updates', async () => {
    const { flow, node } = await makeFlow({ url: `${origin}/fixed`, method: 'GET', params: [] });
    const create = await member.resource('workflows.nodes', flow.id).create({
      values: { type: 'request', config: { url: `${origin}/member-created` } },
    });
    const update = await member.resource('flow_nodes').update({
      filterByTk: node.id,
      values: { config: { url: `${origin}/member-updated` } },
    });
    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
  });

  it('executes the real HTTP instruction and decodes a valid br response', async () => {
    const { flow } = await makeFlow({ url: `${origin}/fixed`, method: 'GET', params: [] });
    const before = decoderCalls;
    const job = await execute(flow);
    expect(job.result).toMatchObject(marker);
    expect(hits.at(-1)?.url).toBe('/fixed');
    expect(decoderCalls - before).toBe(1);
  });

  it('lets a member influence a URL bound to supplied workflow context and reach the decoder', async () => {
    const { flow } = await makeFlow({
      url: '{{$context.data.updateData.target}}',
      method: 'GET',
      params: [],
    });
    const before = decoderCalls;
    const res = await member.resource('workflows').trigger({
      filterByTk: flow.id,
      updateData: encodeURIComponent(JSON.stringify({ target: `${origin}/member-variable` })),
    });
    expect([401, 403]).not.toContain(res.status);
    await waitForWorkflowJob(flow, (execution, [job]) => {
      expect(execution.status).toBe(EXECUTION_STATUS.RESOLVED);
      expect(job.result).toMatchObject(marker);
    });
    expect(hits.at(-1)?.url).toBe('/member-variable');
    expect(decoderCalls - before).toBe(1);
  });

  it('does not replace a fixed node URL with caller-provided context', async () => {
    const { flow } = await makeFlow({ url: `${origin}/unchanged`, method: 'GET', params: [] });
    await execute(flow, { target: `${origin}/replacement` });
    expect(hits.at(-1)?.url).toBe('/unchanged');
  });

  it('downloads and decodes a multipart file before sending it to the configured destination', async () => {
    const nativeWriteStream = fs.createWriteStream;
    const writeSpy = vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      if (path.dirname(String(args[0])) === os.tmpdir()) downloadedFiles.add(String(args[0]));
      return nativeWriteStream(...args);
    });
    try {
      const { flow } = await makeFlow({
        url: `${origin}/submit`,
        method: 'POST',
        params: [],
        headers: [{ name: 'Content-Type', value: 'multipart/form-data' }],
        data: {
          file: {
            url: '{{$context.data.fileUrl}}',
            headers: { 'Content-Type': 'application/json' },
            params: {},
            body: {},
          },
        },
      });
      const before = decoderCalls;
      await execute(flow, { fileUrl: `${origin}/file` });
      expect(hits.slice(-2).map((hit) => hit.url)).toEqual(['/file', '/submit']);
      expect(hits.at(-1)?.body).toContain(JSON.stringify(marker));
      expect(decoderCalls - before).toBe(2);
      expect(downloadedFiles.size).toBeGreaterThan(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it.each(['create', 'update', 'updateorcreate'])(
    'decodes a URL attachment in the real %s instruction',
    async (type) => {
      const repo = app.db.getRepository('brotli_probe_docs');
      const doc = await repo.create({ values: {} });
      const { flow } = await makeFlow(
        {
          collection: 'brotli_probe_docs',
          params: { filter: { id: doc.id }, values: { file: '{{$context.data.fileUrl}}' } },
        },
        type,
      );
      const before = decoderCalls;
      await execute(flow, { fileUrl: `${origin}/attachment-${type}` });
      expect(hits.at(-1)?.url).toBe(`/attachment-${type}`);
      expect(decoderCalls - before).toBe(1);
    },
  );
});
