import { css } from '@tachybase/client';

import { defaultFieldNames, WorkflowVariableRawTextArea } from '../..';
import { NAMESPACE } from '../../locale';
import { Instruction } from '../../nodes/default-node/interface';

/** 节点: SQL
 *
 * Tenant isolation boundary:
 * - The SQL instruction executes raw SQL via `db.sequelize.query()` directly.
 * - It does NOT call `applyTenantFilterToContext()` — no tenant filtering is applied.
 * - Unlike Query/Select/Update/Destroy/Aggregate instructions, the SQL instruction
 *   bypasses the repository layer and tenant resource guard entirely.
 * - Workflow users must manually include tenant conditions (e.g. `WHERE tenantId = ...`)
 *   in their SQL when accessing tenant-scoped data.
 * - When module-tenant is enabled, its client plugin injects the corresponding UI warning.
 */
export default class extends Instruction {
  title = `{{t("SQL action", { ns: "${NAMESPACE}" })}}`;
  type = 'sql';
  group = 'collection';
  icon = 'ConsoleSqlOutlined';
  color = '#e9bf36';
  description = `{{t("Execute a SQL statement in database.", { ns: "${NAMESPACE}" })}}`;
  fieldset = {
    dataSource: {
      type: 'string',
      required: true,
      title: `{{t("Data source")}}`,
      description: `{{t("Select a data source to execute SQL.", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'DataSourceSelect',
      'x-component-props': {
        className: 'auto-width',
        filter(item) {
          return item.options.isDBInstance;
        },
      },
      default: 'main',
    },
    sql: {
      type: 'string',
      required: true,
      title: 'SQL',
      'x-decorator': 'FormItem',
      'x-component': 'WorkflowVariableRawTextArea',
      'x-component-props': {
        rows: 20,
        className: css`
          font-size: 80%;
          font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
        `,
      },
    },
    remarks: {
      type: 'string',
      title: `{{t("Remarks", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Input.TextArea',
      'x-component-props': {
        autoSize: {
          minRows: 3,
        },
        placeholder: `{{t("Input remarks", { ns: "${NAMESPACE}" })}}`,
      },
    },
  };
  components = {
    WorkflowVariableRawTextArea,
  };
  useVariables({ key, title }, { types, fieldNames = defaultFieldNames }) {
    return {
      [fieldNames.value]: key,
      [fieldNames.label]: title,
    };
  }
}
