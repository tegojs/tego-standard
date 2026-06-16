import { createMockServer, MockServer } from '@tachybase/test';
import Database from '@tego/server';

import { UserModel } from '../models/UserModel';

describe('models', () => {
  let app: MockServer;
  let db: Database;

  beforeEach(async () => {
    app = await createMockServer({
      plugins: ['auth', 'users'],
    });
    db = app.db;
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('model registeration', async () => {
    const model = db.getModel('users');
    const u1 = model.build({ nickname: 'test', password: '123' });
    // 验证模型注册成功 - 检查实例是否拥有 UserModel 特有的 desensitize 方法
    expect(typeof u1.desensitize).toBe('function');
    const n = u1.desensitize();
    expect(n.password).toBeUndefined();
  });
});
