export type AssociationReadAction = 'get' | 'list';

export type AssociationReadPermissions = Partial<Record<AssociationReadAction, readonly string[]>>;

/** Register explicit ACL grants for associations used by workflow detail views. */
export function registerAssociationReadPermissions(
  acl: { allow: (resource: string, action: AssociationReadAction, condition: string) => void },
  permissions: AssociationReadPermissions,
  condition = 'loggedIn',
) {
  for (const [action, resources] of Object.entries(permissions) as [AssociationReadAction, readonly string[]][]) {
    for (const resource of resources) {
      acl.allow(resource, action, condition);
    }
  }
}

export const WORKFLOW_DETAIL_ASSOCIATION_READS: AssociationReadPermissions = {
  get: [
    'workflowNotice.workflow',
    'workflowNotice.node',
    'workflowNotice.job',
    'workflowNotice.execution',
    'workflowNotice.user',
    'users_jobs.workflow',
    'users_jobs.node',
    'users_jobs.job',
    'users_jobs.execution',
    'users_jobs.user',
  ],
  list: ['workflows.nodes', 'executions.jobs'],
};
