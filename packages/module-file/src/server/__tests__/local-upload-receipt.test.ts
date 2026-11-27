import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import * as files from '..';

const run = promisify(execFile);
const bytes = Buffer.from('Recoverable local attachment');

describe('local upload object receipts before copying', () => {
  let directory: string;
  let root: string;
  let plan: files.StagedAttachmentStoragePlan;
  const destination = () => path.join(root, 'tenants', 'B', plan.values.filename);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-local-receipt-'));
    root = path.join(directory, 'root');
    await fs.mkdir(root);
    const staged = path.join(directory, 'staged');
    await fs.writeFile(staged, bytes);
    plan = await files.prepareStagedAttachmentStorage(
      {
        id: 17,
        name: 'local',
        title: 'Local',
        type: 'local',
        baseUrl: '/files',
        path: 'tenants/B',
        options: { documentRoot: root },
      },
      { path: staged, originalname: 'receipt.pdf', mimetype: 'application/pdf', size: bytes.length },
    );
  });
  afterEach(async () => {
    try {
      await plan?.discard();
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  async function inspectInChild(receiptPath: string) {
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const receipt = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      const identity = location => {
        const stat = fs.lstatSync(location, { bigint: true });
        return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
      };
      const filename = path.join(receipt.root, receipt.path, receipt.filename);
      process.stdout.write(JSON.stringify({
        directories: ['', 'tenants', 'tenants/B'].map(relative => ({path: relative, ...identity(path.join(receipt.root, relative))})),
        object: identity(filename), size: fs.lstatSync(filename).size,
      }));
    `;
    const result = await run(process.execPath, ['-e', script, receiptPath], { windowsHide: true });
    return JSON.parse(result.stdout);
  }

  it('provides JSON-safe exact file and directory identities independently verified in another process', async () => {
    let receipt: files.StagedAttachmentLocalReceipt;
    const receiptPath = path.join(directory, 'receipt.json');
    await plan.storeForRecovery(async (captured) => {
      receipt = captured;
      expect(receipt).toMatchObject({
        version: 1,
        kind: 'local',
        root: await fs.realpath(root),
        path: 'tenants/B',
        filename: plan.values.filename,
        storageId: 17,
        size: bytes.length,
      });
      await fs.writeFile(receiptPath, JSON.stringify(receipt));
      const actual = await inspectInChild(receiptPath);
      expect(actual.size).toBe(0);
      expect(receipt.directories).toEqual(actual.directories);
      expect(receipt.object).toEqual(actual.object);
      expect(Object.values(receipt.object).every((value) => typeof value === 'string' && /^\d+$/.test(value))).toBe(
        true,
      );
    });
    expect(JSON.parse(await fs.readFile(receiptPath, 'utf8'))).toEqual(receipt);
    const actual = await inspectInChild(receiptPath);
    expect(actual.size).toBe(bytes.length);
    expect(actual.object).toEqual(receipt.object);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('awaits receipt persistence before writing any content', async () => {
    let ready: () => void;
    let release: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = plan.storeForRecovery(async () => {
      ready();
      await persisted;
    });
    try {
      await Promise.race([
        entered,
        writing.then(() => {
          throw new Error('Copy ended before receipt persistence');
        }),
      ]);
      expect((await fs.stat(destination())).size).toBe(0);
    } finally {
      release();
      await writing;
    }
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('leaves a failed receipt object for transaction-owned cleanup and preserves unrelated files', async () => {
    const unrelated = path.join(root, 'unrelated.txt');
    await fs.writeFile(unrelated, 'keep');
    const failure = new Error('Receipt persistence failed');
    await expect(
      plan.storeForRecovery(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await fs.stat(destination())).size).toBe(0);
    await plan.discard();
    await expect(fs.stat(destination())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('rejects a missing persistence callback before consuming its plan or creating a file', async () => {
    await expect(plan.storeForRecovery(undefined)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readdir(root)).toEqual([]);
    await plan.storeForRecovery(async () => {});
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('captures once and cannot overwrite its earlier file through another store call', async () => {
    let captures = 0;
    const capture = async () => {
      captures++;
    };
    await plan.storeForRecovery(capture);
    await expect(plan.storeForRecovery(capture)).rejects.toBeInstanceOf(TypeError);
    await expect(plan.store()).rejects.toBeInstanceOf(TypeError);
    expect(captures).toBe(1);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });
});
