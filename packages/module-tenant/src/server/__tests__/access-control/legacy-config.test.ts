import type { Database } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import { draftLegacyAccessConfig } from '../../access-control/legacy-config';
import type { AccessConfig, CompileOptions } from '../../access-control/types';
import { applyTenantFilterToContext } from '../../helpers/tenant-filter';
import { isolatedPostgresDatabase, queryRows, seedDatabase, sqliteDatabase } from './database';
import { documents, quoteIdentifier } from './fixtures';

const settings = (
  tenancy = 'tenantScoped',
  legacyDataTenantIds: Array<string | number> = [],
  allowEditingLegacyData = false,
) => ({
  tenancy,
  legacyDataTenantIds,
  allowEditingLegacyData,
});

describe('legacy access configuration drafts', () => {
  it('creates independent unsaved configurations without changing the input', () => {
    const input = settings('tenantScoped', ['B']);
    const before = structuredClone(input);
    const first = draftLegacyAccessConfig(input, documents);
    const second = draftLegacyAccessConfig(input, documents);
    expect(first).toEqual(second);
    expect(first.revision).toBe(0);
    expect(first.schemaVersion).toBe(1);
    expect(first.ownership.enabled).toBe(true);
    first.rules[0].enabled = false;
    first.rules.pop();
    input.legacyDataTenantIds.push('C');
    expect(second).toEqual(draftLegacyAccessConfig(before, documents));
  });

  it('normalizes and deduplicates numeric and string tenant IDs without granting unrelated tenants', () => {
    expect(draftLegacyAccessConfig(settings('tenantScoped', [1, '1', 'B']), documents)).toEqual(
      draftLegacyAccessConfig(settings('tenantScoped', ['1', 'B']), documents),
    );
  });

  it('allows shared collections without tenant fields or tenant context', () => {
    const metadata = { ...documents, fields: { id: documents.fields.id } };
    const draft = draftLegacyAccessConfig(settings('shared', ['B'], true), metadata);
    expect(draft.ownership.enabled).toBe(false);
    expect(draft.rules).toHaveLength(1);
    const plan = compileAccessScopes(draft, { collection: metadata, context: {}, quoteIdentifier });
    expect(plan.read.sql).toBe('TRUE');
    expect(plan.ownership.sql).toBe('TRUE');
    expect(plan.read.bind).toEqual({});
  });

  it.each(['tenantScoped', 'tenantInherited'])('requires the ownership field for %s', (mode) => {
    expect(() =>
      draftLegacyAccessConfig(settings(mode), { ...documents, fields: { id: documents.fields.id } }),
    ).toThrow();
  });

  it.each([
    undefined,
    null,
    {},
    [],
    settings('unknown'),
    settings(''),
    { tenancy: 'shared' },
    { ...settings(), extra: true },
    { ...settings(), [Symbol('extra')]: true },
    { ...settings(), allowEditingLegacyData: 'false' },
    { ...settings(), allowEditingLegacyData: null },
    { ...settings(), legacyDataTenantIds: null },
    { ...settings(), legacyDataTenantIds: 'B' },
    { ...settings(), legacyDataTenantIds: [null] },
    { ...settings(), legacyDataTenantIds: [true] },
    { ...settings(), legacyDataTenantIds: [''] },
    { ...settings(), legacyDataTenantIds: [{}] },
    { ...settings(), legacyDataTenantIds: [NaN] },
    { ...settings(), legacyDataTenantIds: [1.5] },
    { ...settings(), legacyDataTenantIds: [Number.MAX_SAFE_INTEGER + 1] },
    { ...settings(), legacyDataTenantIds: ['B'.repeat(10001)] },
    { ...settings(), legacyDataTenantIds: Array(1) },
    { ...settings(), legacyDataTenantIds: Array(1001).fill('B') },
    Object.create(settings()),
  ])('rejects incomplete or malformed effective settings (%#)', (input) => {
    expect(() => draftLegacyAccessConfig(input, documents)).toThrow(
      expect.objectContaining({ code: 'INVALID_ACCESS_RULE' }),
    );
  });

  it('rejects accessors without executing them', () => {
    const getter = vi.fn(() => 'shared');
    const input = Object.defineProperty(settings(), 'tenancy', { get: getter });
    expect(() => draftLegacyAccessConfig(input, documents)).toThrow();
    const list = Object.defineProperty(['B'], '0', { get: getter });
    expect(() => draftLegacyAccessConfig({ ...settings(), legacyDataTenantIds: list }, documents)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('legacy draft query equivalence (%s)', (dialect) => {
  let db: Database;
  beforeAll(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    await seedDatabase(db);
    db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'amount', type: 'integer' },
        { name: 'name', type: 'string' },
      ],
    });
  });
  afterAll(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS access_links, access_participants, access_documents, access_tenants',
        );
    } finally {
      await db?.close();
    }
  });

  async function ids(draft: AccessConfig, tenant: string, scope: 'read' | 'ownership' | 'visibility') {
    const context: CompileOptions['context'] = {
      'tenant.id': tenant,
      'tenant.descendantIds': tenant === 'H' ? ['B', 'C'] : [],
      'tenant.ancestorIds': ['B', 'C'].includes(tenant) ? ['H'] : [],
    };
    const plan = compileAccessScopes(draft, { collection: documents, context, quoteIdentifier });
    const rows = await queryRows<{ id: number }>(
      db,
      `SELECT tac_root.id FROM access_documents AS tac_root WHERE ${plan[scope].sql} ORDER BY id`,
      { bind: plan[scope].bind },
    );
    return rows.map((row) => row.id);
  }

  for (const mode of ['shared', 'tenantScoped', 'tenantInherited']) {
    for (const tenant of ['H', 'B', 'C', 'unrelated']) {
      for (const legacy of [false, true]) {
        it(`${mode}, tenant ${tenant}, legacy visibility ${legacy}: preserves reads and eligible edits`, async () => {
          const input = settings(mode, legacy ? ['B'] : []);
          const draft = draftLegacyAccessConfig(input, documents);
          const context = {
            state: { currentTenantId: tenant, currentTenantDescendantIds: tenant === 'H' ? ['B', 'C'] : [] },
          };
          const collection = { options: input };
          const oldIds = async (action: string) => {
            const options = applyTenantFilterToContext(context, collection, action, { sort: ['id'], fields: ['id'] });
            const rows = await db.getRepository('documents').find(options);
            return rows.map((row) => row.get('id'));
          };
          expect(await ids(draft, tenant, 'read')).toEqual(await oldIds('list'));
          expect(await ids(draft, tenant, 'ownership')).toEqual(await oldIds('update'));
          const editable = draftLegacyAccessConfig({ ...input, allowEditingLegacyData: true }, documents);
          expect(await ids(editable, tenant, 'read')).toEqual(await oldIds('list'));
          expect(await ids(editable, tenant, 'ownership')).toEqual(await oldIds('list'));
        });
      }
    }
  }

  it('keeps the parent direction and historical read/write distinction explicit', async () => {
    const inherited = draftLegacyAccessConfig(settings('tenantInherited', ['B']), documents);
    expect(await ids(inherited, 'H', 'read')).toEqual([1, 2, 3, 4, 6]);
    expect(await ids(inherited, 'B', 'read')).toEqual([3, 5]);
    expect(await ids(inherited, 'B', 'ownership')).toEqual([3]);
    expect(await ids(inherited, 'C', 'read')).toEqual([4]);
    expect(await ids(inherited, 'unrelated', 'read')).toEqual([]);
    expect(await ids(inherited, 'B', 'visibility')).toEqual([5]);
    const editable = draftLegacyAccessConfig(settings('tenantInherited', ['B'], true), documents);
    expect(await ids(editable, 'B', 'ownership')).toEqual([3, 5]);
    expect(await ids(editable, 'H', 'ownership')).toEqual([1, 2, 3, 4, 6]);
  });

  it.each(['tenantScoped', 'tenantInherited'])('fails closed without required tenant context (%s)', (mode) => {
    const draft = draftLegacyAccessConfig(settings(mode), documents);
    expect(() => compileAccessScopes(draft, { collection: documents, context: {}, quoteIdentifier })).toThrow(
      expect.objectContaining({ code: 'MISSING_ACCESS_CONTEXT' }),
    );
  });
});
