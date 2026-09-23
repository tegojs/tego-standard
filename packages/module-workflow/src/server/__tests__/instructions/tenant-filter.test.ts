import { getApp } from '@tachybase/plugin-workflow-test';
import Database, { Application } from '@tego/server';

import WorkflowPlugin, { JOB_STATUS } from '../..';
import zhCN from '../../../locale/zh-CN.json';
import {
  findWorkflowTenantReadableRecords,
  workflowTenantRecordMutationMissError,
  workflowTenantRecordUnavailableError,
} from '../../helpers/tenant-context';

describe('workflow > instructions > tenant filter', () => {
  let app: Application;
  let db: Database;
  let plugin: WorkflowPlugin;
  let WorkflowModel;
  let TenantPostRepo;

  const collectionName = 'tenant_workflow_posts';
  const tenantContext = {
    currentTenant: { id: 'tenant-a', name: 'tenant-a' },
    currentTenantId: 'tenant-a',
    currentTenantDescendantIds: [],
    currentTenancyMode: 'tenantScoped',
  };

  beforeEach(async () => {
    app = await getApp();
    db = app.db;
    plugin = app.pm.get('workflow') as WorkflowPlugin;
    WorkflowModel = db.getCollection('workflows').model;

    db.collection({
      name: collectionName,
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'tenantId' },
        { type: 'boolean', name: 'published', defaultValue: false },
      ],
    });
    await db.sync();

    TenantPostRepo = db.getRepository(collectionName);
  });

  afterEach(() => app.destroy());

  async function createWorkflowWithNode(type: string, config: Record<string, any>) {
    const workflow = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });

    await workflow.createNode({
      type,
      config: {
        collection: collectionName,
        ...config,
      },
    });

    return workflow;
  }

  async function triggerWorkflow(workflow) {
    await plugin.trigger(
      workflow,
      {
        data: {},
        state: tenantContext,
      },
      {
        context: {
          state: tenantContext,
        },
      },
    );

    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();
    return job;
  }

  async function createSameTitleTenantPosts() {
    const tenantBPost = await TenantPostRepo.create({
      values: { title: 'same-title', tenantId: 'tenant-b' },
      hooks: false,
    });
    const tenantAPost = await TenantPostRepo.create({
      values: { title: 'same-title', tenantId: 'tenant-a' },
      hooks: false,
    });

    return { tenantAPost, tenantBPost };
  }

  function configureLegacyData(options: { allowEditingLegacyData?: boolean } = {}) {
    Object.assign(db.getCollection(collectionName).options, {
      legacyDataTenantIds: ['tenant-a'],
      allowEditingLegacyData: options.allowEditingLegacyData ?? false,
    });
  }

  async function createAssociationCollections(options: { allowEditingLegacyData?: boolean } = {}) {
    const accountCollectionName = 'tenant_workflow_accounts';
    const targetCollectionName = 'tenant_workflow_contacts';
    const sourceCollectionName = 'tenant_workflow_documents';
    db.collection({
      name: accountCollectionName,
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'name' },
        { type: 'string', name: 'tenantId' },
      ],
    });
    db.collection({
      name: targetCollectionName,
      tenancy: 'tenantScoped',
      legacyDataTenantIds: ['tenant-a'],
      allowEditingLegacyData: options.allowEditingLegacyData ?? false,
      fields: [
        { type: 'string', name: 'name' },
        { type: 'string', name: 'tenantId' },
        { type: 'belongsToMany', name: 'accounts', target: accountCollectionName },
      ],
    });
    db.collection({
      name: sourceCollectionName,
      tenancy: 'tenantScoped',
      fields: [
        { type: 'string', name: 'name' },
        { type: 'string', name: 'tenantId' },
        { type: 'belongsTo', name: 'contact', target: targetCollectionName },
        { type: 'belongsToMany', name: 'contacts', target: targetCollectionName },
      ],
    });
    await db.sync();
    return {
      accountRepository: db.getRepository(accountCollectionName),
      sourceCollectionName,
      sourceRepository: db.getRepository(sourceCollectionName),
      targetCollectionName,
      targetRepository: db.getRepository(targetCollectionName),
    };
  }

  describe('mutation miss diagnostics', () => {
    it('distinguishes a deleted record from a tenant visibility failure', async () => {
      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        { findOne: vi.fn().mockResolvedValue(null) },
        { filter: { id: 42 } },
      );

      expect(error.message).toContain('not available');
      expect(error.message).not.toContain(collectionName);
      expect(error.message).not.toContain('42');
      expect(error.stack.split('\n')[0]).toBe(
        `Error: Workflow update failed. Reason: target record "${collectionName}.id"=42 does not exist or was deleted before this node ran. The target record was not modified.`,
      );
      expect(error.stack).toContain('TENANT_RECORD_NOT_FOUND');
      expect(error.stack).toContain(`"collection":"${collectionName}"`);
      expect(error.stack).toContain('"recordKey":42');
    });

    it('diagnoses a record whose tenant changed before the mutation', async () => {
      const foreignRecord = { id: 43, tenantId: 'tenant-b' };
      const repository = {
        findOne: vi.fn().mockResolvedValueOnce(foreignRecord).mockResolvedValueOnce(null),
      };

      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        repository,
        { filter: { id: foreignRecord.id } },
      );

      expect(error.stack).toContain('TENANT_RECORD_INACCESSIBLE');
      expect(error.stack.split('\n')[0]).toBe(
        `Error: Workflow update failed. Reason: target record "${collectionName}.id"=43 exists and belongs to tenant "tenant-b"; current tenant "tenant-a" is not allowed to access it. The target record was not modified.`,
      );
      expect(error.stack).toContain('"recordKey":43');
      expect(error.stack).toContain('"recordTenantId":"tenant-b"');
      expect(repository.findOne).toHaveBeenCalledTimes(2);
    });

    it('diagnoses a record that became read-only legacy data before the mutation', async () => {
      const collection = db.getCollection(collectionName);
      Object.assign(collection.options, {
        legacyDataTenantIds: ['tenant-a'],
        allowEditingLegacyData: false,
      });
      const legacyRecord = { id: 44, tenantId: null };
      const repository = {
        findOne: vi.fn().mockResolvedValueOnce(legacyRecord),
      };

      const error = await workflowTenantRecordMutationMissError({ state: tenantContext }, collection, repository, {
        filter: { id: legacyRecord.id },
      });

      expect(error.stack).toContain('TENANT_RECORD_LEGACY_READ_ONLY');
      expect(error.stack).toContain('"recordTenantId":null');
      expect(repository.findOne).toHaveBeenCalledTimes(1);
    });

    it('diagnoses an unassigned legacy record that the current tenant cannot access', async () => {
      const collection = db.getCollection(collectionName);
      Object.assign(collection.options, {
        legacyDataTenantIds: ['tenant-b'],
        allowEditingLegacyData: false,
      });
      const legacyRecord = { id: 45, tenantId: null };
      const repository = {
        findOne: vi.fn().mockResolvedValueOnce(legacyRecord).mockResolvedValueOnce(null),
      };

      const error = await workflowTenantRecordMutationMissError({ state: tenantContext }, collection, repository, {
        filter: { id: legacyRecord.id },
      });

      expect(error.stack.split('\n')[0]).toBe(
        `Error: Workflow update failed. Reason: target record "${collectionName}.id"=45 exists but is unassigned legacy data. Current tenant "tenant-a" is not configured to access legacy data in collection "${collectionName}". The target record was not modified.`,
      );
      expect(error.stack).toContain('TENANT_RECORD_LEGACY_INACCESSIBLE');
      expect(error.stack).toContain('"recordTenantId":null');
      expect(repository.findOne).toHaveBeenCalledTimes(2);
    });

    it('diagnoses a filter change without allowing stack-line injection', async () => {
      const recordKey = '44\n[tenant-diagnostic] forged';
      const currentRecord = { id: recordKey, tenantId: 'tenant-a' };
      const repository = {
        findOne: vi.fn().mockResolvedValueOnce(currentRecord).mockResolvedValueOnce(currentRecord),
      };

      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        repository,
        { filterByTk: recordKey },
      );

      expect(error.stack).toContain('TENANT_RECORD_FILTER_CHANGED');
      expect(error.stack).toContain('44\\n[tenant-diagnostic] forged');
      expect(error.stack.split('\n').filter((line) => line.startsWith('[tenant-diagnostic]'))).toHaveLength(1);
    });

    it('localizes the human-readable stack summary', async () => {
      app.i18n.addResourceBundle('zh-CN', 'workflow', zhCN, true, true);
      const context = {
        state: tenantContext,
        t: (key: string, options: Record<string, any>) => app.i18n.t(key, { ...options, lng: 'zh-CN' }),
      };
      const error = await workflowTenantRecordMutationMissError(
        context,
        db.getCollection(collectionName),
        { findOne: vi.fn().mockResolvedValue(null) },
        { filter: { $and: [{ id: { $eq: null } }] } },
      );

      expect(error.stack.split('\n')[0]).toBe(
        `Error: 工作流更新失败。原因：操作条件中的目标记录主键（${collectionName}.id）值为 null，系统无法确定要更新哪条记录。请检查筛选条件 $and[0].id.$eq 的值；如果它来自工作流变量，请检查对应的上游输出。未对目标记录执行更新操作。`,
      );
      expect(error.stack.split('\n')[1]).toContain('"reason":"TENANT_RECORD_FILTER_UNRESOLVED"');
    });

    it('localizes the target collection in an inaccessible legacy association diagnostic', () => {
      app.i18n.addResourceBundle('zh-CN', 'workflow', zhCN, true, true);
      const context = {
        state: tenantContext,
        t: (key: string, options: Record<string, any>) => app.i18n.t(key, { ...options, lng: 'zh-CN' }),
      };

      const error = workflowTenantRecordUnavailableError(context, {
        reason: 'TENANT_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE',
        operation: 'associate',
        sourceCollection: 'documents',
        association: 'contact',
        targetCollection: 'contacts',
        recordKeyField: 'id',
        recordKey: 46,
        currentTenantId: 'tenant-a',
        recordTenantId: null,
      });

      expect(error.stack.split('\n')[0]).toBe(
        'Error: 工作流关联校验失败。原因：集合 documents 的关联字段 contact 引用了记录 contacts.id=46。该关联记录存在，但它是未归属租户的历史数据；当前租户 tenant-a 未配置为可访问集合 contacts 的历史数据。关联写入已被拒绝。',
      );
    });

    it('uses the complete string key for diagnosis and truncates only the stack output', async () => {
      const recordKey = 'k'.repeat(600);
      const repository = { findOne: vi.fn().mockResolvedValue(null) };

      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        repository,
        { filterByTk: recordKey },
      );

      expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ filter: { id: recordKey } }));
      expect(error.stack).toContain('...[truncated]');
      expect(error.stack).not.toContain(recordKey);
    });

    it('does not treat a nested association key as the collection target key', async () => {
      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        { findOne: vi.fn().mockResolvedValue(null) },
        { filter: { contact: { id: { $eq: null } } } },
      );

      expect(error.stack).toContain('TENANT_RECORD_NOT_FOUND_OR_FILTER_CHANGED');
      expect(error.stack).not.toContain('TENANT_RECORD_FILTER_UNRESOLVED');
    });

    it('uses a nested target key filter when filterByTk is unresolved', async () => {
      const repository = { findOne: vi.fn().mockResolvedValue(null) };
      const error = await workflowTenantRecordMutationMissError(
        { state: tenantContext },
        db.getCollection(collectionName),
        repository,
        {
          filterByTk: null,
          filter: { $and: [{ id: { $eq: 45 } }] },
        },
      );

      expect(repository.findOne).toHaveBeenCalledWith(expect.objectContaining({ filter: { id: 45 } }));
      expect(error.stack).toContain('TENANT_RECORD_NOT_FOUND');
      expect(error.stack).toContain('"recordKey":45');
      expect(error.stack).not.toContain('TENANT_RECORD_FILTER_UNRESOLVED');
    });
  });

  it('query should only read records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('query', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.id).toBe(tenantAPost.id);
    expect(job.result.tenantId).toBe('tenant-a');
  });

  it('query should read legacy records when the execution tenant is configured for legacy data', async () => {
    configureLegacyData();
    const legacyPost = await TenantPostRepo.create({
      values: { title: 'legacy-post', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('query', {
      params: { filter: { id: legacyPost.id } },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.id).toBe(legacyPost.id);
    expect(job.result.tenantId).toBeNull();
  });

  it('query should not apply the execution tenancy mode to a shared collection', async () => {
    const user = await db.getRepository('users').create({
      values: {
        nickname: 'shared-workflow-user',
        username: 'shared-workflow-user',
      },
    });
    const workflow = await createWorkflowWithNode('query', {
      collection: 'users',
      params: {
        filter: {
          id: user.get('id'),
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.id).toBe(user.get('id'));
  });

  it('select should only read records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('select', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.id).toBe(tenantAPost.id);
    expect(job.result.tenantId).toBe('tenant-a');
  });

  it('select should read current tenant and descendants in tenantInherited mode', async () => {
    const inheritedCollectionName = 'tenant_workflow_inherited_posts';
    db.collection({
      name: inheritedCollectionName,
      tenancy: 'tenantInherited',
      fields: [
        { type: 'string', name: 'title' },
        { type: 'string', name: 'tenantId' },
      ],
    });
    await db.sync();
    const repo = db.getRepository(inheritedCollectionName);
    await repo.create({
      values: [
        { title: 'visible-parent', tenantId: 'tenant-a' },
        { title: 'visible-child', tenantId: 'tenant-child' },
        { title: 'hidden-sibling', tenantId: 'tenant-b' },
      ],
      hooks: false,
    });
    const workflow = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });
    await workflow.createNode({
      type: 'select',
      config: {
        collection: inheritedCollectionName,
        multiple: true,
        params: {
          sort: [{ field: 'title' }],
        },
      },
    });
    const inheritedTenantContext = {
      currentTenant: { id: 'tenant-a', name: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenantDescendantIds: ['tenant-child'],
      currentTenancyMode: 'tenantInherited',
    };

    await plugin.trigger(
      workflow,
      {
        data: {},
        state: inheritedTenantContext,
      },
      {
        context: {
          state: inheritedTenantContext,
        },
      },
    );

    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.map((item: any) => item.title)).toEqual(['visible-child', 'visible-parent']);
    expect(job.result.map((item: any) => item.tenantId).sort()).toEqual(['tenant-a', 'tenant-child']);
  });

  it('update should only modify records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: {
          title: 'same-title',
        },
        values: {
          published: true,
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result.length).toBe(1);
    await tenantAPost.reload();
    await tenantBPost.reload();
    expect(tenantAPost.published).toBe(true);
    expect(tenantBPost.published).toBe(false);
  });

  it('update should claim and modify a legacy record when legacy editing is enabled', async () => {
    configureLegacyData({ allowEditingLegacyData: true });
    const legacyPost = await TenantPostRepo.create({
      values: { title: 'claimable-legacy', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: { id: legacyPost.id },
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.length).toBe(1);
    await legacyPost.reload();
    expect(legacyPost.tenantId).toBe('tenant-a');
    expect(legacyPost.published).toBe(true);
  });

  it('update should reject a read-only legacy record instead of succeeding with zero rows', async () => {
    configureLegacyData();
    const legacyPost = await TenantPostRepo.create({
      values: { title: 'read-only-legacy', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: { id: legacyPost.id },
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('legacy');
    await legacyPost.reload();
    expect(legacyPost.tenantId).toBeNull();
    expect(legacyPost.published).toBe(false);
  });

  it('update should resolve with zero rows when no record matches', async () => {
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: { id: 999999 },
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toMatchObject({ length: 0, data: [] });
  });

  it('update should reject a matching record owned by another tenant', async () => {
    const foreignPost = await TenantPostRepo.create({
      values: { title: 'foreign-only-update', tenantId: 'tenant-b' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: { id: foreignPost.id },
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(collectionName);
    expect(job.result.message).not.toContain(`${foreignPost.id}`);
    expect(job.result.stack).toContain('TENANT_RECORD_INACCESSIBLE');
    expect(job.result.stack).toContain(`"collection":"${collectionName}"`);
    expect(job.result.stack).toContain(`"recordKey":${foreignPost.id}`);
    expect(job.result.stack).toContain('"recordTenantId":"tenant-b"');
    expect(job.result.stack).toContain('"currentTenantId":"tenant-a"');
    await foreignPost.reload();
    expect(foreignPost.published).toBe(false);
  });

  it('update should diagnose an unassigned legacy record that the current tenant cannot access', async () => {
    Object.assign(db.getCollection(collectionName).options, {
      legacyDataTenantIds: ['tenant-b'],
      allowEditingLegacyData: false,
    });
    const legacyPost = await TenantPostRepo.create({
      values: { title: 'unreadable-legacy-update', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filter: { id: legacyPost.id },
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(collectionName);
    expect(job.result.message).not.toContain(`${legacyPost.id}`);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow update failed. Reason: target record "${collectionName}.id"=${legacyPost.id} exists but is unassigned legacy data. Current tenant "tenant-a" is not configured to access legacy data in collection "${collectionName}". The target record was not modified.`,
    );
    expect(job.result.stack).toContain('TENANT_RECORD_LEGACY_INACCESSIBLE');
    await legacyPost.reload();
    expect(legacyPost.tenantId).toBeNull();
    expect(legacyPost.published).toBe(false);
  });

  it('update with filterByTk should ignore unrelated legacy records', async () => {
    configureLegacyData();
    await TenantPostRepo.create({ values: { title: 'unrelated-legacy', tenantId: null }, hooks: false });
    const tenantPost = await TenantPostRepo.create({
      values: { title: 'filter-by-tk-update', tenantId: 'tenant-a' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      params: {
        filterByTk: tenantPost.id,
        values: { published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await tenantPost.reload();
    expect(tenantPost.published).toBe(true);
  });

  it('updateorcreate should only update records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('updateorcreate', {
      params: {
        filter: {
          title: 'same-title',
        },
        values: {
          published: true,
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
    await tenantAPost.reload();
    await tenantBPost.reload();
    expect(tenantAPost.published).toBe(true);
    expect(tenantBPost.published).toBe(false);
  });

  it('updateorcreate should inject execution tenant when creating a missing record', async () => {
    const workflow = await createWorkflowWithNode('updateorcreate', {
      params: {
        filter: {
          title: 'upsert-created',
        },
        values: {
          title: 'upsert-created',
          tenantId: 'tenant-b',
          published: true,
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.title).toBe('upsert-created');
    expect(job.result.tenantId).toBe('tenant-a');

    const posts = await TenantPostRepo.find({ filter: { title: 'upsert-created' } });
    expect(posts).toHaveLength(1);
    expect(posts[0].tenantId).toBe('tenant-a');
    expect(posts[0].published).toBe(true);
  });

  it('updateorcreate should still create missing records in shared collections', async () => {
    const workflow = await createWorkflowWithNode('updateorcreate', {
      collection: 'users',
      params: {
        filter: { username: 'shared-upsert-user' },
        values: {
          username: 'shared-upsert-user',
          nickname: 'Shared upsert user',
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.username).toBe('shared-upsert-user');
    expect(await db.getRepository('users').findOne({ filter: { username: 'shared-upsert-user' } })).toBeTruthy();
  });

  it('updateorcreate should not create a duplicate when a matching legacy record is read-only', async () => {
    configureLegacyData();
    await TenantPostRepo.create({
      values: { title: 'legacy-upsert', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('updateorcreate', {
      params: {
        filter: { title: 'legacy-upsert' },
        values: { title: 'legacy-upsert', published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('legacy');
    const posts = await TenantPostRepo.find({ filter: { title: 'legacy-upsert' } });
    expect(posts).toHaveLength(1);
    expect(posts[0].tenantId).toBeNull();
    expect(posts[0].published).toBe(false);
  });

  it('updateorcreate with filterByTk should create when only an unrelated legacy record exists', async () => {
    configureLegacyData();
    await TenantPostRepo.create({ values: { title: 'unrelated-upsert-legacy', tenantId: null }, hooks: false });
    const workflow = await createWorkflowWithNode('updateorcreate', {
      params: {
        filterByTk: 999999,
        values: { title: 'filter-by-tk-created', published: true },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.title).toBe('filter-by-tk-created');
    expect(job.result.tenantId).toBe('tenant-a');
  });

  it('destroy should only remove records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('destroy', {
      params: {
        filter: {
          title: 'same-title',
        },
      },
    });
    const { tenantAPost, tenantBPost } = await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
    expect(await TenantPostRepo.findById(tenantAPost.id)).toBeNull();
    expect(await TenantPostRepo.findById(tenantBPost.id)).toBeTruthy();
  });

  it('destroy should reject a legacy record instead of succeeding with zero rows', async () => {
    configureLegacyData({ allowEditingLegacyData: true });
    const legacyPost = await TenantPostRepo.create({
      values: { title: 'legacy-destroy', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('destroy', {
      params: { filter: { id: legacyPost.id } },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('legacy');
    expect(await TenantPostRepo.findById(legacyPost.id)).toBeTruthy();
  });

  it('destroy with filterByTk should ignore unrelated legacy records', async () => {
    configureLegacyData();
    await TenantPostRepo.create({ values: { title: 'unrelated-destroy-legacy', tenantId: null }, hooks: false });
    const tenantPost = await TenantPostRepo.create({
      values: { title: 'filter-by-tk-destroy', tenantId: 'tenant-a' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('destroy', {
      params: { filterByTk: tenantPost.id },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(await TenantPostRepo.findById(tenantPost.id)).toBeNull();
  });

  it('destroy should diagnose a record that no longer exists', async () => {
    const missingRecordId = 999999;
    const workflow = await createWorkflowWithNode('destroy', {
      params: { filterByTk: missingRecordId },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(collectionName);
    expect(job.result.message).not.toContain(`${missingRecordId}`);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow delete failed. Reason: target record "${collectionName}.id"=${missingRecordId} does not exist or was deleted before this node ran. The target record was not modified.`,
    );
    expect(job.result.stack).toContain('TENANT_RECORD_NOT_FOUND');
    expect(job.result.stack).toContain(`"collection":"${collectionName}"`);
    expect(job.result.stack).toContain(`"recordKey":${missingRecordId}`);
    expect(job.result.stack).toContain('"currentTenantId":"tenant-a"');
  });

  it('destroy should diagnose an unresolved target key filter', async () => {
    const workflow = await createWorkflowWithNode('destroy', {
      params: {
        filter: {
          $and: [{ id: { $eq: null } }],
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow delete failed. Reason: the target record key ("${collectionName}.id") is null, so the system cannot determine which record to delete. Check the value at filter "$and[0].id.$eq"; if it comes from a workflow variable, check the corresponding upstream output. No delete operation was performed on a target record.`,
    );
    expect(job.result.stack).toContain('TENANT_RECORD_FILTER_UNRESOLVED');
    expect(job.result.stack).toContain('"recordKeyField":"id"');
    expect(job.result.stack).toContain('"filterPath":"$and[0].id.$eq"');
    expect(job.result.stack).toContain('"filterValueType":"null"');
  });

  it('destroy should diagnose a record owned by another tenant', async () => {
    const foreignPost = await TenantPostRepo.create({
      values: { title: 'foreign-only-destroy', tenantId: 'tenant-b' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('destroy', {
      params: { filterByTk: foreignPost.id },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(collectionName);
    expect(job.result.message).not.toContain(`${foreignPost.id}`);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow delete failed. Reason: target record "${collectionName}.id"=${foreignPost.id} exists and belongs to tenant "tenant-b"; current tenant "tenant-a" is not allowed to access it. The target record was not modified.`,
    );
    expect(job.result.stack).toContain('TENANT_RECORD_INACCESSIBLE');
    expect(job.result.stack).toContain(`"collection":"${collectionName}"`);
    expect(job.result.stack).toContain(`"recordKey":${foreignPost.id}`);
    expect(job.result.stack).toContain('"recordTenantId":"tenant-b"');
    expect(job.result.stack).toContain('"currentTenantId":"tenant-a"');
    expect(await TenantPostRepo.findById(foreignPost.id)).toBeTruthy();
  });

  it('aggregate should only count records from the execution tenant', async () => {
    const workflow = await createWorkflowWithNode('aggregate', {
      aggregator: 'count',
      params: {
        field: 'id',
        filter: {
          title: 'same-title',
        },
      },
    });
    await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.result).toBe(1);
  });

  it('should preserve non-object array values while stripping tenant filters', async () => {
    const workflow = await createWorkflowWithNode('query', {
      multiple: true,
      params: {
        filter: {
          $and: [
            {
              title: {
                $in: ['same-title', '', false, 0],
              },
            },
            {
              tenantId: 'tenant-b',
            },
          ],
        },
      },
    });
    await createSameTitleTenantPosts();

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result).toHaveLength(1);
    expect(job.result[0].tenantId).toBe('tenant-a');
  });

  it('create should inject tenantId from execution context', async () => {
    const workflow = await createWorkflowWithNode('create', {
      params: {
        values: {
          title: 'new-post',
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(job.result.title).toBe('new-post');
    expect(job.result.tenantId).toBe('tenant-a');

    const allPosts = await TenantPostRepo.find({ filter: { title: 'new-post' } });
    expect(allPosts.length).toBe(1);
    expect(allPosts[0].tenantId).toBe('tenant-a');
  });

  it('create should reference legacy associated data without claiming it', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections();
    const legacyContact = await targetRepository.create({
      values: { name: 'legacy-contact', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        values: {
          name: 'document-with-legacy-contact',
          contact: { id: legacyContact.id },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await legacyContact.reload();
    expect(legacyContact.tenantId).toBeNull();
    const document = await sourceRepository.findOne({
      filter: { name: 'document-with-legacy-contact' },
      appends: ['contact'],
    });
    expect(document.contact.id).toBe(legacyContact.id);
  });

  it('create should discard empty association placeholders', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections();
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        updateAssociationValues: ['contacts'],
        values: {
          name: 'document-with-placeholders',
          contacts: [{}],
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    expect(await targetRepository.count()).toBe(0);
    const document = await sourceRepository.findOne({
      filter: { name: 'document-with-placeholders' },
      appends: ['contacts'],
    });
    expect(document.contacts).toEqual([]);
  });

  it('create should reject associated data owned by another tenant', async () => {
    const { sourceCollectionName, sourceRepository, targetCollectionName, targetRepository } =
      await createAssociationCollections();
    const otherTenantContact = await targetRepository.create({
      values: { name: 'other-contact', tenantId: 'tenant-b' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        values: {
          name: 'invalid-document',
          contact: { id: otherTenantContact.id },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(targetCollectionName);
    expect(job.result.message).not.toContain(`${otherTenantContact.id}`);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow association validation failed. Reason: field "contact" on collection "${sourceCollectionName}" references record "${targetCollectionName}.id"=${otherTenantContact.id}. The record exists and belongs to tenant "tenant-b"; current tenant "tenant-a" is not allowed to access it. The association write was rejected.`,
    );
    expect(job.result.stack).toContain('TENANT_ASSOCIATION_RECORD_INACCESSIBLE');
    expect(job.result.stack).toContain(`"sourceCollection":"${sourceCollectionName}"`);
    expect(job.result.stack).toContain('"association":"contact"');
    expect(job.result.stack).toContain(`"targetCollection":"${targetCollectionName}"`);
    expect(job.result.stack).toContain(`"recordKey":${otherTenantContact.id}`);
    expect(job.result.stack).toContain('"recordTenantId":"tenant-b"');
    expect(job.result.stack).toContain('"currentTenantId":"tenant-a"');
    expect(await sourceRepository.findOne({ filter: { name: 'invalid-document' } })).toBeNull();
  });

  it('create should diagnose an associated record that no longer exists', async () => {
    const missingRecordId = 999999;
    const { sourceCollectionName, sourceRepository, targetCollectionName } = await createAssociationCollections();
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        values: {
          name: 'document-with-missing-contact',
          contact: { id: missingRecordId },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('not available');
    expect(job.result.message).not.toContain(targetCollectionName);
    expect(job.result.message).not.toContain(`${missingRecordId}`);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow association validation failed. Reason: field "contact" on collection "${sourceCollectionName}" references record "${targetCollectionName}.id"=${missingRecordId}, but that related record does not exist or has been deleted. The association write was rejected.`,
    );
    expect(job.result.stack).toContain('TENANT_ASSOCIATION_RECORD_NOT_FOUND');
    expect(job.result.stack).toContain(`"sourceCollection":"${sourceCollectionName}"`);
    expect(job.result.stack).toContain('"association":"contact"');
    expect(job.result.stack).toContain(`"targetCollection":"${targetCollectionName}"`);
    expect(job.result.stack).toContain(`"recordKey":${missingRecordId}`);
    expect(job.result.stack).toContain('"currentTenantId":"tenant-a"');
    expect(await sourceRepository.findOne({ filter: { name: 'document-with-missing-contact' } })).toBeNull();
  });

  it('create should diagnose an unassigned legacy association that the current tenant cannot access', async () => {
    const { sourceCollectionName, sourceRepository, targetCollectionName, targetRepository } =
      await createAssociationCollections();
    db.getCollection(targetCollectionName).options.legacyDataTenantIds = ['tenant-b'];
    const legacyContact = await targetRepository.create({
      values: { name: 'unreadable-legacy-contact', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        values: {
          name: 'document-with-unreadable-legacy-contact',
          contact: { id: legacyContact.id },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.stack.split('\n')[0]).toBe(
      `Error: Workflow association validation failed. Reason: field "contact" on collection "${sourceCollectionName}" references record "${targetCollectionName}.id"=${legacyContact.id}. The related record exists but is unassigned legacy data, and current tenant "tenant-a" is not configured to access legacy data in collection "${targetCollectionName}". The association write was rejected.`,
    );
    expect(job.result.stack).toContain('TENANT_ASSOCIATION_RECORD_LEGACY_INACCESSIBLE');
    expect(await sourceRepository.findOne({ filter: { name: 'document-with-unreadable-legacy-contact' } })).toBeNull();
  });

  it('create should allow readable descendant associations to be referenced and updated in inherited mode', async () => {
    const { sourceCollectionName, sourceRepository, targetCollectionName, targetRepository } =
      await createAssociationCollections();
    db.getCollection(targetCollectionName).options.tenancy = 'tenantInherited';
    const descendantContact = await targetRepository.create({
      values: { name: 'descendant-contact', tenantId: 'tenant-child' },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('create', {
      collection: sourceCollectionName,
      params: {
        updateAssociationValues: ['contact'],
        values: {
          name: 'inherited-document',
          contact: { id: descendantContact.id, name: 'updated-descendant-contact' },
        },
      },
    });
    const inheritedContext = {
      ...tenantContext,
      currentTenantDescendantIds: ['tenant-child'],
      currentTenancyMode: 'tenantInherited',
    };

    await plugin.trigger(workflow, { data: {}, state: inheritedContext }, { context: { state: inheritedContext } });
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    const document = await sourceRepository.findOne({
      filter: { name: 'inherited-document' },
      appends: ['contact'],
    });
    expect(document.contact.id).toBe(descendantContact.id);
    await descendantContact.reload();
    expect(descendantContact.name).toBe('updated-descendant-contact');
    expect(descendantContact.tenantId).toBe('tenant-child');
  });

  it('update should claim legacy associated data only when that target is actually edited', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections({
      allowEditingLegacyData: true,
    });
    const legacyContact = await targetRepository.create({
      values: { name: 'legacy-contact', tenantId: null },
      hooks: false,
    });
    const document = await sourceRepository.create({
      values: {
        name: 'editable-document',
        tenantId: 'tenant-a',
        contact: { id: legacyContact.id },
      },
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: document.id },
        updateAssociationValues: ['contact'],
        values: {
          contact: { id: legacyContact.id, name: 'claimed-contact' },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await legacyContact.reload();
    expect(legacyContact.name).toBe('claimed-contact');
    expect(legacyContact.tenantId).toBe('tenant-a');
  });

  it('update should reject edits to read-only legacy associated data', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections();
    const legacyContact = await targetRepository.create({
      values: { name: 'read-only-contact', tenantId: null },
      hooks: false,
    });
    const document = await sourceRepository.create({
      values: {
        name: 'document-with-read-only-contact',
        tenantId: 'tenant-a',
        contact: { id: legacyContact.id },
      },
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: document.id },
        updateAssociationValues: ['contact'],
        values: {
          contact: { id: legacyContact.id, name: 'must-not-change' },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.ERROR);
    expect(job.result.message).toContain('legacy');
    await legacyContact.reload();
    expect(legacyContact.name).toBe('read-only-contact');
    expect(legacyContact.tenantId).toBeNull();
  });

  it('update should not claim an unchanged expanded legacy association graph', async () => {
    const { accountRepository, sourceCollectionName, sourceRepository, targetRepository } =
      await createAssociationCollections({ allowEditingLegacyData: true });
    const account = await accountRepository.create({
      values: { name: 'existing-account', tenantId: 'tenant-a' },
      hooks: false,
    });
    const legacyContact = await targetRepository.create({
      values: {
        name: 'expanded-legacy-contact',
        tenantId: null,
        accounts: [{ id: account.id }],
      },
    });
    const document = await sourceRepository.create({
      values: {
        name: 'document-with-expanded-contact',
        tenantId: 'tenant-a',
        contact: { id: legacyContact.id },
      },
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: document.id },
        updateAssociationValues: ['contact', 'contact.accounts'],
        values: {
          name: 'document-with-expanded-contact-updated',
          contact: {
            id: `${legacyContact.id}`,
            name: 'expanded-legacy-contact',
            accounts: [{ id: `${account.id}`, name: 'existing-account' }],
          },
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await legacyContact.reload();
    expect(legacyContact.tenantId).toBeNull();
  });

  it('batch update should retain association changes needed by any matched record', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections();
    const retainedContact = await targetRepository.create({
      values: { name: 'retained-contact', tenantId: 'tenant-a' },
      hooks: false,
    });
    const replacedContact = await targetRepository.create({
      values: { name: 'replaced-contact', tenantId: 'tenant-a' },
      hooks: false,
    });
    const unchangedDocument = await sourceRepository.create({
      values: {
        name: 'batch-document-unchanged',
        tenantId: 'tenant-a',
        contact: { id: retainedContact.id },
      },
    });
    const changedDocument = await sourceRepository.create({
      values: {
        name: 'batch-document-changed',
        tenantId: 'tenant-a',
        contact: { id: replacedContact.id },
      },
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: { $in: [unchangedDocument.id, changedDocument.id] } },
        updateAssociationValues: ['contact'],
        values: { contact: { id: retainedContact.id } },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    const documents = await sourceRepository.find({
      filter: { id: { $in: [unchangedDocument.id, changedDocument.id] } },
      appends: ['contact'],
    });
    expect(documents).toHaveLength(2);
    expect(documents.every((document) => document.contact.id === retainedContact.id)).toBe(true);
  });

  it('update should ignore an unchanged belongs-to foreign key from the persisted record', async () => {
    const { sourceCollectionName, sourceRepository, targetRepository } = await createAssociationCollections();
    const otherTenantContact = await targetRepository.create({
      values: { name: 'persisted-other-tenant-contact', tenantId: 'tenant-b' },
      hooks: false,
    });
    const contactForeignKey = db.getCollection(sourceCollectionName).model.associations.contact.foreignKey;
    const document = await sourceRepository.create({
      values: {
        name: 'document-with-persisted-foreign-key',
        tenantId: 'tenant-a',
        [contactForeignKey]: otherTenantContact.id,
      },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: document.id },
        values: {
          name: 'document-with-persisted-foreign-key-updated',
          [contactForeignKey]: `${otherTenantContact.id}`,
        },
      },
    });

    const job = await triggerWorkflow(workflow);

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await document.reload();
    expect(document.name).toBe('document-with-persisted-foreign-key-updated');
    expect(document.get(contactForeignKey)).toBe(otherTenantContact.id);
  });

  it('update should not load source records when values do not touch associations', async () => {
    const { sourceCollectionName, sourceRepository } = await createAssociationCollections();
    const findSpy = vi.spyOn(sourceRepository, 'find');

    const records = await findWorkflowTenantReadableRecords(
      { state: tenantContext },
      db.getCollection(sourceCollectionName),
      sourceRepository,
      { filter: { name: 'ordinary-update' }, values: { name: 'ordinary-update-finished' } },
    );

    expect(records).toEqual([]);
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('shared collection should update ordinary fields without tenant context', async () => {
    const { sourceCollectionName, sourceRepository } = await createAssociationCollections();
    db.getCollection(sourceCollectionName).options.tenancy = undefined;
    const document = await sourceRepository.create({
      values: { name: 'shared-document', tenantId: null },
      hooks: false,
    });
    const workflow = await createWorkflowWithNode('update', {
      collection: sourceCollectionName,
      params: {
        filter: { id: document.id },
        values: { name: 'shared-document-updated' },
      },
    });
    const state = {};

    await plugin.trigger(workflow, { data: {}, state }, { context: { state } });
    const [execution] = await workflow.getExecutions();
    const [job] = await execution.getJobs();

    expect(job.status).toBe(JOB_STATUS.RESOLVED);
    await document.reload();
    expect(document.name).toBe('shared-document-updated');
  });

  it('create should isolate records between tenants', async () => {
    const workflowA = await createWorkflowWithNode('create', {
      params: {
        values: {
          title: 'isolated-post',
        },
      },
    });

    await plugin.trigger(
      workflowA,
      {
        data: {},
        state: tenantContext,
      },
      {
        context: {
          state: tenantContext,
        },
      },
    );

    const [executionA] = await workflowA.getExecutions();
    const [jobA] = await executionA.getJobs();
    expect(jobA.result.tenantId).toBe('tenant-a');

    const workflowB = await WorkflowModel.create({
      enabled: true,
      type: 'syncTrigger',
    });
    await workflowB.createNode({
      type: 'create',
      config: {
        collection: collectionName,
        params: {
          values: {
            title: 'isolated-post',
          },
        },
      },
    });

    const tenantBContext = {
      currentTenant: { id: 'tenant-b', name: 'tenant-b' },
      currentTenantId: 'tenant-b',
      currentTenantDescendantIds: [],
      currentTenancyMode: 'tenantScoped',
    };

    await plugin.trigger(
      workflowB,
      {
        data: {},
        state: tenantBContext,
      },
      {
        context: {
          state: tenantBContext,
        },
      },
    );

    const [executionB] = await workflowB.getExecutions();
    const [jobB] = await executionB.getJobs();
    expect(jobB.result.tenantId).toBe('tenant-b');

    const allPosts = await TenantPostRepo.find({ filter: { title: 'isolated-post' } });
    expect(allPosts.length).toBe(2);
    const tenantIds = allPosts.map((p) => p.tenantId).sort();
    expect(tenantIds).toEqual(['tenant-a', 'tenant-b']);
  });

  describe('sql instruction tenant isolation boundary', () => {
    it('sql instruction does NOT apply tenant filtering — by design', async () => {
      // The SQL instruction executes raw SQL and bypasses the repository layer.
      // It does NOT call applyTenantFilterToContext() and therefore does not
      // scope queries to the execution's tenant.
      //
      // This test documents that behavior as a deliberate design decision.
      // SQL statements are opaque to the framework and cannot be safely rewritten.
      // Workflow authors must manually include tenantId conditions in their SQL.
      const workflow = await WorkflowModel.create({
        enabled: true,
        type: 'syncTrigger',
      });

      const tableName = TenantPostRepo.collection.model.tableName;
      await workflow.createNode({
        type: 'sql',
        config: {
          sql: `SELECT * FROM ${db.utils.quoteTable(tableName)}`,
        },
      });

      await createSameTitleTenantPosts();

      await plugin.trigger(
        workflow,
        {
          data: {},
          state: tenantContext,
        },
        {
          context: {
            state: tenantContext,
          },
        },
      );

      const [execution] = await workflow.getExecutions();
      const [job] = await execution.getJobs();

      expect(job.status).toBe(JOB_STATUS.RESOLVED);
      // SQL returns ALL rows (both tenant-a and tenant-b) because it does NOT
      // apply tenant filtering. This is the expected behavior.
      const rows = job.result[0]; // sequelize.query returns [rows, metadata]
      expect(rows.length).toBe(2);
    });
  });
});
