import { FlowNodeModel, Instruction, JOB_STATUS, Processor } from '../..';
import { checkSqlExecutionPermission } from '../../utils/sql-permission';

function pickTenantTemplateState(state: Record<string, any> = {}) {
  const {
    currentTenant,
    currentTenantId,
    currentTenantDescendantIds,
    currentTenancyMode,
    currentLegacyDataTenantIds,
    tenantContextSource,
    actorUserId,
    impersonatedTenantId,
    isTenantImpersonation,
  } = state;

  return {
    ...(currentTenant !== undefined ? { currentTenant } : {}),
    ...(currentTenantId !== undefined ? { currentTenantId } : {}),
    ...(currentTenantDescendantIds !== undefined ? { currentTenantDescendantIds } : {}),
    ...(currentTenancyMode !== undefined ? { currentTenancyMode } : {}),
    ...(currentLegacyDataTenantIds !== undefined ? { currentLegacyDataTenantIds } : {}),
    ...(tenantContextSource !== undefined ? { tenantContextSource } : {}),
    ...(actorUserId !== undefined ? { actorUserId } : {}),
    ...(impersonatedTenantId !== undefined ? { impersonatedTenantId } : {}),
    ...(isTenantImpersonation !== undefined ? { isTenantImpersonation } : {}),
  };
}

function buildSqlTemplateRepositoryContext(repositoryContext: Record<string, any> = {}) {
  return {
    state: pickTenantTemplateState(repositoryContext.state),
    ...(Array.isArray(repositoryContext.stack) ? { stack: repositoryContext.stack } : {}),
  };
}

/**
 * SQL workflow instruction.
 *
 * Tenant isolation boundary:
 * - This instruction executes raw SQL via `db.sequelize.query()` directly.
 * - It does NOT call `applyTenantFilterToContext()` and bypasses the repository
 *   layer entirely. No tenant filtering is applied to the SQL statement.
 * - Unlike Query/Select/Update/Destroy/Aggregate instructions which use the
 *   repository API and receive automatic tenant scoping, the SQL instruction
 *   operates at the raw database driver level.
 * - A tenant-safe subset of the restored repository context is exposed to SQL
 *   templates as `$repositoryContext` and `$tenantContext`, but this instruction
 *   intentionally does not rewrite SQL — statements are opaque to the framework
 *   and cannot be safely patched to include tenant conditions.
 * - Workflow authors MUST manually include tenant conditions in their SQL
 *   (e.g. `WHERE tenantId = '{{$tenantContext.currentTenantId}}'`) when
 *   accessing tenant-scoped data.
 *
 * Permission boundary:
 * - Only users with the `pm.workflow.sql` snippet (or root/admin via `pm.*`)
 *   may execute SQL instructions.
 * - For API-triggered workflows, the check is fail-closed: missing role
 *   information results in denial.
 * - Internal triggers (collection/schedule events) without httpContext are
 *   allowed because the SQL node was already permission-gated at creation
 *   time by the API-level check in nodes.ts.
 */
export default class extends Instruction {
  async run(node: FlowNodeModel, input, processor: Processor) {
    // Permission guard: only users with pm.workflow.sql may execute raw SQL
    checkSqlExecutionPermission(processor);

    // @ts-ignore
    const { db } = this.workflow.app.dataSourceManager.dataSources.get(
      node.config.dataSource || 'main',
    ).collectionManager;
    if (!db) {
      throw new Error(`type of data source "${node.config.dataSource}" is not database`);
    }
    const repositoryContext = processor.getRepositoryContext();
    const templateRepositoryContext = buildSqlTemplateRepositoryContext(repositoryContext);
    const sql = processor
      .getParsedValue(node.config.sql || '', node.id, {
        $repositoryContext: templateRepositoryContext,
        $tenantContext: templateRepositoryContext.state,
      })
      .trim();
    if (!sql) {
      return {
        status: JOB_STATUS.RESOLVED,
      };
    }

    // @ts-ignore
    const result = await db.sequelize.query(sql, {
      transaction: processor.transaction,
      // plain: true,
      // model: db.getCollection(node.config.collection).model
    });

    return {
      result,
      status: JOB_STATUS.RESOLVED,
    };
  }
}
