import { getApp, sleep } from '@tachybase/plugin-workflow-test';
import { MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { expect } from 'vitest';

import { waitForAssertion, waitForWorkflowIdle } from '../../utils';

const SHORT_REPEAT_MS = 100;

async function sleepUntil(time: Date | number, buffer = 200) {
  await sleep(Math.max(0, (time instanceof Date ? time.getTime() : time) + buffer - Date.now()));
}

function getRecordTriggerTime(record) {
  const triggerTime = new Date(record.createdAt);
  triggerTime.setMilliseconds(0);
  return triggerTime.getTime();
}

function getFutureSecond(seconds = 2) {
  const date = new Date(Date.now() + seconds * 1000);
  date.setMilliseconds(0);
  return date;
}

async function sleepToEvenSecond() {
  const now = Date.now();
  await sleep(1000 - (now % 1000) + 50);
}

function expectRepeatedAfterStart(executions, startTime: number) {
  const d0 = Date.parse(executions[0].context.date);
  expect(d0).toBe(startTime);

  const d1 = Date.parse(executions[1].context.date);
  expect(d1).toBeGreaterThan(startTime);
  expect(d1 - startTime).toBeLessThanOrEqual(2200);
}

async function waitForExecutions(workflow, expected: number, options?: any, timeout = 30000) {
  let executions;

  await waitForAssertion(
    async () => {
      executions = await workflow.getExecutions(options);
      expect(executions.length).toBe(expected);
    },
    timeout,
    50,
  );

  return executions;
}

describe('workflow > triggers > schedule > date field mode', () => {
  let app: MockServer;
  let db: Database;
  let PostRepo;
  let CategoryRepo;
  let WorkflowModel;
  let WorkflowRepo;

  beforeAll(async () => {
    app = await getApp();

    db = app.db;
    const workflow = db.getCollection('workflows');
    WorkflowModel = workflow.model;
    WorkflowRepo = workflow.repository;
    PostRepo = db.getCollection('posts').repository;
    CategoryRepo = db.getCollection('categories').repository;
  });

  beforeEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
    await db.getRepository('jobs').destroy({ filter: {} });
    await db.getRepository('executions').destroy({ filter: {} });
    await db.getRepository('workflows').destroy({ filter: {} });
    await PostRepo.destroy({ filter: {} });
    await CategoryRepo.destroy({ filter: {} });
  });

  afterEach(async () => {
    await WorkflowModel.update({ enabled: false }, { where: { enabled: true } });
    await waitForWorkflowIdle(app);
  });

  afterAll(() => app.destroy());

  describe('configuration', () => {
    it('starts on post.createdAt', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions[0].context.data.id).toBe(post.id);
      const triggerTime = new Date(post.createdAt);
      triggerTime.setMilliseconds(0);
      expect(executions[0].context.date).toBe(triggerTime.toISOString());
    });

    it('starts on post.createdAt with +offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: 1,
          },
        },
      });

      const createdAt = new Date(Date.now() + 1000);
      createdAt.setMilliseconds(0);

      const post = await PostRepo.create({ values: { title: 't1', createdAt } });

      await sleep(300);
      const e1s = await workflow.getExecutions();
      expect(e1s.length).toBe(0);

      const e2s = await waitForExecutions(workflow, 1);
      expect(e2s[0].context.data.id).toBe(post.id);

      expect(e2s[0].context.date).toBe(new Date(createdAt.getTime() + 1000).toISOString());
    });

    it('starts on post.createdAt with -offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: -2,
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await sleep(200);
      const executions = await workflow.getExecutions();
      expect(executions.length).toBe(0);
    });

    it('starts on post.createdAt and repeat by cron with limit 2', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '* * * * * *',
          limit: 2,
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      const startTime = getRecordTriggerTime(post);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime);
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(startTime);
    });

    it('starts on post.createdAt and repeat by interval with endsOn at certain time', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: SHORT_REPEAT_MS,
          endsOn: new Date(Date.now() + 2500).toISOString(),
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      const startTime = getRecordTriggerTime(post);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      expectRepeatedAfterStart(executions, startTime);
    });

    it('starts on post.createdAt and repeat by interval with endsOn by offset', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: SHORT_REPEAT_MS,
          endsOn: {
            field: 'createdAt',
            offset: 2,
          },
        },
      });

      const createdAt = getFutureSecond();
      const post = await PostRepo.create({ values: { title: 't1', createdAt } });
      const startTime = getRecordTriggerTime(post);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      expectRepeatedAfterStart(executions, startTime);
    });

    it('starts on post.createdAt and repeat by cron and limit 1', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: '* * * * * *',
          limit: 1,
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      const startTime = getRecordTriggerTime(post);

      const executions = await waitForExecutions(workflow, 1, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(startTime);
    });

    it('starts on post.createdAt and repeat by interval and limit 2', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: SHORT_REPEAT_MS,
          limit: 2,
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      const startTime = getRecordTriggerTime(post);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      expectRepeatedAfterStart(executions, startTime);
    });

    it('starts on post.createdAt and repeat by number', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: 1000,
          endsOn: {
            field: 'createdAt',
            offset: 2,
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });
      const triggerTime = new Date(post.createdAt);
      triggerTime.setMilliseconds(0);

      const executions = await waitForExecutions(workflow, 2, { order: [['createdAt', 'ASC']] });
      const d0 = Date.parse(executions[0].context.date);
      expect(d0).toBe(triggerTime.getTime());
      const d1 = Date.parse(executions[1].context.date);
      expect(d1 - 2000).toBe(triggerTime.getTime());
    });

    it('appends', async () => {
      const category = await CategoryRepo.create({ values: { name: 'c1' } });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
            offset: 1,
          },
          appends: ['category'],
        },
      });

      const post = await PostRepo.create({ values: { title: 't1', categoryId: category.id } });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions[0].context.data.category.id).toBe(category.id);
    });

    // TODO: requires framework context-passthrough support (tego 1.6.14+)
    it.skip('should persist tenant context for tenant-scoped records', async () => {
      db.collection({
        name: 'tenants',
        fields: [
          { type: 'string', name: 'id', primaryKey: true },
          { type: 'string', name: 'name' },
          { type: 'string', name: 'title' },
          { type: 'boolean', name: 'enabled', defaultValue: true },
        ],
      });
      db.collection({
        name: 'tenant_schedule_posts',
        tenancy: 'tenantScoped',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'string', name: 'tenantId' },
        ],
      });
      await db.sync();

      await db.getRepository('tenants').create({
        values: [
          { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
          { id: 'tenant-b', name: 'tenant-b', title: 'Tenant B', enabled: false },
        ],
      });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'tenant_schedule_posts',
          startsOn: {
            field: 'createdAt',
          },
        },
      });

      await sleepToEvenSecond();

      const TenantSchedulePostRepo = db.getRepository('tenant_schedule_posts');
      const tenantAPost = await TenantSchedulePostRepo.create({
        values: { title: 'a1', tenantId: 'tenant-a' },
        context: {
          state: {
            currentTenant: { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
            currentTenantId: 'tenant-a',
            currentTenantDescendantIds: [],
            currentTenancyMode: 'tenantScoped',
          },
        },
      });
      await TenantSchedulePostRepo.create({ values: { title: 'b1', tenantId: 'tenant-b' } });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions.length).toBe(1);
      expect(executions[0].context.data.id).toBe(tenantAPost.get('id'));
      expect(executions[0].tenantId).toBe('tenant-a');
      expect(executions[0].tenantContext).toMatchObject({
        currentTenant: { id: 'tenant-a', name: 'tenant-a', title: 'Tenant A' },
        currentTenantId: 'tenant-a',
        currentTenantDescendantIds: [],
        currentTenancyMode: 'tenantScoped',
      });
      expect(executions[0].context.state).toMatchObject({
        currentTenantId: 'tenant-a',
        currentTenancyMode: 'tenantScoped',
      });
    });

    // TODO: requires framework context-passthrough support (tego 1.6.14+)
    it.skip('should include descendant tenant ids for tenant-inherited records', async () => {
      db.collection({
        name: 'tenants',
        fields: [
          { type: 'string', name: 'id', primaryKey: true },
          { type: 'string', name: 'name' },
          { type: 'string', name: 'title' },
          { type: 'boolean', name: 'enabled', defaultValue: true },
          { type: 'string', name: 'parentId' },
          { type: 'string', name: 'path' },
        ],
      });
      db.collection({
        name: 'tenant_inherited_schedule_posts',
        tenancy: 'tenantInherited',
        fields: [
          { type: 'string', name: 'title' },
          { type: 'string', name: 'tenantId' },
        ],
      });
      await db.sync();

      await db.getRepository('tenants').create({
        values: [
          { id: 'branch-a', name: 'branch-a', title: 'Branch A', path: '/branch-a/' },
          {
            id: 'dept-a',
            name: 'dept-a',
            title: 'Dept A',
            parentId: 'branch-a',
            path: '/branch-a/dept-a/',
          },
        ],
      });

      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'tenant_inherited_schedule_posts',
          startsOn: {
            field: 'createdAt',
          },
        },
      });

      await sleepToEvenSecond();

      const TenantSchedulePostRepo = db.getRepository('tenant_inherited_schedule_posts');
      const tenantAPost = await TenantSchedulePostRepo.create({
        values: { title: 'a1', tenantId: 'branch-a' },
      });

      const executions = await waitForExecutions(workflow, 1);
      expect(executions[0].context.data.id).toBe(tenantAPost.get('id'));
      expect(executions[0].tenantId).toBe('branch-a');
      expect(executions[0].tenantContext).toMatchObject({
        currentTenant: { id: 'branch-a', name: 'branch-a', title: 'Branch A' },
        currentTenantId: 'branch-a',
        currentTenantDescendantIds: ['dept-a'],
        currentTenancyMode: 'tenantInherited',
      });
      expect(executions[0].context.state).toMatchObject({
        currentTenantId: 'branch-a',
        currentTenantDescendantIds: ['dept-a'],
        currentTenancyMode: 'tenantInherited',
      });
    });

    it('on field changed', async () => {
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'schedule',
        config: {
          mode: 1,
          collection: 'posts',
          startsOn: {
            field: 'createdAt',
          },
          repeat: 1000,
          endsOn: {
            field: 'createdAt',
            offset: 2,
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForAssertion(async () => {
        const e1c = await workflow.countExecutions();
        expect(e1c).toBe(2);
      });

      await post.update({ createdAt: new Date(post.createdAt.getTime() - 1000) });

      await sleepUntil(new Date(post.createdAt).getTime() + 2000, 300);

      const e2c = await workflow.countExecutions();
      expect(e2c).toBe(2);
    });
  });
});
