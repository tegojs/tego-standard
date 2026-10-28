import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as files from '..';

describe('read-only local upload recovery identity checks', () => {
  let directory: string;
  let root: string;
  let receipt: files.StagedAttachmentLocalReceipt;
  let expected: { root: string; values: files.StagedAttachmentStorageValues };
  const bytes = Buffer.from('Owned recovery content');
  const destination = () => path.join(root, 'tenants', 'B', expected.values.filename);

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-local-recovery-'));
    root = path.join(directory, 'root');
    await fs.mkdir(root);
    const staged = path.join(directory, 'staged');
    await fs.writeFile(staged, bytes);
    const plan = await files.prepareStagedAttachmentStorage(
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
    expected = { root, values: plan.values };
    await plan.storeForRecovery(async (captured) => {
      receipt = JSON.parse(JSON.stringify(captured));
    });
  });

  afterEach(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('recognizes its JSON receipt without changing or removing the file', async () => {
    expect(await files.verifyLocalStagedAttachment(expected, receipt)).toEqual({
      state: 'present',
      size: bytes.length,
    });
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('recognizes an incomplete owned file without granting cleanup', async () => {
    await fs.truncate(destination(), 0);
    expect(await files.verifyLocalStagedAttachment(expected, receipt)).toEqual({ state: 'present', size: 0 });
    expect((await fs.stat(destination())).size).toBe(0);
  });

  it('reports a missing object only below the verified original directory chain', async () => {
    await fs.unlink(destination());
    expect(await files.verifyLocalStagedAttachment(expected, receipt)).toEqual({ state: 'missing' });
    expect(await fs.readdir(path.dirname(destination()))).toEqual([]);
  });

  it('rejects a same-sized replacement file and preserves it', async () => {
    await fs.rename(destination(), path.join(directory, 'original'));
    await fs.writeFile(destination(), Buffer.alloc(bytes.length, 65));
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(Buffer.alloc(bytes.length, 65));
  });

  it('rejects a replaced directory even when the original file is moved back into it', async () => {
    const parent = path.dirname(destination());
    const previous = path.join(directory, 'previous');
    await fs.rename(parent, previous);
    await fs.mkdir(parent);
    await fs.rename(path.join(previous, expected.values.filename), destination());
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('does not treat a missing parent directory as evidence that the object can be cleared', async () => {
    await fs.rename(path.dirname(destination()), path.join(directory, 'previous'));
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(path.join(directory, 'previous', expected.values.filename))).toEqual(bytes);
  });

  it('rejects a replaced root even when all descendant identities are preserved', async () => {
    const previous = path.join(directory, 'previous-root');
    await fs.rename(root, previous);
    await fs.mkdir(root);
    await fs.rename(path.join(previous, 'tenants'), path.join(root, 'tenants'));
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('refuses to traverse a directory junction pointing to the original object', async () => {
    const previous = path.join(directory, 'original-directory');
    await fs.rename(path.dirname(destination()), previous);
    await fs.symlink(previous, path.dirname(destination()), 'junction');
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(path.join(previous, expected.values.filename))).toEqual(bytes);
  });

  it.each([
    [
      'root',
      (value) => {
        value.root = directory;
      },
    ],
    [
      'path traversal',
      (value) => {
        value.path = '../root/tenants/B';
      },
    ],
    [
      'filename',
      (value) => {
        value.filename = '../unrelated';
      },
    ],
    [
      'storage',
      (value) => {
        value.storageId = 18;
      },
    ],
    [
      'size',
      (value) => {
        value.size++;
      },
    ],
    [
      'directory chain',
      (value) => {
        value.directories.splice(1, 1);
      },
    ],
    [
      'directory order',
      (value) => {
        value.directories.reverse();
      },
    ],
    [
      'file identity',
      (value) => {
        value.object.ino = '0';
      },
    ],
    [
      'version',
      (value) => {
        value.version = 2;
      },
    ],
  ])('rejects mismatched %s before trusting the object', async (_name, change) => {
    const altered = JSON.parse(JSON.stringify(receipt));
    change(altered);
    await expect(files.verifyLocalStagedAttachment(expected, altered)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('rejects accessor-bearing receipts without executing their getters', async () => {
    let invoked = false;
    Object.defineProperty(receipt, 'root', {
      get() {
        invoked = true;
        return root;
      },
      enumerable: true,
    });
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(invoked).toBe(false);
    expect(await fs.readFile(destination())).toEqual(bytes);
  });

  it('rejects an oversized owned object without modifying it', async () => {
    await fs.appendFile(destination(), 'extra');
    await expect(files.verifyLocalStagedAttachment(expected, receipt)).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(destination())).toEqual(Buffer.concat([bytes, Buffer.from('extra')]));
  });
});
