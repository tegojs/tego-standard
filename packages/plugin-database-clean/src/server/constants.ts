/**
 * 白名单表列表 - 只有这些表可以被分析和清理
 */
export const WHITELIST_TABLES: string[] = [
  'auditChanges', // 审计日志变动值
  'jobs', // 工作流任务日志
  'executions', // 工作流执行记录
  'apiLogsChanges', // API 日志变动值
  'auditLogs', // 审计日志
];
