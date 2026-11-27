import { AccessRuleError, type AccessConfig, type CollectionMetadata, type FieldType } from './types';

const contextTypes = {
  'tenant.id': { type: 'id', many: false },
  'user.id': { type: 'id', many: false },
  'role.name': { type: 'string', many: false },
  'tenant.ancestorIds': { type: 'id', many: true },
  'tenant.descendantIds': { type: 'id', many: true },
} as const;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AccessRuleError('INVALID_ACCESS_RULE', message);
}

function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a rule object');
  const prototype = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null, 'Expected a plain rule object');
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  ensure(
    Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown rule property',
  );
}

function text(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= 256, 'Expected nonempty rule text');
}

interface OperandType {
  type: FieldType | 'null';
  many: boolean;
}

function scalarType(value: unknown): OperandType['type'] {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    ensure(value.length <= 10000, 'Rule value exceeds length limit');
    return 'string';
  }
  if (typeof value === 'boolean') return 'boolean';
  ensure(typeof value === 'number' && Number.isFinite(value), 'Expected a scalar rule value');
  ensure(!Number.isInteger(value) || Number.isSafeInteger(value), 'Unsafe numeric rule value');
  return 'number';
}

function compatible(left: OperandType['type'], right: OperandType['type']) {
  return (
    left === right ||
    (left === 'id' && ['string', 'number'].includes(right)) ||
    (right === 'id' && ['string', 'number'].includes(left)) ||
    (left === 'date' && right === 'string') ||
    (right === 'date' && left === 'string')
  );
}

function validDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function operand(value: unknown, collection: CollectionMetadata, subject: boolean): OperandType {
  object(value);
  switch (value.type) {
    case 'field': {
      keys(value, ['type', 'path']);
      ensure(!subject, 'Record fields are not allowed in subject conditions');
      text(value.path);
      ensure(Object.hasOwn(collection.fields, value.path), 'Unknown rule field');
      return { type: collection.fields[value.path].type, many: false };
    }
    case 'context':
      keys(value, ['type', 'path']);
      ensure(typeof value.path === 'string' && Object.hasOwn(contextTypes, value.path), 'Unknown context variable');
      return contextTypes[value.path as keyof typeof contextTypes];
    case 'literal': {
      keys(value, ['type', 'value']);
      if (!Array.isArray(value.value)) return { type: scalarType(value.value), many: false };
      ensure(value.value.length > 0 && value.value.length <= 1000, 'Rule value list must contain 1 to 1000 values');
      const types = value.value.map(scalarType);
      const first = types.find((type) => type !== 'null') ?? 'null';
      ensure(
        types.every((type) => type === first || type === 'null'),
        'Mixed types in rule value list',
      );
      return { type: first, many: true };
    }
    default:
      throw new AccessRuleError('INVALID_ACCESS_RULE', 'Unknown rule operand');
  }
}

