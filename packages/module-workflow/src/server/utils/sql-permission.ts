import type Processor from '../Processor';
import { getExecutionField } from '../Processor';

interface AuthContext {
  currentRole?: string;
  currentUser?: any;
  currentUserId?: string | number | null;
}

/**
 * Core SQL snippet permission check.
 *
 * SQL instructions bypass the repository layer and execute raw SQL directly,
 * so they require the `pm.workflow.sql` snippet (covered by `pm.*` for root/admin).
 *
 * @param acl - The ACL instance
 * @param roleName - The current role name
 * @param errorMessage - Custom error message for the denial
 * @throws Error if the role does not have the pm.workflow.sql snippet
 */
export function assertSqlSnippetPermission(acl: any, roleName: string, errorMessage: string): void {
  // root is always allowed
  if (roleName === 'root') {
    return;
  }

  if (!acl) {
    throw new Error(errorMessage);
  }

  const aclRole = acl.getRole(roleName);
  if (!aclRole) {
    throw new Error(errorMessage);
  }

  const { allowed } = aclRole.effectiveSnippets();
  if (!allowed.includes('pm.workflow.sql')) {
    throw new Error(errorMessage);
  }
}

/**
 * Resolve ACL instance from a real or synthetic request context.
 *
 * Tries multiple access patterns used across the codebase:
 * - `httpContext.app.acl` (direct app shortcut)
 * - `httpContext.tego.acl` (TachyBase context wrapper, used in role-check.ts, query.ts, etc.)
 * - `httpContext.app.dataSourceManager.dataSources.get('main').acl` (dataSource path)
 * - `httpContext.tego.dataSourceManager.dataSources.get('main').acl` (tego + dataSource path)
 */
function resolveAcl(httpContext: any): any | null {
  return (
    httpContext.app?.acl ||
    httpContext.tego?.acl ||
    httpContext.app?.dataSourceManager?.dataSources?.get('main')?.acl ||
    httpContext.tego?.dataSourceManager?.dataSources?.get('main')?.acl ||
    null
  );
}

/**
 * SQL execution permission check for the processor context.
 *
 * Used by SQLInstruction.ts to gate raw SQL execution at runtime.
 *
 * Permission model:
 * - **API-triggered** (has httpContext): check the user's role for pm.workflow.sql.
 *   Fail-closed: if role info is missing, deny execution.
 * - **Internal trigger** (no httpContext, e.g. collection/schedule events): allow.
 *   These are trusted internal triggers where no user context is available.
 *   The workflow was created by an authorized user, so the SQL node itself
 *   was already gated at creation time by the API-level check in nodes.ts.
 */
export function checkSqlExecutionPermission(processor: Processor): void {
  const authContext = getExecutionField<AuthContext>(processor.execution, 'authContext', {});
  const httpContext =
    processor.options?.httpContext ||
    (authContext?.currentRole
      ? {
          state: {
            currentRole: authContext.currentRole,
            currentUser:
              authContext.currentUser ||
              (authContext.currentUserId != null ? { id: authContext.currentUserId } : undefined),
          },
          app: processor.options?.plugin?.app,
          tego: processor.options?.plugin?.app,
        }
      : null);

  // No httpContext means an internal trigger (collection event, schedule, etc.)
  // These are trusted — the SQL node was already permission-gated at creation time.
  if (!httpContext) {
    return;
  }

  const roleName = httpContext.state?.currentRole;
  if (!roleName) {
    throw new Error('SQL instruction execution requires a valid role');
  }

  const acl = resolveAcl(httpContext);
  assertSqlSnippetPermission(acl, roleName, 'SQL instruction execution requires the pm.workflow.sql permission');
}
