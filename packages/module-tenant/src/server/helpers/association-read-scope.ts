import { TENANT_ENABLED_MODES } from '../constants';
import { translateTenantError } from '../locale';
import { getCollectionTenancyMode } from './isTenantScopedCollection';
import { applyTenantFilterToContext } from './tenant-filter';

function getAssociationResourceName(association: any, fallbackSourceName?: string, fallbackAssociationName?: string) {
  const sourceName = association?.source?.name || fallbackSourceName;
  const associationName = association?.as || fallbackAssociationName;
  return sourceName && associationName ? `${sourceName}.${associationName}` : undefined;
}

/** Resolve the target collection's own ACL and tenancy boundary for appended associations. */
export async function resolveAssociationReadScope(ctx: any, collection: any, association: any, acl: any) {
  if (association?.as === '_pivot_' && association?.options?.realAs) {
    return;
  }

  // Collection field definitions are schema metadata, not rows in a business association.
  if (
    collection === ctx.tego?.db?.getCollection?.('fields') &&
    (association?.source?.name === 'collections' ||
      ['collections', 'collections.fields'].includes(ctx.action?.resourceName))
  ) {
    return {};
  }

  const action = association?.isSingleAssociation ? 'get' : 'list';
  const rawResourceName = getAssociationResourceName(association);
  const permission = ctx.can?.({
    resource: collection.name,
    action,
    ...(rawResourceName ? { rawResourceName } : {}),
  });
  if (!permission) {
    const primaryKey = collection.model?.primaryKeyAttribute || collection.filterTargetKey || 'id';
    return { filter: { [primaryKey]: { $in: [] } }, fields: [], appends: [] };
  }

  const aclParams = acl.filterParams(ctx, collection.name, permission.params || {});
  const params = await acl.parseJsonTemplate(aclParams, ctx);
  const tenantOptions = applyTenantFilterToContext(ctx, collection, 'list', { filter: params?.filter });
  return {
    filter: tenantOptions.filter,
    fields: params?.fields,
    appends: params?.appends,
  };
}

/** Older database cores ignore the read-scope callback; reject only paths needing target protection. */
export function guardUnsupportedAssociationReadScopes(ctx: any, db: any, collection: any, repository: any) {
  if (repository?.supportsAssociationReadScope === true || !collection?.model?.associations) return;

  const paths = new Set<string>();
  const params = ctx.action?.params || {};
  for (const key of ['appends', 'fields', 'sort']) {
    const values = Array.isArray(params[key]) ? params[key] : params[key] == null ? [] : [params[key]];
    for (const item of values) {
      if (typeof item === 'string') paths.add(item.replace(/^-/, '').split('(')[0]);
    }
  }
  const visitFilter = (value: any, prefix = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (key.startsWith('$') && key.endsWith('$') && key.length > 2) {
        paths.add(key.slice(1, -1));
      } else if (!key.startsWith('$')) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.add(path);
        visitFilter(nested, path);
      } else {
        visitFilter(nested, prefix);
      }
    }
  };
  visitFilter(params.filter);

  for (const path of paths) {
    let source = collection;
    const segments = path.split('.');
    for (const [index, segment] of segments.entries()) {
      const association = source.model?.associations?.[segment];
      if (!association) break;
      const target = db.modelCollection?.get?.(association.target) || db.getCollection(association.target?.name);
      if (!target) break;
      const action = association.isSingleAssociation ? 'get' : 'list';
      const rawResourceName = getAssociationResourceName(association, source.name, segment);
      const permission = ctx.can?.({
        resource: target.name,
        action,
        ...(rawResourceName ? { rawResourceName } : {}),
      });
      const filter = permission?.params?.filter;
      const allowedAppends = permission?.params?.appends;
      const remainingPath = segments.slice(index + 1).join('.');
      const restrictedByAcl =
        !permission ||
        (filter != null && Reflect.ownKeys(filter).length > 0) ||
        Array.isArray(permission.params?.fields) ||
        (remainingPath &&
          Array.isArray(allowedAppends) &&
          !allowedAppends.some(
            (allowed: string) => remainingPath === allowed || remainingPath.startsWith(`${allowed}.`),
          ));
      if (TENANT_ENABLED_MODES.includes(getCollectionTenancyMode(target) as any) || restrictedByAcl) {
        ctx.throw(403, translateTenantError(ctx, 'associationReadScopeUnsupported'));
      }
      source = target;
    }
  }
}