/** Validate structure and metadata before compiling any enabled rule. */
export function validateAccessConfig(input: unknown, collection: CollectionMetadata): AccessConfig {
  object(input);
  keys(input, ['schemaVersion', 'revision', 'ownership', 'rules']);
  ensure(input.schemaVersion === 1, 'Unsupported access rule version');
  ensure(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 'Invalid rule revision');
  object(input.ownership);
  keys(input.ownership, ['enabled']);
  ensure(typeof input.ownership.enabled === 'boolean', 'Invalid ownership configuration');
  ensure(Array.isArray(input.rules) && input.rules.length <= 100, 'Expected at most 100 access rules');

  let nodes = 0;
  const condition = (value: unknown, target: CollectionMetadata, subject: boolean, depth = 0, hops = 0): void => {
    ensure(++nodes <= 1000 && depth <= 16, 'Access condition exceeds size or depth limit');
    object(value);
    switch (value.type) {
      case 'constant':
        keys(value, ['type', 'value']);
        ensure(typeof value.value === 'boolean', 'Expected a boolean rule constant');
        return;
      case 'all':
      case 'any':
        keys(value, ['type', 'children']);
        ensure(Array.isArray(value.children) && value.children.length > 0, 'Empty rule logic group');
        value.children.forEach((child) => condition(child, target, subject, depth + 1, hops));
        return;
      case 'not':
        keys(value, ['type', 'child']);
        condition(value.child, target, subject, depth + 1, hops);
        return;
      case 'isNull':
        keys(value, ['type', 'operand']);
        ensure(!operand(value.operand, target, subject).many, 'Cannot test a list for NULL');
        return;
      case 'compare': {
        keys(value, ['type', 'operator', 'left', 'right']);
        ensure(
          typeof value.operator === 'string' &&
            ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'includes'].includes(value.operator),
          'Unknown comparison operator',
        );
        const left = operand(value.left, target, subject);
        const right = operand(value.right, target, subject);
        ensure(
          (value.right as Record<string, unknown>).type !== 'field',
          'Field-to-field rule comparisons are unsupported',
        );
        ensure(!left.many && left.type !== 'null' && right.type !== 'null', 'Use isNull for NULL comparisons');
        ensure(right.many === ['in', 'notIn'].includes(String(value.operator)), 'Incorrect list comparison');
        ensure(compatible(left.type, right.type), 'Incompatible comparison types');
        if (left.type === 'date') {
          const rightOperand = value.right as Record<string, unknown>;
          ensure(rightOperand.type === 'literal', 'Date comparisons require a validated ISO date literal');
          const values = Array.isArray(rightOperand.value) ? rightOperand.value : [rightOperand.value];
          ensure(
            values.every((item) => item === null || validDate(item)),
            'Invalid ISO date literal',
          );
        }
        if (['gt', 'gte', 'lt', 'lte'].includes(String(value.operator))) {
          ensure(['number', 'date'].includes(left.type), 'Ordering requires a number or date field');
        }
        if (value.operator === 'includes')
          ensure(left.type === 'string' && right.type === 'string', 'Text matching requires strings');
        return;
      }
      case 'exists': {
        keys(value, ['type', 'path', 'condition']);
        ensure(!subject, 'Associations are not allowed in subject conditions');
        text(value.path);
        const segments = value.path.split('.');
        ensure(hops + segments.length <= 3, 'Access association exceeds three hops');
        let related = target;
        for (const segment of segments) {
          ensure(Object.hasOwn(related.associations, segment), 'Unknown rule association');
          const relation = related.associations[segment];
          if (relation.target.constraints)
            condition(relation.target.constraints, relation.target, false, depth + 1, hops);
          if (relation.constraints) condition(relation.constraints, relation.target, false, depth + 1, hops);
          ensure(Object.hasOwn(related.fields, relation.sourceField), 'Missing association source field');
          ensure(Object.hasOwn(relation.target.fields, relation.targetField), 'Missing association target field');
          if (relation.through) {
            const { collection: through, sourceField, targetField } = relation.through;
            ensure(
              Object.hasOwn(through.fields, sourceField) && Object.hasOwn(through.fields, targetField),
              'Missing association link fields',
            );
            if (through.constraints) condition(through.constraints, through, false, depth + 1, hops);
            if (relation.through.constraints) condition(relation.through.constraints, through, false, depth + 1, hops);
          }
          related = relation.target;
        }
        condition(value.condition, related, false, depth + 1, hops + segments.length);
        return;
      }
      case 'tenantRelation': {
        keys(value, ['type', 'tenant', 'relation', 'includeSelf']);
        ensure(
          typeof value.relation === 'string' && ['same', 'ancestor', 'descendant'].includes(value.relation),
          'Unknown tenant relationship',
        );
        ensure(typeof value.includeSelf === 'boolean', 'Tenant relationship must specify includeSelf');
        const tenant = operand(value.tenant, target, subject);
        ensure(!tenant.many && ['id', 'string'].includes(tenant.type), 'Tenant relationship requires a tenant ID');
        return;
      }
      default:
        throw new AccessRuleError('INVALID_ACCESS_RULE', 'Unknown access condition');
    }
  };

  const ids = new Set<string>();
  if (collection.constraints) condition(collection.constraints, collection, false);
  for (const rule of input.rules) {
    object(rule);
    keys(rule, ['id', 'name', 'enabled', 'category', 'subject', 'condition']);
    text(rule.id);
    text(rule.name);
    ensure(!ids.has(rule.id), 'Duplicate access rule ID');
    ids.add(rule.id);
    ensure(typeof rule.enabled === 'boolean', 'Expected boolean rule enabled state');
    ensure(rule.category === 'ownership' || rule.category === 'visibility', 'Unknown access category');
    condition(rule.subject, collection, true);
    condition(rule.condition, collection, false);
  }
  return input as unknown as AccessConfig;
}
