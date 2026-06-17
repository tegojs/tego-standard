import { getApp } from '@tachybase/plugin-workflow-test';
import Database, { Application } from '@tego/server';

import { waitForFastAssertion as waitForAssertion } from '../utils';

describe.sequential('workflow > instructions > create', () => {
  let app: Application;
  let db: Database;
  let PostRepo;
  let ReplyRepo;
  let WorkflowModel;
  let workflow;

  async function setupApp(withAnotherDataSource = false) {
    app = await getApp({ withAnotherDataSource });

    db = app.db;
    WorkflowModel = db.getCollection('workflows').model;
    PostRepo = db.getCollection('posts').repository;
    ReplyRepo = db.getCollection('replies').repository;
  }

  async function setupWorkflow() {
    workflow = await WorkflowModel.create({
      title: 'test workflow',
      enabled: true,
      type: 'collection',
      config: {
        mode: 1,
        collection: 'posts',
      },
    });
  }

  async function disableWorkflows() {
    await WorkflowModel.update({ enabled: false }, { where: {} });
  }

  async function waitForLatestJob(assertion) {
    await waitForAssertion(async () => {
      const [execution] = await workflow.getExecutions({ order: [['id', 'desc']] });
      expect(execution).toBeTruthy();

      const [job] = await execution.getJobs();
      expect(job).toBeTruthy();

      await assertion(job, execution);
    });
  }

  describe('create one', () => {
    beforeAll(() => setupApp());
    beforeEach(setupWorkflow);
    afterEach(disableWorkflows);
    afterAll(() => app.destroy());

    it('params: from context', async () => {
      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'comments',
          params: {
            values: {
              postId: '{{$context.data.id}}',
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForLatestJob((job) => {
        expect(job.result.postId).toBe(post.id);
      });
    });

    it('params.values with hasMany', async () => {
      const replies = await ReplyRepo.create({ values: [{}, {}] });

      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'comments',
          params: {
            values: {
              replies: replies.map((item) => item.id),
            },
            appends: ['replies'],
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForLatestJob((job) => {
        expect(job.result.replies.length).toBe(2);
      });
    });

    it('params.appends: belongsTo', async () => {
      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'comments',
          params: {
            values: {
              postId: '{{$context.data.id}}',
            },
            appends: ['post'],
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForLatestJob((job) => {
        expect(job.result.post.id).toBe(post.id);
      });
    });

    it('params.appends: belongsToMany', async () => {
      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'tags',
          params: {
            values: {
              posts: ['{{$context.data.id}}'],
            },
            appends: ['posts'],
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForLatestJob((job) => {
        expect(job.result.posts.length).toBe(1);
        expect(job.result.posts[0].id).toBe(post.id);
      });
    });
  });

  describe('multiple data source', () => {
    beforeAll(() => setupApp(true));
    beforeEach(setupWorkflow);
    afterEach(disableWorkflows);
    afterAll(() => app.destroy());

    it('create one', async () => {
      const n1 = await workflow.createNode({
        type: 'create',
        config: {
          collection: 'another:posts',
          params: {
            values: {
              title: '{{$context.data.title}}',
              published: true,
            },
          },
        },
      });

      const post = await PostRepo.create({ values: { title: 't1' } });

      await waitForLatestJob((job) => {
        expect(job.result.title).toBe(post.title);
      });

      const AnotherPostRepo = app.dataSourceManager.dataSources.get('another').collectionManager.getRepository('posts');
      await waitForAssertion(async () => {
        const p2s = await AnotherPostRepo.find();
        expect(p2s.length).toBe(1);
        expect(p2s[0].title).toBe(post.title);
        expect(p2s[0].published).toBe(true);
      });
    });
  });
});
