import { type Database } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import { resolveAccessContext } from '../../access-control/context';
import { sqliteDatabase } from './database';
import { configFor, documents, ownerCondition, quoteIdentifier } from './fixtures';

describe('access rule trusted context', () => {
  let db: Database;
  const hierarchy = configFor({
    type: 'tenantRelation',
    tenant: { type: 'field', path: 'tenantId' },
    relation: 'ancestor',
    includeSelf: true,
  });

  beforeEach(async () => {
    db = sqliteDatabase();
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getRepository('tenants').create({
      values: [
        { id: 'H', parentId: null, enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
        { id: 'D', parentId: 'B', enabled: true },
        { id: 'off', parentId: 'B', enabled: false },
        { id: 'E', parentId: 'off', enabled: true },
        { id: 'other', parentId: null, enabled: true },
      ],
    });
  });
  afterEach(async () => {
    await db.close();
  });

  it('resolves only variables required by enabled rules', async () => {
    const context = await resolveAccessContext(db, configFor(ownerCondition), {
      tenantId: 'B',
      userId: 28,
      roleName: 'admin',
    });
    expect(context).toEqual({ 'tenant.id': 'B' });
  });

  it('does not require a tenant or query tenants for an explicit shared rule', async () => {
    db.removeCollection('tenants');
    expect(await resolveAccessContext(db, configFor({ type: 'constant', value: true }), {})).toEqual({});
  });

  it.each(['missing', 'off'])('rejects unavailable active tenant %s', async (tenantId) => {
    await expect(resolveAccessContext(db, configFor(ownerCondition), { tenantId })).rejects.toThrow(/tenant/i);
  });

  it('does not resolve disabled rule variables', async () => {
    const config = configFor(ownerCondition);
    config.rules[0].enabled = false;
    expect(await resolveAccessContext(db, config, {})).toEqual({});
  });

  it('builds descendants from actual parent links and excludes disabled records', async () => {
    const context = await resolveAccessContext(db, hierarchy, { tenantId: 'B' });
    expect(context['tenant.descendantIds']).toEqual(['D', 'E']);
    expect(context['tenant.id']).toBe('B');
  });

  it('builds ancestors separately from descendants', async () => {
    const config = configFor({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'descendant',
      includeSelf: false,
    });
    const context = await resolveAccessContext(db, config, { tenantId: 'D' });
    expect(context['tenant.ancestorIds']).toEqual(['B', 'H']);
    expect(context['tenant.descendantIds']).toBeUndefined();
  });

  it('returns a verified empty descendant list for a leaf tenant', async () => {
    const context = await resolveAccessContext(db, hierarchy, { tenantId: 'D' });
    expect(context['tenant.descendantIds']).toEqual([]);
    expect(() => compileAccessScopes(hierarchy, { collection: documents, context, quoteIdentifier })).not.toThrow();
  });

  it('reads uncommitted hierarchy facts inside the supplied transaction', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await db.getCollection('tenants').model.update({ parentId: 'other' }, { where: { id: 'D' }, transaction });
      expect(
        (await resolveAccessContext(db, hierarchy, { tenantId: 'B' }, { transaction }))['tenant.descendantIds'],
      ).toEqual(['E']);
      await transaction.rollback();
      expect((await resolveAccessContext(db, hierarchy, { tenantId: 'B' }))['tenant.descendantIds']).toEqual([
        'D',
        'E',
      ]);
    } finally {
      if (!transaction.finished) await transaction.rollback();
    }
  });

  it('does not reuse a previous hierarchy result', async () => {
    await resolveAccessContext(db, hierarchy, { tenantId: 'B' });
    await db.getCollection('tenants').model.update({ parentId: 'other' }, { where: { id: 'D' } });
    expect((await resolveAccessContext(db, hierarchy, { tenantId: 'B' }))['tenant.descendantIds']).toEqual(['E']);
  });

  it('rejects cyclic hierarchy instead of granting a partial range', async () => {
    await db.getCollection('tenants').model.update({ parentId: 'D' }, { where: { id: 'B' } });
    await expect(resolveAccessContext(db, hierarchy, { tenantId: 'B' })).rejects.toThrow(/hierarchy/i);
  });

  it('rejects missing parent records on the required ancestor path', async () => {
    const config = configFor({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'descendant',
      includeSelf: true,
    });
    await db.getCollection('tenants').model.update({ parentId: 'absent' }, { where: { id: 'B' } });
    await expect(resolveAccessContext(db, config, { tenantId: 'D' })).rejects.toThrow(/hierarchy/i);
  });

  it('uses server user and role identities in subject conditions', async () => {
    const config = configFor({ type: 'constant', value: true });
    config.rules[0].subject = {
      type: 'all',
      children: [
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'user.id' },
          right: { type: 'literal', value: '28' },
        },
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'role.name' },
          right: { type: 'literal', value: 'stock_manager' },
        },
      ],
    };
    const context = await resolveAccessContext(db, config, { userId: 28, roleName: 'stock_manager' });
    expect(context).toEqual({ 'user.id': '28', 'role.name': 'stock_manager' });
    await expect(resolveAccessContext(db, config, { roleName: 'stock_manager' })).rejects.toThrow(/context/i);
  });

  it('rejects a finished or foreign authorization transaction', async () => {
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(resolveAccessContext(db, hierarchy, { tenantId: 'H' }, { transaction })).rejects.toThrow(
      /transaction/i,
    );
    const foreign = sqliteDatabase();
    const foreignTransaction = await foreign.sequelize.transaction();
    try {
      await expect(
        resolveAccessContext(db, hierarchy, { tenantId: 'H' }, { transaction: foreignTransaction }),
      ).rejects.toThrow(/transaction/i);
    } finally {
      await foreignTransaction.rollback();
      await foreign.close();
    }
  });

  it('rejects an oversized effective hierarchy without truncating authorization', async () => {
    await db
      .getCollection('tenants')
      .model.bulkCreate(Array.from({ length: 1001 }, (_, id) => ({ id: `child-${id}`, parentId: 'H', enabled: true })));
    await expect(resolveAccessContext(db, hierarchy, { tenantId: 'H' })).rejects.toThrow(/context|hierarchy/i);
  });

  it('does not grant disabled ancestor IDs but can traverse them to enabled parents', async () => {
    const config = configFor({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'descendant',
      includeSelf: true,
    });
    const context = await resolveAccessContext(db, config, { tenantId: 'E' });
    expect(context['tenant.ancestorIds']).toEqual(['B', 'H']);
  });
});
