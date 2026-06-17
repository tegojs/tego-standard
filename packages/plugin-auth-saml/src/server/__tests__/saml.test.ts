import { createMockServer, MockServer } from '@tachybase/test';
import { Database, Model } from '@tego/server';

import { vi } from 'vitest';

import { authType } from '../../constants';

describe('saml', () => {
  let app: MockServer;
  let db: Database;
  let agent;
  let authenticator;

  beforeAll(async () => {
    app = await createMockServer({
      plugins: ['users', 'auth', 'saml'],
    });
    db = app.db;
    agent = app.agent();

    const authenticatorRepo = db.getRepository('authenticators');
    authenticator = await authenticatorRepo.create({
      values: {
        name: 'saml-auth',
        authType: authType,
        enabled: 1,
        options: {
          saml: {
            ssoUrl: 'http://localhost:3000/saml/sso',
            certificate: `certificate`,
            idpIssuer: 'idpIssuer',
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
   * Mock validate on the runtime SAMLAuth class used by the framework.
   * Returns a mock user-like object that the signIn flow expects.
   */
  function mockValidate(profile: any) {
    const authTypeConfig = app.authManager.authTypes.get(authType);
    const AuthClass = authTypeConfig.auth;
    return vi.spyOn(AuthClass.prototype, 'validate').mockImplementation(async function (this: any) {
      const { nameID, nickname, firstName, lastName, phone } = profile;
      let { email, username } = profile;
      const isEmail = nameID.match(/^.+@.+\..+$/);
      if (!email && isEmail) {
        email = nameID;
      }
      if (!username && !isEmail) {
        username = nameID;
      }

      const authenticator = this.authenticator;
      let user = await authenticator.findUser(nameID);
      if (user) {
        return user;
      }
      // Bind existed user
      const { userBindField = 'email' } = this.options?.saml || {};
      if (userBindField === 'email' && email) {
        user = await this.userRepository.findOne({
          filter: { email },
        });
      } else if (userBindField === 'username' && username) {
        user = await this.userRepository.findOne({
          filter: { username },
        });
      }
      if (user) {
        await authenticator.addUser(user.id, {
          through: {
            uuid: nameID,
          },
        });
        return user;
      }
      // Create new user
      const { autoSignup } = this.options?.public || {};
      if (!autoSignup) {
        throw new Error('User not found');
      }
      const fullName = firstName && lastName && `${firstName} ${lastName}`;
      return await authenticator.newUser(nameID, {
        username: username ?? null,
        nickname: nickname || fullName || username || nameID,
        email: email ?? null,
        phone: phone ?? null,
      });
    });
  }

  it('should get auth url', async () => {
    const res = await agent.set('X-Authenticator', 'saml-auth').resource('saml').getAuthUrl();
    expect(res.body.data).toBeDefined();
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
    mockValidate({
      nameID: 'test@tachybase.com',
      email: 'test@tachybase.com',
      firstName: 'Test',
      lastName: 'Tachybase',
    });

    const res = await agent.set('X-Authenticator', 'saml-auth').resource('auth').signIn().send({
      samlResponse: {},
    });

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
    mockValidate({
      nameID: 'test@tachybase.com',
      email: 'test@tachybase.com',
      firstName: 'Test',
      lastName: 'Tachybase',
    });

    const res = await agent.set('X-Authenticator', 'saml-auth').resource('auth').signIn().send({
      samlResponse: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.nickname).toBe('Test Tachybase');
  });

  it('should sign in via email', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        saml: {
          ...authenticator.options?.saml,
          userBindField: 'email',
        },
        public: {
          autoSignup: false,
        },
      },
    });

    mockValidate({
      nameID: 'old@tachybase.com',
      email: 'old@tachybase.com',
      firstName: 'Old',
      lastName: 'Tachybase',
    });

    const email = 'old@tachybase.com';
    const userRepo = db.getRepository('users');
    const user = await userRepo.create({
      values: {
        nickname: email,
        email,
      },
    });

    const res = await agent
      .set('X-Authenticator', 'saml-auth')
      .resource('auth')
      .signIn()
      .send({
        samlResponse: {
          SAMLResponse: '',
        },
      });

    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBe(user.id);
  });

  it('should sign in via usernmae', async () => {
    await authenticator.update({
      options: {
        ...authenticator.options,
        saml: {
          ...authenticator.options?.saml,
          userBindField: 'username',
        },
        public: {
          autoSignup: false,
        },
      },
    });

    mockValidate({
      nameID: 'username',
      email: 'old@tachybase.com',
      firstName: 'Old',
      lastName: 'Tachybase',
    });

    const email = 'old@tachybase.com';
    const userRepo = db.getRepository('users');
    const user = await userRepo.create({
      values: {
        username: 'username',
        nickname: email,
        email,
      },
    });

    const res = await agent
      .set('X-Authenticator', 'saml-auth')
      .resource('auth')
      .signIn()
      .send({
        samlResponse: {
          SAMLResponse: '',
        },
      });

    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBe(user.id);
  });
});
