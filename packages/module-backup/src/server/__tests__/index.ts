import { createMockServer } from '@tachybase/test';

import PluginAuditLogs from '../../../../plugin-audit-logs/src/server';

function normalizeTestPlugin(plugin: any) {
  if (plugin !== 'audit-logs') {
    return plugin;
  }

  return [
    PluginAuditLogs,
    {
      name: 'audit-logs',
      packageName: '@tachybase/plugin-audit-logs',
      workspaceSource: true,
    },
  ];
}

export const backupTestPlugins = [
  'error-handler',
  'collection-manager',
  'users',
  'auth',
  'acl',
  'data-source-manager',
  'backup',
  'audit-logs',
  'sequence-field',
  'block-map',
];

export const backupBaseTestPlugins = ['error-handler', 'collection-manager', 'data-source-manager', 'backup'];

export default async function createApp(options: { plugins?: any[] } = {}) {
  const app = await createMockServer({
    plugins: (options.plugins ?? backupTestPlugins).map(normalizeTestPlugin),
  });
  return app;
}
