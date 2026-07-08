import { Database, mockDatabase } from '@tego/server';

import { sanitizeUnavailableApplicationPlugins } from '../utils/sanitize-application-plugins';
import createApp from './index';

describe('sanitizeUnavailableApplicationPlugins', () => {
  let db: Database;

  beforeEach(async () => {
    db = mockDatabase();
    await db.clean({ drop: true });
  });

  afterEach(async () => {
    await db.close();
  });

  it('should remove application plugins that are unavailable locally', async () => {
    const app = await createApp({ plugins: ['error-handler', 'collection', 'data-source-manager', 'backup'] });

    await app.db.getRepository('applicationPlugins').create({
      values: {
        name: 'tenant',
        packageName: '@tachybase/module-tenant',
        enabled: true,
        installed: true,
      },
    });

    const skipped = await sanitizeUnavailableApplicationPlugins(app);
    expect(skipped).toEqual(['tenant']);

    const remaining = await app.db.getRepository('applicationPlugins').find({
      filter: {
        packageName: '@tachybase/module-tenant',
      },
    });
    expect(remaining).toHaveLength(0);

    await app.destroy();
  });
});
