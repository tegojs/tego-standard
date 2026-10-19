import { ACL, Resourcer, type Database } from '@tego/server';

/** Real action/ACL fixtures; the caller separately prepares the business request's G/V phase. */
export async function finalizedReadContext(
  db: Database,
  resourceName: string,
  actionName: string,
  params: Record<string, unknown> = {},
  permission: object = {},
  sourceKey?: string | number,
) {
  const acl = new ACL();
  acl.setAvailableAction('view', { aliases: ['get', 'list'] });
  acl.setAvailableAction('count', {});
  const [source, relation] = resourceName.split('.');
  const collection = relation
    ? db.getCollection(db.getCollection(source).getField(relation).target)
    : db.getCollection(source);
  acl.define({ role: 'reader' }).grantAction(`${collection.name}:${actionName}`, permission);
  const resourcer = new Resourcer();
  resourcer.define({ name: resourceName, actions: { [actionName]: {} } });
  const action = resourcer.getAction(resourceName, actionName).clone();
  const sourceId = sourceKey === undefined ? undefined : String(sourceKey);
  Object.assign(action, { resourceName, actionName, sourceId, resourceOf: sourceId });
  action.params.filterByTk = undefined;
  action.mergeParams({
    resourceName: relation ?? source,
    actionName,
    ...(relation ? { associatedName: source, associatedIndex: sourceId } : {}),
    ...params,
  });
  const result = {
    db,
    action,
    state: { currentRole: 'reader' },
    getCurrentRepository: () => ({ targetCollection: collection }),
    get: () => '+08:00',
    logger: { info: vi.fn() },
    throw: (status: number) => {
      throw new Error(String(status));
    },
    permission: undefined as unknown,
    body: 'unchanged' as unknown,
    paginate: false,
  };
  await acl.middleware()(result as never, async () => {});
  return result;
}
