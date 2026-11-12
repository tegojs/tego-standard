import { literal, Op, type Collection, type Context, type Database } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import type { AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { captureFinalActionPermission } from './final-action-permission';
import type { AccessQueryService } from './query';
import { captureReadPreparationMetadata } from './read-preparation-metadata';
import { AccessRoleFilterCompiler } from './role-filter';
import type { AccessRootReadContext } from './root-read-context';
import { internalQuery, invalid, plain } from './write-support';

/** Target-scope hints only; every actual mutation still authorizes its fields, values and transaction. */
export async function appendRootActionMeta(
  db: Database,
  prepared: AccessAclScopeAdapter,
  queries: AccessQueryService,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ctx: Context,
  actor: Readonly<AccessIdentity>,
  authorize: (collection: Collection, action: string) => Promise<AccessRootReadContext>,
  assertRequestCurrent: () => void,
) {
  const { resourceName, actionName } = ctx.action;
  if (!ctx.get('X-With-ACL-Meta') || !['list', 'get'].includes(actionName) || resourceName.includes('.')) return;
  // The native wrapper has no metadata slot for complete (array) lists or missing details.
  const body = ctx.body;
  if (!body || Array.isArray(body)) return;
  const rows = actionName === 'list' ? body.rows : [body];
  if (!Array.isArray(rows) || !rows.length) return;
  const collection = db.getCollection(resourceName);
  const identity = collection && resolveIdentity(collection);
  if (!identity || typeof actor.roleName !== 'string') invalid('Action metadata identity is unavailable');
  const model = collection.model;
  const primary = model.primaryKeyAttribute;
  const keys = rows.map((row) => row?.[primary]);
  // A field-limited response must not gain hidden identifiers through metadata.
  if (keys.some((key) => key === undefined || key === null)) return;
  const config = prepared.configuration(ctx, identity);
  if (!config) invalid('Action metadata requires a prepared configuration');
  const checks = [
    assertRequestCurrent,
    captureReadPreparationMetadata(db, prepared, resolveIdentity, ctx, collection, []),
  ];
  const current = () => {
    for (const check of checks) check();
    if (
      ctx.body !== body ||
      ctx.state.currentUser?.id !== actor.userId ||
      ctx.state.currentRole !== actor.roleName ||
      ctx.state.currentTenantId !== actor.tenantId
    )
      invalid('Action metadata response or authenticated context changed');
  };
  const allowedActions = { view: [] as unknown[], update: [] as unknown[], destroy: [] as unknown[] };
  for (const action of ['view', 'update', 'destroy'] as const) {
    current();
    const decision = await authorize(collection, action);
    current();
    const permission = captureFinalActionPermission(decision.permission, {
      resourceName,
      actionName: action,
      roleName: actor.roleName,
    });
    if (!permission.allowed) continue;
    if (!plain(permission.params)) invalid('Action metadata permission parameters are unavailable');
    const role = new AccessRoleFilterCompiler(db, resolveIdentity).compileNative(
      identity,
      permission.params.filter ?? {},
    );
    checks.push(role.assertCurrent);
    // Alternate target keys and attachment deletion have dedicated mutation protocols.
    if (action !== 'view' && collection.filterTargetKey !== primary) continue;
    if (action === 'destroy' && collection.options.template === 'file') continue;
    const scoped = await queries.resolveNativeScopes(ctx, identity, actor, { rootAlias: role.rootAlias });
    current();
    if (!scoped || scoped.config !== config) invalid('Action metadata configuration changed');
    const scope = scoped.scopes[action === 'view' ? 'read' : 'ownership'];
    const matches = await model.unscoped().findAll(
      internalQuery({
        where: {
          [Op.and]: [
            { [primary]: { [Op.in]: keys } },
            literal(role.sql),
            literal(scope.sql),
            // Even editable unassigned historical records cannot be deleted before a real edit claims them.
            ...(action === 'destroy' && config.ownership.enabled ? [{ tenantId: { [Op.ne]: null } }] : []),
          ],
        },
        attributes: [primary],
        raw: true,
      }),
    );
    current();
    const matched = new Set(matches.map((row) => String(row[primary])));
    allowedActions[action] = [...new Set(keys)].filter((key) => matched.has(String(key)));
  }
  current();
  if (actionName === 'list') body.allowedActions = allowedActions;
  else ctx.bodyMeta = { ...ctx.bodyMeta, allowedActions };
}
