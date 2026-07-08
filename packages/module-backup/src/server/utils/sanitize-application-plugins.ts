import { Application, PluginManager } from '@tego/server';

export async function isApplicationPluginAvailable(packageName: string) {
  if (!packageName) {
    return false;
  }

  try {
    await PluginManager.getPackageJson(packageName);
  } catch {
    return false;
  }

  try {
    await PluginManager.resolvePlugin(packageName, false, true);
    return true;
  } catch {
    return false;
  }
}

export async function sanitizeUnavailableApplicationPlugins(app: Application) {
  const repository = app.db.getRepository('applicationPlugins');
  const plugins = await repository.find();
  const skipped: string[] = [];

  for (const plugin of plugins) {
    const packageName = plugin.get('packageName');
    if (!packageName) {
      continue;
    }

    const available = await isApplicationPluginAvailable(packageName);
    if (available) {
      continue;
    }

    const name = plugin.get('name') || packageName;
    skipped.push(name);

    await repository.destroy({
      filterByTk: plugin.get('id'),
    });
  }

  if (skipped.length) {
    app.logger.warn(`Skipped unavailable application plugins: ${skipped.join(', ')}`);
  }

  return skipped;
}

export async function sanitizeUnavailableApplicationPluginsSafely(app: Application) {
  try {
    return await sanitizeUnavailableApplicationPlugins(app);
  } catch (error) {
    app.logger.warn('Failed to sanitize unavailable application plugins:', error);
    return [];
  }
}
