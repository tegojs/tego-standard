import { execFile, fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AttachmentRemovalCompletionInspector } from '../storages/removal-completion-inspector';
import {
  crashFixtureBytes,
  crashFixtureDatabase,
  registerCrashMappings,
  seedCrashFixture,
} from './fixtures/removal-crash-context';

const databaseUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);

async function buildCrashProducer(directory: string) {
  const bundle = path.join(directory, 'producer.cjs');
  const require = createRequire(await fs.realpath('node_modules/@tego/devkit/package.json'));
  await execFileAsync(process.execPath, [
    require.resolve('esbuild/bin/esbuild'),
    path.resolve('packages/module-file/src/server/__tests__/fixtures/removal-crash-producer.ts'),
    '--bundle',
    '--platform=node',
    '--packages=external',
    '--format=cjs',
    `--alias:@tachybase/module-acl=${path.resolve('packages/module-acl/src/server/scope-provenance.ts')}`,
    `--outfile=${bundle}`,
  ]);
  return bundle;
}

const producerEnvironment = (phase: string) => ({
  ...process.env,
  TENANT_REMOVAL_CRASH_PHASE: phase,
  NODE_PATH: [
    path.resolve('packages/module-file/node_modules'),
    path.resolve('packages/module-tenant/node_modules'),
    path.resolve('packages/plugin-action-export/node_modules'),
    path.resolve('node_modules'),
  ].join(path.delimiter),
});

describe.skipIf(!databaseUrl)('persisted discovery after actual producer termination', () => {
  it('rejects an unknown worker phase before opening a database or sending any evidence', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-producer-crash-'));
    let child: ReturnType<typeof fork>;
    let closed: Promise<number | null>;
    try {
      const bundle = await buildCrashProducer(directory);
      child = fork(bundle, [], {
        env: { ...producerEnvironment('unknown'), TENANT_ACCESS_TEST_DATABASE_URL: 'invalid' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      closed = new Promise((resolve) => child.once('close', resolve));
      const messages: unknown[] = [];
      let stderr = '';
      let stdout = '';
      child.on('message', (message) => messages.push(message));
      child.stdout!.on('data', (chunk) => (stdout += chunk));
      child.stderr!.on('data', (chunk) => (stderr += chunk));
      expect(await closed).toBe(1);
      expect(messages).toEqual([]);
      expect(stdout).toBe('');
      expect(stderr).toContain('Unknown producer crash fixture phase or missing IPC');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (closed) await closed;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['uncommitted', 'committed'] as const)(
    'discovers only durable evidence after the %s producer dies before UUID delivery',
    async (phase) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-removal-producer-crash-'));
      const root = path.join(directory, 'root');
      const file = path.join(root, 'probe.txt');
      const db = crashFixtureDatabase(databaseUrl!);
      let native: Awaited<ReturnType<typeof seedCrashFixture>>['native'];
      let child: ReturnType<typeof fork>;
      let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
      try {
        await fs.mkdir(root);
        await fs.writeFile(file, crashFixtureBytes, { flag: 'wx' });
        const original = await fs.lstat(file, { bigint: true });
        native = (await seedCrashFixture(db, root)).native;
        const bundle = await buildCrashProducer(directory);
        const messages: unknown[] = [];
        let stdout = '';
        let stderr = '';
        child = fork(bundle, [], {
          cwd: process.cwd(),
          env: producerEnvironment(phase),
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
        child.stdout!.on('data', (chunk) => (stdout += chunk));
        child.stderr!.on('data', (chunk) => (stderr += chunk));
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Producer barrier timeout: ${stderr}`)), 30000);
          const failed = (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          };
          child.once('error', failed);
          child.once('exit', () => failed(new Error(`Producer exited before barrier: ${stderr}`)));
          child.on('message', (message) => {
            messages.push(message);
            clearTimeout(timeout);
            resolve();
          });
        });
        expect(messages).toEqual([{ phase }]);
        expect(child.kill('SIGKILL')).toBe(true);
        expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
        expect(child.stdout!.readableEnded).toBe(true);
        expect(child.stderr!.readableEnded).toBe(true);
        expect(stderr).toBe('');
        expect(stdout).not.toMatch(/[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}/);
        expect(messages).toEqual([{ phase }]);

        // Only after actual child close/pipe EOF: a fresh independent pool discovers its own ids.
        const other = crashFixtureDatabase(databaseUrl!);
        try {
          const { source, intents, events } = registerCrashMappings(other);
          const inspector = new AttachmentRemovalCompletionInspector(db, source, intents, events);
          const before = (
            await db.sequelize.query('SELECT id, xmin::text, ctid::text, payload FROM attachment_removal_intents')
          )[0];
          const page = await inspector.discoverIntents();
          expect(page.nextAfter).toBeNull();
          expect(page.operationIds).toHaveLength(phase === 'committed' ? 1 : 0);
          if (phase === 'committed') {
            expect(await inspector.inspect(page.operationIds[0])).toMatchObject({
              state: 'committed-sql-observed',
              operationId: page.operationIds[0],
            });
          }
          expect(await source.model.count()).toBe(phase === 'committed' ? 0 : 1);
          if (phase === 'uncommitted') {
            expect((await source.model.findByPk(1))?.get()).toMatchObject({
              id: 1,
              tenantId: 'B',
              path: '',
              filename: 'probe.txt',
              size: crashFixtureBytes.length,
              storageId: 18,
            });
          }
          expect(await events.model.count()).toBe(phase === 'committed' ? 1 : 0);
          expect(
            (await db.sequelize.query('SELECT id, xmin::text, ctid::text, payload FROM attachment_removal_intents'))[0],
          ).toEqual(before);
        } finally {
          await other.close();
        }
        const actual = await fs.lstat(file, { bigint: true });
        expect([actual.dev, actual.ino, actual.size]).toEqual([original.dev, original.ino, original.size]);
        expect(await fs.readFile(file)).toEqual(crashFixtureBytes);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (closed) await closed;
        try {
          if (native) await db.sequelize.query(`DROP FUNCTION IF EXISTS ${native.functionName}() CASCADE`);
          await db.sequelize.drop({ cascade: true });
        } finally {
          await db.close();
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    },
    60000,
  );
});
