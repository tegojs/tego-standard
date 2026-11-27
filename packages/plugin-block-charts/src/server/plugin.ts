import path, { resolve } from 'node:path';
import { Cache, Container, InstallOptions, Plugin, type PluginOptions } from '@tego/server';

import { query, scopeCustomQuery } from './actions/query';
import { createChartQuery, type ChartQueryResolver } from './actions/query-entry';
import { SqlLoader } from './services/sql-loader';

export interface DataVisualizationPluginOptions extends PluginOptions {
  /** Server bootstrap only; selected executors must perform their own authorization. */
  queryResolver?: ChartQueryResolver;
}

export class DataVisualizationPlugin extends Plugin {
  declare options: DataVisualizationPluginOptions;
  cache: Cache;

  afterAdd() {}

  beforeLoad() {
    // Capture once: later option mutations must not replace the registered authorization entry.
    const resolve = this.options.queryResolver;
    if (resolve !== undefined && typeof resolve !== 'function')
      throw new TypeError('Chart query resolver must be a server function');
    this.app.resourcer.define({
      name: 'charts',
      actions: {
        query: resolve === undefined ? query : createChartQuery(resolve),
      },
    });
    this.app.resourcer.use(scopeCustomQuery, {
      tag: 'chartCustomQueryScope',
      after: 'acl',
      before: 'dataSource',
    });
    this.app.acl.allow('charts', 'query', 'loggedIn');
  }

  async load() {
    const sqlLoader = Container.get(SqlLoader);
    await sqlLoader.loadSqlFiles(path.join(__dirname, './sqls'));
    this.db.addMigrations({
      namespace: 'data-visulization',
      directory: resolve(__dirname, 'migrations'),
      context: {
        plugin: this,
      },
    });

    this.cache = await this.app.cacheManager.createCache({
      name: 'data-visualization',
      store: 'memory',
      ttl: 30 * 1000, // millseconds
      max: 1000,
    });
  }

  async install(options?: InstallOptions) {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default DataVisualizationPlugin;
