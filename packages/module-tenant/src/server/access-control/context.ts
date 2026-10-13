import type { Database, Transaction } from '@tego/server';

import { normalizeAccessContextValue } from './context-values';
import {
  AccessRuleError,
  type AccessCondition,
  type AccessConfig,
  type AccessOperand,
  type CompileOptions,
  type ContextPath,
} from './types';

/** Supplied by authenticated request/workflow adapters, never copied from request headers. */
export interface AccessIdentity {
  tenantId?: string | number;
  userId?: string | number;
  roleName?: string;
}

/** Same trusted identity check for reads and first-edit claims; writes may hold a shared tenant lock. */
export async function resolveActiveAccessTenant(
  db: Database,
  identity: AccessIdentity,
  options: { transaction?: Transaction; lock?: boolean } = {},
): Promise<string> {
  const tenantId = normalizeAccessContextValue('tenant.id', identity.tenantId) as string;
  const model = db.getCollection('tenants')?.model;
  if (!model) throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Tenant identity source is unavailable');
  const query = {
    where: { id: tenantId, enabled: true },
    attributes: ['id'],
    transaction: options.transaction,
    useMaster: true,
    hooks: false,
    ...(options.lock && options.transaction ? { lock: options.transaction.LOCK.SHARE } : {}),
  };
  const active = await model.unscoped().findOne(query);
  if (!active) throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Current tenant is missing or disabled');
  return tenantId;
}

function requiredPaths(config: AccessConfig): Set<ContextPath> {
  const paths = new Set<ContextPath>();
  const operand = (value: AccessOperand) => {
    if (value.type === 'context') paths.add(value.path);
  };
  const visit = (condition: AccessCondition) => {
    switch (condition.type) {
      case 'all':
      case 'any':
        condition.children.forEach(visit);
        break;
      case 'not':
        visit(condition.child);
        break;
      case 'compare':
        operand(condition.left);
        operand(condition.right);
        break;
      case 'isNull':
        operand(condition.operand);
        break;
      case 'exists':
        visit(condition.condition);
        break;
      case 'tenantRelation':
        operand(condition.tenant);
        paths.add('tenant.id');
        if (condition.relation !== 'same')
          paths.add(condition.relation === 'ancestor' ? 'tenant.descendantIds' : 'tenant.ancestorIds');
        break;
    }
  };
  for (const rule of config.rules) {
    if (rule.enabled) {
      visit(rule.subject);
      visit(rule.condition);
    }
  }
  if (paths.has('tenant.ancestorIds') || paths.has('tenant.descendantIds')) paths.add('tenant.id');
  return paths;
}

/** Config must already be validated. A mutation adapter must pass its actual authorization transaction. */
export async function resolveAccessContext(
  db: Database,
  config: AccessConfig,
  identity: AccessIdentity,
  options: { transaction?: Transaction } = {},
): Promise<CompileOptions['context']> {
  const { transaction } = options;
  // Sequelize exposes these runtime properties but omits them from its Transaction declarations.
  const transactionState = transaction as
    | (Transaction & { finished?: string; sequelize: Database['sequelize'] })
    | undefined;
  if (transactionState && (transactionState.finished || transactionState.sequelize !== db.sequelize)) {
    throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Invalid authorization transaction');
  }
  const paths = requiredPaths(config);
  const context: CompileOptions['context'] = {};
  if (paths.has('user.id')) context['user.id'] = normalizeAccessContextValue('user.id', identity.userId);
  if (paths.has('role.name')) context['role.name'] = normalizeAccessContextValue('role.name', identity.roleName);
  if (!paths.has('tenant.id')) return context;
  const tenantId = await resolveActiveAccessTenant(db, identity, { transaction });
  const model = db.getCollection('tenants').model;
  context['tenant.id'] = tenantId;
  if (!paths.has('tenant.ancestorIds') && !paths.has('tenant.descendantIds')) return context;

  // Read authorization facts in the supplied transaction; do not reuse middleware path caches.
  const records = await model
    .unscoped()
    .findAll({ attributes: ['id', 'parentId', 'enabled'], limit: 10001, transaction });
  if (records.length > 10000)
    throw new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Tenant hierarchy exceeds supported size');
  const tenants = new Map(
    records.map((record) => {
      const id = normalizeAccessContextValue('tenant.id', record.get('id')) as string;
      const parent = record.get('parentId');
      return [
        id,
        {
          parent: parent == null ? null : (normalizeAccessContextValue('tenant.id', parent) as string),
          enabled: record.get('enabled') === true,
        },
      ] as const;
    }),
  );
  const invalidHierarchy = () => new AccessRuleError('MISSING_ACCESS_CONTEXT', 'Invalid tenant hierarchy');
  const ancestors: string[] = [];
  const visited = new Set([tenantId]);
  let parent = tenants.get(tenantId)?.parent;
  if (!tenants.get(tenantId)?.enabled) throw invalidHierarchy();
  while (parent != null) {
    if (visited.has(parent) || !tenants.has(parent)) throw invalidHierarchy();
    visited.add(parent);
    const tenant = tenants.get(parent)!;
    if (tenant.enabled) ancestors.push(parent);
    parent = tenant.parent;
  }
  if (paths.has('tenant.ancestorIds'))
    context['tenant.ancestorIds'] = normalizeAccessContextValue('tenant.ancestorIds', ancestors);
  if (paths.has('tenant.descendantIds')) {
    const children = new Map<string, string[]>();
    for (const [id, tenant] of tenants) {
      if (tenant.parent != null) {
        const siblings = children.get(tenant.parent) ?? [];
        siblings.push(id);
        children.set(tenant.parent, siblings);
      }
    }
    const descendants: string[] = [];
    const queue = [tenantId];
    const seen = new Set(queue);
    for (let index = 0; index < queue.length; index++) {
      for (const child of children.get(queue[index]) ?? []) {
        if (seen.has(child)) throw invalidHierarchy();
        seen.add(child);
        queue.push(child);
        if (tenants.get(child)!.enabled) descendants.push(child);
      }
    }
    context['tenant.descendantIds'] = normalizeAccessContextValue('tenant.descendantIds', descendants.sort());
  }
  return context;
}
