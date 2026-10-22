import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { createMockServer, type MockServer } from '@tachybase/test';

// All responses contain valid, harmless Brotli data. No malformed input or exploit is used.
describe('custom request Brotli reachability and permissions', () => {
  let app: MockServer;
  let server: http.Server;
  let origin: string;
  let member: ReturnType<MockServer['agent']>;
  let admin: ReturnType<MockServer['agent']>;
  let limited: ReturnType<MockServer['agent']>;
  let memberId: number;
  let observedIdentity: { role: string; userId: number };
  let decoderCalls = 0;
  const hits: Array<{ path: string; encoding: string }> = [];
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createBrotliDecompress')!;
  const nativeDecoder = zlib.createBrotliDecompress;
  const marker = { safeProbe: true };
  const compressed = zlib.brotliCompressSync(Buffer.from(JSON.stringify(marker)));

  beforeAll(async () => {
    Object.defineProperty(zlib, 'createBrotliDecompress', {
      ...descriptor,
      value: (...args: Parameters<typeof nativeDecoder>) => {
        decoderCalls++;
        return nativeDecoder(...args);
      },
    });
    server = http.createServer((req, res) => {
      hits.push({ path: req.url!, encoding: req.headers['accept-encoding'] || '' });
      res.writeHead(200, {
        'Content-Type': req.url === '/raw' ? 'application/octet-stream' : 'application/json',
        'Content-Encoding': 'br',
      });
      res.end(compressed);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await createMockServer({
      database: { dialect: 'sqlite', storage: ':memory:' },
      registerActions: true,
      acl: true,
      plugins: ['users', 'auth', 'acl', 'custom-request', 'data-source-manager'],
    });
    const user = await app.db.getRepository('users').create({
      values: { username: 'brotli-probe-member', roles: ['member'] },
    });
    memberId = user.id;
    member = app.agent().login(user).set('X-Role', 'member');
    admin = app.agent().login(1).set('X-Role', 'admin');
    await app.db.getRepository('roles').create({
      values: { name: 'brotli-limited', strategy: { actions: [] }, snippets: ['!ui.*', '!pm', '!pm.*'] },
    });
    const limitedUser = await app.db.getRepository('users').create({
      values: { username: 'brotli-probe-limited', roles: ['brotli-limited'] },
    });
    limited = app.agent().login(limitedUser).set('X-Role', 'brotli-limited');
    app.resourcer.use(async (ctx, next) => {
      await next();
      observedIdentity = { role: ctx.state.currentRole, userId: ctx.auth.user?.id };
    });
    const repo = app.db.getRepository('customRequests');
    for (const [key, options, roles] of [
      ['fixed', { url: `${origin}/fixed`, method: 'GET' }, []],
      ['restricted', { url: `${origin}/restricted`, method: 'GET' }, ['admin']],
      ['dynamic', { url: '{{currentRecord.target}}', method: 'GET' }, []],
      [
        'identity',
        { url: `${origin}/identity`, method: 'GET', headers: [{ name: 'Accept-Encoding', value: 'identity' }] },
        [],
      ],
      ['raw', { url: `${origin}/raw`, method: 'GET', decompress: false }, []],
    ] as const) {
      await repo.create({ values: { key, options, roles: [...roles] } });
    }
  });

  afterAll(async () => {
    Object.defineProperty(zlib, 'createBrotliDecompress', descriptor);
    await app?.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('blocks anonymous send before any remote request or decoding', async () => {
    const before = [hits.length, decoderCalls];
    const res = await app.agent().resource('customRequests').send({ filterByTk: 'fixed' });
    expect([401, 403]).toContain(res.status);
    expect([hits.length, decoderCalls]).toEqual(before);
  });

  it('reproduces default member configuration creation followed by URL execution and decoding', async () => {
    const role = app.acl.getRole('member');
    expect(role.toJSON().strategy.actions).toContain('create');
    expect(role.effectiveSnippets().allowed.some((name) => name.startsWith('ui.'))).toBe(false);
    const before = decoderCalls;
    const res = await member.resource('customRequests').updateOrCreate({
      filterKeys: ['key'],
      values: { key: 'member-created', options: { url: `${origin}/member-created`, method: 'GET' } },
    });
    expect(res.status).toBe(200);
    expect(observedIdentity).toEqual({ role: 'member', userId: memberId });
    const saved = await app.db.getRepository('customRequests').findOne({ filterByTk: 'member-created' });
    expect(saved.get('options').url).toBe(`${origin}/member-created`);
    const sent = await member.resource('customRequests').send({ filterByTk: 'member-created' });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual(marker);
    expect(observedIdentity).toEqual({ role: 'member', userId: memberId });
    expect(hits.at(-1)?.path).toBe('/member-created');
    expect(decoderCalls - before).toBe(1);
  });

  it('blocks configuration creation for a role without create strategy or UI permission', async () => {
    const res = await limited.resource('customRequests').updateOrCreate({
      filterKeys: ['key'],
      values: { key: 'limited-created', options: { url: `${origin}/limited-created` } },
    });
    expect(res.status).toBe(403);
    expect(await app.db.getRepository('customRequests').findOne({ filterByTk: 'limited-created' })).toBeFalsy();
  });

  it('still lets that limited role trigger an existing unrestricted request', async () => {
    const before = decoderCalls;
    const res = await limited.resource('customRequests').send({ filterByTk: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(marker);
    expect(decoderCalls - before).toBe(1);
  });

  it('allows an administrator to save request configuration', async () => {
    const res = await admin.resource('customRequests').updateOrCreate({
      filterKeys: ['key'],
      values: { key: 'admin-created', options: { url: `${origin}/admin-created` } },
    });
    expect(res.status).toBe(200);
  });

  it('lets a logged-in member trigger an unrestricted saved URL and decodes br', async () => {
    const before = decoderCalls;
    const res = await member.resource('customRequests').send({ filterByTk: 'fixed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(marker);
    expect(hits.at(-1)?.path).toBe('/fixed');
    expect(hits.at(-1)?.encoding).toContain('br');
    expect(decoderCalls - before).toBe(1);
  });

  it('enforces the configured request role list', async () => {
    const before = [hits.length, decoderCalls];
    const denied = await member.resource('customRequests').send({ filterByTk: 'restricted' });
    expect(denied.status).toBe(403);
    expect([hits.length, decoderCalls]).toEqual(before);
    const allowed = await admin.resource('customRequests').send({ filterByTk: 'restricted' });
    expect(allowed.status).toBe(200);
    expect(hits.at(-1)?.path).toBe('/restricted');
  });

  it('does not replace a fixed saved URL with a submitted url property', async () => {
    const res = await member.resource('customRequests').send({
      filterByTk: 'fixed',
      values: { url: `${origin}/replacement` },
    });
    expect(res.status).toBe(200);
    expect(hits.at(-1)?.path).toBe('/fixed');
  });

  it('lets a member supply the whole target only when the saved URL references that variable', async () => {
    const before = decoderCalls;
    const res = await member.resource('customRequests').send({
      filterByTk: 'dynamic',
      values: { currentRecord: { data: { target: `${origin}/variable-target` } } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(marker);
    expect(hits.at(-1)?.path).toBe('/variable-target');
    expect(decoderCalls - before).toBe(1);
  });

  it('still decodes unsolicited br when Accept-Encoding is identity', async () => {
    const before = decoderCalls;
    const res = await member.resource('customRequests').send({ filterByTk: 'identity' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(marker);
    expect(hits.at(-1)?.encoding).toBe('identity');
    expect(decoderCalls - before).toBe(1);
  });

  it('does not invoke the decoder when decompress is explicitly false', async () => {
    const before = decoderCalls;
    const res = await member.resource('customRequests').send({ filterByTk: 'raw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(compressed);
    expect(decoderCalls).toBe(before);
  });
});
