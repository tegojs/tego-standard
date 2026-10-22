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
      database: { dialect: 'sqlite', storage: ':memory:' },
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
        email_verified: true,
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

  describe('email ownership verification', () => {
    const unverifiedClaims = [
      { name: 'false', value: false },
      { name: 'missing', value: undefined },
      { name: 'null', value: null },
      { name: 'string true', value: 'true' },
      { name: 'string false', value: 'false' },
      { name: 'number', value: 1 },
    ];

    beforeEach(async () => {
      await authenticator.update({
        options: {
          oidc: { userBindField: 'email' },
          public: { autoSignup: false },
        },
      });
    });

    async function signInWithClaims(claims: Record<string, unknown>) {
      mockCreateOIDCClient({
        callback: async () => ({ access_token: 'access_token' }),
        userinfo: async () => ({ ...claims }),
      });
      return app
        .agent()
        .set('X-Authenticator', 'oidc-auth')
        .set('Cookie', ['tachybase_oidc=token'])
        .get('/auth:signIn?state=token%3Dtoken&name=oidc-auth');
    }

    it.each(unverifiedClaims)('rejects linking when email_verified is $name', async ({ value }) => {
      const victim = await db.getRepository('users').create({ values: { email: 'victim@example.test' } });
      const res = await signInWithClaims({
        sub: 'unverified-sub',
        email: victim.email,
        email_verified: value,
      });

      expect(res.statusCode).toBe(401);
      expect(res.body.data?.token).toBeUndefined();
      expect(await authenticator.findUser('unverified-sub')).toBeNull();
      expect(await db.getRepository('users').count({ filter: { email: victim.email } })).toBe(1);
    });

    it.each(unverifiedClaims)('rejects signup when email_verified is $name', async ({ value }) => {
      await authenticator.update({
        options: { ...authenticator.options, public: { autoSignup: true } },
      });
      const res = await signInWithClaims({
        sub: 'new-sub',
        email: 'new@example.test',
        email_verified: value,
      });

      expect(res.statusCode).toBe(401);
      expect(res.body.data?.token).toBeUndefined();
      expect(await authenticator.findUser('new-sub')).toBeNull();
      expect(await db.getRepository('users').count()).toBe(0);
    });

    it('creates and binds a user with a verified email', async () => {
      await authenticator.update({
        options: { ...authenticator.options, public: { autoSignup: true } },
      });
      const res = await signInWithClaims({
        sub: 'verified-sub',
        email: 'verified@example.test',
        email_verified: true,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.token).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe('verified@example.test');
      expect((await authenticator.findUser('verified-sub')).id).toBe(res.body.data.user.id);
    });

    it.each([false, undefined])('keeps existing subject bindings usable with email_verified=%s', async (value) => {
      const user = await authenticator.newUser('existing-sub', { email: 'bound@example.test' });
      const res = await signInWithClaims({
        sub: 'existing-sub',
        email: 'different@example.test',
        email_verified: value,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.user.email).toBe('bound@example.test');
      expect(await db.getRepository('users').count()).toBe(1);
    });

    it.each([
      { name: 'mapped verification flag', autoSignup: false },
      { name: 'mapped verification flag', autoSignup: true },
      { name: 'mapped address', autoSignup: false },
      { name: 'mapped address', autoSignup: true },
    ])('rejects $name with autoSignup=$autoSignup', async ({ name, autoSignup }) => {
      const victimEmail = 'mapped@example.test';
      if (!autoSignup) {
        await db.getRepository('users').create({ values: { email: victimEmail } });
      }
      const mapsVerification = name === 'mapped verification flag';
      await authenticator.update({
        options: {
          oidc: {
            userBindField: 'email',
            fieldMap: mapsVerification
              ? [{ source: 'custom_verified', target: 'email_verified' }]
              : [{ source: 'custom_email', target: 'email' }],
          },
          public: { autoSignup },
        },
      });
      const res = await signInWithClaims({
        sub: 'mapped-sub',
        email: mapsVerification ? victimEmail : 'owned@example.test',
        email_verified: !mapsVerification,
        custom_verified: true,
        custom_email: victimEmail,
      });

      expect(res.statusCode).toBe(401);
      expect(res.body.data?.token).toBeUndefined();
      expect(await authenticator.findUser('mapped-sub')).toBeNull();
      expect(await db.getRepository('users').count()).toBe(autoSignup ? 0 : 1);
    });

    it('does not persist an unverified email during username-based signup', async () => {
      await authenticator.update({
        options: { oidc: { userBindField: 'username' }, public: { autoSignup: true } },
      });
      const res = await signInWithClaims({
        sub: 'new-username-sub',
        username: 'new-user',
        email: 'unverified@example.test',
        email_verified: false,
      });

      expect(res.statusCode).toBe(401);
      expect(await authenticator.findUser('new-username-sub')).toBeNull();
      expect(await db.getRepository('users').count()).toBe(0);
    });
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
