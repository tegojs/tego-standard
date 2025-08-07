import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { Application, applyMixins, AsyncEmitter } from '@tego/server';

export type AppMigratorOptions = {
  workDir?: string;
};
abstract class AppMigrator extends EventEmitter {
  public readonly workDir: string;
  public app: Application;

  abstract direction: 'restore' | 'dump';

  declare emitAsync: (event: string | symbol, ...args: any[]) => Promise<boolean>;

  constructor(app: Application, options?: AppMigratorOptions) {
    super();

    this.app = app;
    this.workDir = options?.workDir || this.tmpDir();
  }

  tmpDir() {
    return path.resolve(os.tmpdir(), `tachybase-${crypto.randomUUID()}`);
  }

  async rmDir(dir: string) {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }

  async clearWorkDir() {
    await this.rmDir(this.workDir);
  }
}

applyMixins(AppMigrator, [AsyncEmitter]);
export { AppMigrator };
