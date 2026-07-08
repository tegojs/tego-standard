import { Application } from '@tego/server';

import { sanitizeUnavailableApplicationPluginsSafely } from './sanitize-application-plugins';

const patchedRepositories = new WeakSet<object>();

export function ensureSafePluginLoading(app: Application) {
  const repository = app.pm.repository as { init: () => Promise<void> };
  if (patchedRepositories.has(repository)) {
    return;
  }

  const originalInit = repository.init.bind(repository);
  repository.init = async () => {
    await sanitizeUnavailableApplicationPluginsSafely(app);
    return originalInit();
  };

  patchedRepositories.add(repository);
}
