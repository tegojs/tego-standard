export type Scalar = string | number | boolean | null;
export type FieldType = 'id' | 'string' | 'number' | 'boolean' | 'date';
export type ContextPath = 'tenant.id' | 'user.id' | 'role.name' | 'tenant.ancestorIds' | 'tenant.descendantIds';

export type AccessOperand =
  | { type: 'field'; path: string }
  | { type: 'context'; path: ContextPath }
  | { type: 'literal'; value: Scalar | Scalar[] };

export type AccessCondition =
  | { type: 'constant'; value: boolean }
  | { type: 'all' | 'any'; children: AccessCondition[] }
  | { type: 'not'; child: AccessCondition }
  | {
      type: 'compare';
      operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'includes';
      left: AccessOperand;
      right: AccessOperand;
    }
  | { type: 'isNull'; operand: AccessOperand }
  | { type: 'exists'; path: string; condition: AccessCondition }
  | {
      type: 'tenantRelation';
      tenant: AccessOperand;
      relation: 'same' | 'ancestor' | 'descendant';
      includeSelf: boolean;
    };

export interface AccessRule {
  id: string;
  name: string;
  enabled: boolean;
  category: 'ownership' | 'visibility';
  subject: AccessCondition;
  condition: AccessCondition;
}

export interface AccessConfig {
  schemaVersion: 1;
  revision: number;
  ownership: { enabled: boolean };
  rules: AccessRule[];
}

export interface FieldMetadata {
  column: string;
  type: FieldType;
  /** Server-only dialect encoding; values remain bound parameters. */
  formatValue?: (value: Scalar) => Scalar;
}

/** Server-resolved metadata. Never construct this from action parameters. */
export interface CollectionMetadata {
  key: string;
  table: string[];
  fields: Record<string, FieldMetadata>;
  associations: Record<string, AssociationMetadata>;
  /** Trusted model restrictions, including soft deletion and default scope. */
  constraints?: AccessCondition;
}

export interface AssociationMetadata {
  target: CollectionMetadata;
  sourceField: string;
  targetField: string;
  constraints?: AccessCondition;
  through?: {
    collection: CollectionMetadata;
    sourceField: string;
    targetField: string;
    constraints?: AccessCondition;
  };
}

export interface CompileOptions {
  collection: CollectionMetadata;
  /** Values must come from authenticated server state and verified tenant hierarchy. */
  context: Partial<Record<ContextPath, Scalar | Scalar[]>>;
  quoteIdentifier: (identifier: string) => string;
  rootAlias?: string;
  /** Server-selected namespace when combining separately compiled query predicates. */
  parameterPrefix?: string;
}

export interface SqlScope {
  sql: string;
  bind: Record<string, Scalar>;
}

export interface AccessScopes {
  ownership: SqlScope;
  visibility: SqlScope;
  read: SqlScope;
}

/** Internal diagnostic error; HTTP adapters must translate the code for users. */
export class AccessRuleError extends Error {
  constructor(
    public readonly code: 'INVALID_ACCESS_RULE' | 'MISSING_ACCESS_CONTEXT',
    message: string,
  ) {
    super(message);
    this.name = 'AccessRuleError';
  }
}
