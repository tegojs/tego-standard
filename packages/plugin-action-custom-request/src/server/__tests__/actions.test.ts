import { createServer } from 'node:http';
import { createMockServer, MockServer, startServerWithRandomPort } from '@tachybase/test';
import Database, { Context, Repository } from '@tego/server';

describe('actions', () => {
  let app: MockServer;
  let db: Database;
  let repo: Repository;
  let agent: ReturnType<MockServer['agent']>;
  let resource: ReturnType<ReturnType<MockServer['agent']>['resource']>;
  let server: any;
  let gatewayBaseURL: string;
  let authorization: string;

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: ['users', 'auth', 'acl', 'custom-request', 'data-source-manager'],
    });
    db = app.db;
    const port = await startServerWithRandomPort(({ port, host, callback }) => {
      server = createServer(app.callback());
      server.listen(port, host, () => callback(server));
    });
    gatewayBaseURL = `http://localhost:${port}`;
    repo = db.getRepository('customRequests');
    agent = app.agent();
    resource = (agent.set('X-Role', 'admin').set('X-App', 'main') as any).resource('customRequests');
    await agent.login(1);
    authorization = `Bearer ${app.authManager.jwt.sign({ userId: 1 })}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await app.destroy();
  });

  describe('send', () => {
    let params = null;
    beforeAll(async () => {
      app.resourcer.getResource('customRequests').addAction('test', (ctx: Context) => {
        params = ctx.action.params.values;
        return ctx.action.params.values;
      });
      await repo.create({
        values: {
          key: 'test',
          options: {
            url: `${gatewayBaseURL}/customRequests:test`,
            method: 'GET',
            headers: [{ name: 'Authorization', value: authorization }],
            data: {
              username: '{{ currentRecord.username }}',
            },
          },
        },
      });
    });

    test('basic', async () => {
      const res = await resource.send({
        filterByTk: 'test',
      });
      expect(res.status).toBe(200);
      expect(params).toMatchSnapshot();
    });

    test('currentRecord.data', async () => {
      const res = await resource.send({
        filterByTk: 'test',
        values: {
          currentRecord: {
            data: {
              username: 'testname',
            },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(params).toMatchSnapshot();
    });

    test('parse o2m variables correctly', async () => {
      await repo.create({
        values: {
          key: 'o2m',
          options: {
            url: `${gatewayBaseURL}/customRequests:test`,
            method: 'GET',
            headers: [{ name: 'Authorization', value: authorization }],
            data: {
              o2m: '{{ currentRecord.o2m.id }}',
            },
          },
        },
      });

      const res = await resource.send({
        filterByTk: 'o2m',
        values: {
          currentRecord: {
            data: {
              o2m: [
                {
                  id: 1,
                },
                {
                  id: 2,
                },
              ],
            },
          },
        },
      });
      expect(res.status).toBe(200);
      expect(params).toMatchObject({
        o2m: [1, 2],
      });
    });

    test('currentRecord.id with collectionName works fine', async () => {
      await repo.create({
        values: {
          key: 'test2',
          options: {
            method: 'GET',
            headers: [{ name: 'Authorization', value: authorization }],
            params: [{ name: 'userId', value: '{{currentRecord.id}}' }],
            url: `${gatewayBaseURL}/users:get`,
            collectionName: 'users',
            data: null,
          },
        },
      });

      const userId = 1;
      const res = await resource.send({
        filterByTk: 'test2',
        values: {
          currentRecord: {
            id: userId,
          },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(userId);
    });

    test('currentUser with association data', async () => {
      await repo.create({
        values: {
          key: 'currentUser-with-association-data',
          options: {
            method: 'POST',
            headers: [{ name: 'Authorization', value: authorization }],
            data: {
              a: '{{currentUser.roles.name}}',
              b: '{{currentUser.roles.title}}',
              c: '{{currentUser.roles.rolesUsers.userId}}',
            },
            url: `${gatewayBaseURL}/customRequests:test`,
          },
        },
      });

      const res = await resource.send({
        filterByTk: 'currentUser-with-association-data',
      });
      expect(res.status).toBe(200);
      expect(expect.arrayContaining(params.a)).toMatchObject(['root', 'member', 'admin']);
      expect(expect.arrayContaining(params.b)).toMatchObject(['{{t("Member")}}', '{{t("Root")}}', '{{t("Admin")}}']);
      expect(expect.arrayContaining(params.c)).toMatchObject([1, 1, 1]);
    });
  });
});
