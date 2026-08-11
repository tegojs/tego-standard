import PluginAuditLogs from '..';

export function auditLogsTestPlugin() {
  return [
    PluginAuditLogs,
    {
      name: 'audit-logs',
      packageName: '@tachybase/plugin-audit-logs',
      workspaceSource: true,
    },
  ];
}
