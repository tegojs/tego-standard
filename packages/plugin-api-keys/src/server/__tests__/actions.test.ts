import { createMockServer, MockServer } from '@tachybase/test';
import Database, { Repository } from '@tego/server';

describe('actions', () => {
  let app: MockServer;
  let db: Database;
  let repo: Repository;
  let agent;
  let resource;

  let user;
  let testUser;
  let role;
  let testRole;
  let createData;
  const expiresIn = 60 * 60 * 24;

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: ['users', 'auth', 'api-keys', 'acl', 'data-source-manager'],
    });

    db = app.db;

    repo = db.getRepository('apiKeys');
    agent = app.agent();
    resource = agent.set('X-Role', 'admin').resource('apiKeys');
    const userRepo = app.db.getRepository('users');

    user = await userRepo.findOne({
      appends: ['roles'],
    });

    testUser = await userRepo.create({
      values: {
        nickname: 'test',
        roles: user.roles,
      },
    });
    const roleRepo = await app.db.getRepository('roles');
    testRole = await roleRepo.create({
      values: {
        name: 'TEST_ROLE',
      },
    });

    role = await (app.db.getRepository('users.roles', user.id) as unknown as Repository).findOne({
      where: {
        default: true,
      },
    });
    createData = {
      values: {
        name: 'TEST',
        role,
        expiresIn,
      },
    };
  });

  beforeEach(async () => {
    await repo.destroy({
      truncate: true,
    });
    agent = app.agent();
    resource = agent.set('X-Role', 'admin').resource('apiKeys');
    await agent.login(user);
  });

  afterAll(async () => {
    await app.destroy();
  });

  describe('create', () => {
    let result;
    let tokenData;
    let apiAccessToken;

    beforeEach(async () => {
      result = (await resource.create(createData)).body.data;
      apiAccessToken = result.accessToken || result.token;
      const apiKey = await repo.findOne({ filter: { accessToken: apiAccessToken } });
      expect(apiKey).toBeTruthy();
      tokenData = await app.authManager.jwt.decode(apiKey.get('token'));
    });

    it('basic', async () => {
      expect(result).toHaveProperty('token');
    });

    it('the role that does not belong to you should throw error', async () => {
      const res = await resource.create({
        values: {
          ...createData,
          role: testRole,
        },
      });
      expect(res.status).toBe(400);
      expect(res.text).toBe('Role not found');
    });

    it('token should work', async () => {
      const checkRes = await agent.set('Authorization', `Bearer ${apiAccessToken}`).resource('auth').check();
      expect(checkRes.body.data.nickname).toBe(user.nickname);
    });

    it('legacy 64-character access token should work', async () => {
      expect(result.accessToken).toHaveLength(64);
      const checkRes = await agent.set('Authorization', `Bearer ${result.accessToken}`).resource('auth').check();
      expect(checkRes.status).toBe(200);
      expect(checkRes.body.data.nickname).toBe(user.nickname);
    });

    it('token expiresIn correctly', async () => {
      expect(tokenData.exp - tokenData.iat).toBe(expiresIn);
    });

    it('token roleName correctly', async () => {
      expect(tokenData.roleName).toBe(role.name);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await resource.create(createData);
    });

    it('basic', async () => {
      const res = await resource.list();
      expect(res.body.data.length).toBe(1);
      const data = res.body.data[0];
      expect(data.name).toContain(createData.values.name);
      expect(data.roleName).toContain(createData.values.role.name);
    });

    it("Only show current user's API keys", async () => {
      expect((await resource.list()).body.data.length).toBe(1);
      await agent.login(testUser);
      expect((await resource.list()).body.data.length).toBe(0);
      const values = {
        name: 'TEST_USER_KEY',
        expiresIn: 180 * 24 * 60 * 60,
        role,
      };
      await resource.create({
        values,
      });
      const listData = (await resource.list()).body.data;
      expect(listData.length).toBe(1);
      expect(listData[0].name).toBe(values.name);
    });
  });

  describe('destroy', () => {
    let result;
    let apiAccessToken;

    beforeEach(async () => {
      result = (await resource.create(createData)).body.data;
      apiAccessToken = result.accessToken || result.token;
    });

    it('basic', async () => {
      const res = await resource.list();
      expect(res.body.data.length).toBe(1);
      const data = res.body.data[0];
      await resource.destroy({
        filterByTk: data.id,
      });
      expect((await resource.list()).body.data.length).toBe(0);
    });

    it("Cannot delete other user's API keys", async () => {
      const res = await resource.list();
      expect(res.body.data.length).toBe(1);
      const data = res.body.data[0];
      await agent.login(testUser);
      await resource.destroy({
        filterByTk: data.id,
      });
      await agent.login(user);
      expect((await resource.list()).body.data.length).toBe(1);
    });

    it('The token should not work after removing the api key', async () => {
      const res = await resource.list();
      expect(res.body.data.length).toBe(1);
      const data = res.body.data[0];
      await resource.destroy({
        filterByTk: data.id,
      });
      const response = await agent.set('Authorization', `Bearer ${apiAccessToken}`).resource('auth').check();
      expect(response.status).toBe(401);
    });
  });
});
