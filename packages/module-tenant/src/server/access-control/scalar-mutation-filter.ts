import { Op, type Collection, type Database, type WhereOptions } from '@tego/server';

import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import { accessMetadataGuard } from './metadata-snapshot';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessRequestFilterParser } from './request-filter';
import type { AccessRoleFilterCompiler } from './role-filter';
import { rootFilterWhere } from './root-filter-predicate';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import type { AccessConfig } from './types';
import { invalid, plain } from './write-support';

/** Request conditions need their own read grant; write grants never authorize filter fields. */
export function prepareScalarMutationFilter(
  db: Database,
  collection: Collection,
  identity: AccessCollectionIdentity,
  config: AccessConfig,
  request: unknown,
  roleName: string,
  compiler: AccessRoleFilterCompiler,
  resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
) {
  if (!plain(request)) invalid('Mutation request filters must be plain objects');
  if (!Reflect.ownKeys(request).length) return;
  const model = collection.model;
  const parse = (readable: readonly string[]) =>
    new AccessRequestFilterParser(db, (target, path) => {
      if (target !== collection || path.length)
        invalid('Relational mutation request filters require their own adapter');
      return { identity, fields: readable };
    }).parse(identity, request);
  // Parse before any asynchronous callback, without treating request strings as ACL templates.
  const requested = rootFilterWhere(
    parse(
      Object.keys(model.rawAttributes).filter(
        (name) => (model.rawAttributes[name].type as { key?: string }).key !== 'VIRTUAL',
      ),
    ).filter,
    model.primaryKeyAttribute,
  );
  if (requested === undefined) invalid('Mutation request filter must use root fields');
  const metadataCurrent = accessMetadataGuard(db, [{ model, config }]);
  let readPlan: ReturnType<AccessReadGrantAdapter['capturePlan']>;
  return {
    assertCurrent() {
      metadataCurrent();
      readPlan?.assertCurrent();
    },
    async resolve(
      authorizeRead: ((collection: Collection) => Promise<AccessRootReadContext | null>) | undefined,
      assertCurrent: () => void,
    ): Promise<WhereOptions> {
      if (!authorizeRead) invalid('Filtered mutations require an independent read decision');
      const related = await authorizeRead(collection);
      assertCurrent();
      if (!related) invalid('Mutation filter read is not authorized');
      const decision = captureRelatedReadPermission(db, collection, roleName, related);
      readPlan = new AccessReadGrantAdapter(db, (target) => {
        const current = resolveIdentity(target);
        return current && accessCollectionKey(current);
      }).capturePlan(identity, decision, compiler);
      if (!readPlan) invalid('Mutation filter read is not authorized');
      parse(readPlan.grant.fields);
      assertCurrent();
      return { [Op.and]: [requested, readPlan.rootWhere ?? readPlan.grant.where!] };
    },
  };
}
