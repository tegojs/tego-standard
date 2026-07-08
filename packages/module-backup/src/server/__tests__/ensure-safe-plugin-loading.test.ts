import { ensureSafePluginLoading } from '../utils/ensure-safe-plugin-loading';
import createApp from './index';

describe('ensureSafePluginLoading', () => {
  it('should continue repository init when sanitize throws', async () => {
    const app = await createApp({ plugins: ['error-handler', 'collection', 'data-source-manager', 'backup'] });
    let initCalled = false;

    const repository = app.pm.repository as { init: () => Promise<void> };
    repository.init = async () => {
      initCalled = true;
    };

    ensureSafePluginLoading(app);

    const pluginsRepository = app.db.getRepository('applicationPlugins');
    pluginsRepository.find = async () => {
      throw new Error('sanitize failed');
    };

    await repository.init();

    expect(initCalled).toBe(true);

    await app.destroy();
  });
});
