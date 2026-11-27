import { ACL, Resourcer, Transaction, type Database } from '@tego/server';

import {
  mainIdentity,
  registerConfigModels,
  seedConfigStore,
} from '../../../../../module-tenant/src/server/__tests__/access-control/config-database';
import { isolatedPostgresDatabase } from '../../../../../module-tenant/src/server/__tests__/access-control/database';
import { configFor, ownerCondition } from '../../../../../module-tenant/src/server/__tests__/access-control/fixtures';
import { AccessAclScopeAdapter } from '../../../../../module-tenant/src/server/access-control/acl-scope';
import {
  accessCollectionKey,
  AccessConfigStore,
} from '../../../../../module-tenant/src/server/access-control/config-store';
import { resolveModelMetadata } from '../../../../../module-tenant/src/server/access-control/model-metadata';
import { AccessQueryService } from '../../../../../module-tenant/src/server/access-control/query';
import { AccessRootMutationHandler } from '../../../../../module-tenant/src/server/access-control/root-mutation-handler';
import storageDefinition from '../../collections/storages';
import { AttachmentRemovalNativeCapture } from '../../storages/native-removal-capture';

export const crashFixtureBytes = Buffer.from('New isolated producer crash fixture');

export function crashFixtureDatabase(url: string) {
  const connection = new URL(url);
  if (connection.hostname !== '127.0.0.1' || connection.port !== '25466' || connection.username !== 'tenant_test')
    throw new TypeError('Producer crash fixture requires the dedicated local test endpoint');
  return isolatedPostgresDatabase(url);
}

/** Mapping only: the restarted worker/observer never syncs, seeds or reconstructs journal evidence. */
export function registerCrashMappings(db: Database) {
  db.collection(storageDefinition);
  const source = db.collection({
    name: 'documents',
    schema: 'public',
    template: 'file',
    timestamps: false,
    fields: [
      { name: 'id', type: 'integer', primaryKey: true },
      ...['tenantId', 'path', 'filename'].map((name) => ({ name, type: 'string' })),
      { name: 'size', type: 'integer' },
      { name: 'storage', type: 'belongsTo', target: 'storages', foreignKey: 'storageId' },
    ],
  });
  db.collection({
    name: 'tenants',
    timestamps: false,
    autoGenId: false,
    fields: [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'enabled', type: 'boolean' },
    ],
  });
  const journal = (name: string) =>
    db.collection({
      name,
      schema: 'public',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'payload', type: 'jsonb' },
      ],
    });
  return { source, intents: journal('attachment_removal_intents'), events: journal('attachment_removal_events') };
}

function configStore(db: Database) {
  return new AccessConfigStore(db, (identity) =>
    resolveModelMetadata(db.getCollection(identity.collectionName), {
      resolveCollectionKey: () => accessCollectionKey(mainIdentity),
    }),
  );
}

export async function seedCrashFixture(db: Database, root: string) {
  await seedConfigStore(db);
  const mappings = registerCrashMappings(db);
  await db.sync();
  await db.getCollection('tenants').model.create({ id: 'B', enabled: true });
  await db.getRepository('storages').create({
    values: { id: 18, name: 'private', title: 'Private', type: 'local', options: { documentRoot: root } },
  });
  await mappings.source.model.create({
    id: 1,
    tenantId: 'B',
    path: '',
    filename: 'probe.txt',
    size: crashFixtureBytes.length,
    storageId: 18,
  });
  await configStore(db).save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
  const native = new AttachmentRemovalNativeCapture(mappings.source, mappings.events, 'full-row');
  await db.sequelize.transaction((transaction: Transaction) => native.install(transaction));
  return { ...mappings, native };
}

export async function captureCrashProducer(db: Database) {
  registerConfigModels(db);
  const mappings = registerCrashMappings(db);
  const store = configStore(db);
  const adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
  const identity = () => mainIdentity;
  const mutations = new AccessRootMutationHandler(
    db,
    adapter,
    new AccessQueryService(db, adapter, () => accessCollectionKey(mainIdentity)),
    identity,
  );
  const acl = new ACL();
  acl.setAvailableAction('destroy', {});
  acl.define({ role: 'reader' }).grantAction('documents:destroy', {});
  const resourcer = new Resourcer();
  resourcer.define({ name: 'documents', actions: { destroy: {} } });
  const action = resourcer.getAction('documents', 'destroy').clone();
  Object.assign(action, { resourceName: 'documents', actionName: 'destroy' });
  action.mergeParams({ resourceName: 'documents', actionName: 'destroy', filterByTk: 1 });
  const ctx = {
    db,
    action,
    state: { currentRole: 'reader' },
    get: () => '+08:00',
    logger: { info() {} },
    throw(status: number) {
      throw new Error(String(status));
    },
    permission: undefined as unknown,
  };
  await acl.middleware()(ctx as never, async () => {});
  await adapter.prepare(ctx, [mainIdentity]);
  return {
    ...mappings,
    entry: mutations.captureAttachmentRemoval(ctx, { tenantId: 'B', roleName: 'reader', userId: 28 }),
  };
}
