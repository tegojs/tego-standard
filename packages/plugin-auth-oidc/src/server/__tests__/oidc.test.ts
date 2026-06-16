import { createMockServer, MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { vi } from 'vitest';

import { authType } from '../../constants';

describe('oidc', () => {
  let app: MockServer;
  let db: Database;
  let agent;
  let authenticator;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['users', 'auth', 'oidc'],
    });
    db = app.db;
    agent = app.agent();

    const authenticatorRepo = db.getRepository('authenticators');
    authenticator = await authenticatorRepo.create({
      values: {
        name: 'oidc-auth',
        authType: authType,
        enabled: 1,
        options: {
          oidc: {
            issuer: '',
            clientId: '',
            clientSecret: '',
          },
        },
      },
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.getRepository('users').destroy({
      truncate: true,
    });
    await db.getRepository('usersAuthenticators').destroy({
      truncate: true,
    });
  });

  /**
   * Mock createOIDCClient on the runtime OIDCAuth class used by the framework.
   * Since the framework loads from dist (which may have its own bundled deps),
   * we get the actual class from the authManager registry and mock its prototype.
   */
  function mockCreateOIDCClient(clientMock: any) {
    const authTypeConfig = app.authManager.authTypes.get(authType);
    const AuthClass = authTypeConfig.auth;
    return vi.spyOn(AuthClass.prototype, 'createOIDCClient').mockResolvedValue(clientMock);
  }

  it('should get auth url', async () => {
    agent = app.agent();
    mockCreateOIDCClient({
      authorizationUrl: ({ state }) => state,
    });
    const res = await agent.set('X-Authenticator', 'oidc-auth').resource('oidc').getAuthUrl();
    expect(res.body.data).toBeDefined();
    const search = new URLSearchParams(decodeURIComponent(res.body.data));
    expect(search.get('token')).toBeDefined();
    expect(search.get('name')).toBe('oidc-auth');
    expect(res.headers['set-cookie']).toBeDefined();
    const token = res.headers['set-cookie'][0].split(';')[0].split('=')[1];
    expect(token).toBe(search.get('token'));
  });

  it('should not sign in without auto signup', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        public: {
          autoSignup: false,
        },
      },
    });
    agent = app.agent();
    mockCreateOIDCClient({
      callback: (uri, { code }) => ({
        access_token: 'access_token',
      }),
      userinfo: () => ({
        sub: 'user1',
      }),
    });

    const res = await agent
      .set('X-Authenticator', 'oidc-auth')
      .set('Cookie', ['tachybase_oidc=token'])
      .get('/auth:signIn?state=token%3Dtoken&name=oidc-auth');

    expect(res.statusCode).toBe(401);
  });

  it('should sign in with auto signup', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        public: {
          autoSignup: true,
        },
      },
    });
    agent = app.agent();
    mockCreateOIDCClient({
      callback: (uri, { code }) => ({
        access_token: 'access_token',
      }),
      userinfo: () => ({
        sub: 'user1',
      }),
    });

    const res = await agent
      .set('X-Authenticator', 'oidc-auth')
      .set('Cookie', ['tachybase_oidc=token'])
      .get('/auth:signIn?state=token%3Dtoken&name=oidc-auth');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.nickname).toBe('user1');
  });

  it('should sign in with existed email', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        oidc: {
          ...authenticator.options?.oidc,
          userBindField: 'email',
        },
        public: {
          autoSignup: false,
        },
      },
    });
    const user = await db.getRepository('users').create({
      values: {
        nickname: 'has-email',
        email: 'test@tachybase.com',
      },
    });
    agent = app.agent();
    mockCreateOIDCClient({
      callback: (uri, { code }) => ({
        access_token: 'access_token',
      }),
      userinfo: () => ({
        sub: 'user1',
        email: 'test@tachybase.com',
      }),
    });

    const res = await agent
      .set('X-Authenticator', 'oidc-auth')
      .set('Cookie', ['tachybase_oidc=token'])
      .get('/auth:signIn?state=token%3Dtoken&name=oidc-auth');

    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBe(user.id);
  });

  it('should sign in with existed username', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        oidc: {
          ...authenticator.options?.oidc,
          userBindField: 'username',
        },
        public: {
          autoSignup: false,
        },
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        nickname: 'has-username',
        username: 'username',
      },
    });
    agent = app.agent();
    mockCreateOIDCClient({
      callback: (uri, { code }) => ({
        access_token: 'access_token',
      }),
      userinfo: () => ({
        username: 'username',
        sub: 'username',
      }),
    });

    const res = await agent
      .set('X-Authenticator', 'oidc-auth')
      .set('Cookie', ['tachybase_oidc=token'])
      .get('/auth:signIn?state=token%3Dtoken&name=oidc-auth');

    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBe(user.id);
  });
});

it('field mapping', async () => {
  // Import OIDCAuth from the same source the test uses for the field mapping test
  const { OIDCAuth } = await import('../oidc-auth');
  const auth = new OIDCAuth({
    authenticator: null,
    ctx: {
      db: {
        getCollection: () => ({}),
      } as any,
    } as any,
    options: {
      oidc: {
        fieldMap: [
          {
            source: 'username',
            target: 'nickname',
          },
        ],
      },
    },
  });
  const userInfo = auth.mapField({
    sub: 1,
    username: 'user1',
  });
  expect(userInfo).toEqual({
    sub: 1,
    username: 'user1',
    nickname: 'user1',
  });
});
