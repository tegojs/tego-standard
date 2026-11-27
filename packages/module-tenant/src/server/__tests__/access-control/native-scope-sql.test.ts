import type { Database } from '@tego/server';

import { compileAccessScopes } from '../../access-control/compile';
import type { AccessCondition, CompileOptions } from '../../access-control/types';
import { isolatedPostgresDatabase, queryRows, seedDatabase, sqliteDatabase } from './database';
import { configFor, documents, ownerCondition, participantCondition, quoteIdentifier } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('trusted native scope SQL (%s)', (dialect) => {
  let db: Database;
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedDatabase(db);
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query('DROP TABLE access_links, access_participants, access_documents, access_tenants');
    } finally {
      await db.close();
    }
  });

  function plan(condition: AccessCondition, context: CompileOptions['context'] = { 'tenant.id': 'B' }, inline = true) {
    const generator = db.sequelize.getQueryInterface().queryGenerator as unknown as {
      escape(value: unknown): string | number;
    };
    const rootAlias = inline ? '$tac_0' : 'bound_root';
    const ownership = compileAccessScopes(configFor(condition), {
      collection: documents,
      context,
      quoteIdentifier,
      rootAlias,
      // SQLite's installed dialect returns numeric boolean literals; the encoder owns SQL text conversion.
      ...(inline ? { quoteValue: (value) => String(generator.escape(value)) } : {}),
    }).ownership;
    return { ...ownership, rootAlias };
  }
  async function ids(scope: ReturnType<typeof plan>) {
    return (
      await queryRows<{ id: number }>(
        db,
        `SELECT ${quoteIdentifier(scope.rootAlias)}.id FROM access_documents AS ${quoteIdentifier(scope.rootAlias)} WHERE ${scope.sql} ORDER BY id`,
        // An empty bind object still invokes the installed ORM's text-based binding rewriter.
        // Native SQL must bypass that rewriter entirely, including values/identifiers containing $.
        Object.keys(scope.bind).length ? { bind: scope.bind } : {},
      )
    ).map((row) => row.id);
  }

  it('executes literal context values without substituting named tokens in values or identifiers', async () => {
    const value = "B'; DROP TABLE access_documents; -- $tac_0 $$ \\";
    await db.sequelize.query('UPDATE access_documents SET tenant_id=$tenant WHERE id=3', { bind: { tenant: value } });
    const scope = plan(ownerCondition, { 'tenant.id': value });
    expect(await ids(scope)).toEqual([3]);
    expect(scope.bind).toEqual({});
    const bound = plan(ownerCondition, { 'tenant.id': value }, false);
    expect(bound.bind).toEqual({ tac_0: value });
    expect(await ids(bound)).toEqual([3]);
    expect(await queryRows(db, 'SELECT id FROM access_documents ORDER BY id')).toHaveLength(6);
  });

  it('preserves associated boolean authorization facts without publishing bindings', async () => {
    const scope = plan(participantCondition);
    expect(await ids(scope)).toEqual([1]);
    expect(scope.bind).toEqual({});
    await db.sequelize.query('UPDATE access_participants SET can_view=false WHERE document_id=1');
    expect(await ids(scope)).toEqual([]);
  });

  it('preserves hierarchy membership, numeric conditions and NULL behavior', async () => {
    const scope = plan(
      {
        type: 'all',
        children: [
          {
            type: 'tenantRelation',
            tenant: { type: 'field', path: 'tenantId' },
            relation: 'descendant',
            includeSelf: true,
          },
          {
            type: 'compare',
            operator: 'gte',
            left: { type: 'field', path: 'amount' },
            right: { type: 'literal', value: 200 },
          },
        ],
      },
      { 'tenant.id': 'B', 'tenant.ancestorIds': ['H'] },
    );
    expect(await ids(scope)).toEqual([2, 3, 6]);
    expect(scope.bind).toEqual({});
    expect(await ids(plan({ type: 'not', child: ownerCondition }))).toEqual([1, 2, 4, 6]);
  });

  it('escapes LIKE metacharacters with the selected dialect renderer', async () => {
    await db.sequelize.query('UPDATE access_documents SET name=$value WHERE id=1', { bind: { value: 'a_%\\b' } });
    const scope = plan({
      type: 'compare',
      operator: 'includes',
      left: { type: 'field', path: 'name' },
      right: { type: 'literal', value: '_%\\' },
    });
    expect(await ids(scope)).toEqual([1]);
    expect(scope.bind).toEqual({});
  });
});

describe('native scope renderer validation', () => {
  it.each([null, true, 'quote', () => '', () => undefined, () => Promise.resolve("'B'")])(
    'rejects a non-synchronous or empty SQL renderer %#',
    (quoteValue) => {
      expect(() =>
        compileAccessScopes(configFor(ownerCondition), {
          collection: documents,
          context: { 'tenant.id': 'B' },
          quoteIdentifier,
          quoteValue: quoteValue as CompileOptions['quoteValue'],
        }),
      ).toThrow('value renderer');
    },
  );
});
