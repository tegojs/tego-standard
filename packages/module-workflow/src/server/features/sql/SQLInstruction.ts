import { FlowNodeModel, Instruction, JOB_STATUS, Processor } from '../..';
import { checkSqlExecutionPermission } from '../../utils/sql-permission';

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
 * - The tenant context (currentTenantId, descendant IDs, etc.) IS available on
 *   the processor's execution record, but this instruction intentionally does
 *   not use it — SQL statements are opaque to the framework and cannot be safely
 *   rewritten to include tenant conditions.
 * - Workflow authors MUST manually include tenant conditions in their SQL
 *   (e.g. `WHERE tenantId = '{{$context.state.currentTenant.id}}'`) when
 *   accessing tenant-scoped data.
 *
 * Permission boundary:
 * - Only users with the `pm.workflow.sql` snippet (or root/admin via `pm.*`)
 *   may execute SQL instructions.
 * - The check is fail-closed: missing httpContext or role information results
 *   in denial. Internal system triggers without user context cannot execute SQL.
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
    const sql = processor.getParsedValue(node.config.sql || '', node.id).trim();
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
