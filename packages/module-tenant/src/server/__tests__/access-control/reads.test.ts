import { ACL, DataTypes, Field, FilterParser, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessReadGrantAdapter, type AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessReadService } from '../../access-control/reads';
import type { AccessFilterReadGrant } from '../../access-control/request-filter';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const projectIdentity = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const identities = [mainIdentity, projectIdentity];
class CalendarDateField extends Field {
  get dataType() {
    return DataTypes.DATEONLY;
  }
}

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('unified root reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessReadService;
  let grants: Map<string, AccessFilterReadGrant | null>;
  let resolver: ReturnType<typeof vi.fn>;
  let entryReads: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let entryResolver: ReturnType<typeof vi.fn>;
  let ctx: object;
  const auth = { tenantId: 'B' };
  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    db.registerFieldTypes({ calendarDate: CalendarDateField });
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const identity of identities) {
      const collection = db.collection({
        name: identity.collectionName,
        tableName: `read_${identity.collectionName}`,
        timestamps: true,
        paranoid: true,
        defaultScope: { where: { enabled: true } },
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string', field: 'display_name' },
          { name: 'amount', type: 'integer' },
          { name: 'enabled', type: 'boolean', defaultValue: true },
          { name: 'projectId', type: 'integer', field: 'project_id' },
          { name: 'deletedAt', type: 'date' },
          { name: 'labels', type: 'json' },
          { name: 'occurredAt', type: 'date', field: 'occurred_at' },
          { name: 'calendarDate', type: 'calendarDate', field: 'calendar_date' },
        ],
      });
      await collection.model.sync();
      if (identity !== mainIdentity)
        await db
          .getRepository('collections')
          .create({ values: { key: identity.collectionKey, name: collection.name } });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', name: 'Owned', amount: 10, projectId: 101 },
      { id: 2, tenantId: 'H', name: 'Visible', amount: 20, projectId: 102 },
      { id: 3, tenantId: 'C', name: 'Hidden', amount: 30, projectId: 101 },
      { id: 4, tenantId: null, name: 'Legacy', amount: 40, projectId: 103 },
      { id: 5, tenantId: 'B', name: 'Empty', amount: 50 },
      { id: 6, tenantId: 'B', name: 'Disabled', amount: 60, enabled: false },
      { id: 7, tenantId: 'B', name: 'Deleted', amount: 70, deletedAt: new Date() },
    ]);
    await projects.model.bulkCreate([
      { id: 101, tenantId: 'B', name: 'Zebra' },
      { id: 102, tenantId: 'C', name: 'Secret' },
      { id: 103, tenantId: 'B', name: 'Alpha' },
    ]);
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'in',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: ['Visible', 'Legacy'] },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    for (const identity of identities) await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    ctx = {};
    await adapter.prepare(ctx, identities);
    queries = new AccessQueryService(db, adapter, key);
    grants = new Map();
    resolver = vi.fn((collection: Collection, path: readonly string[]) =>
      grants.has(path.join('.'))
        ? grants.get(path.join('.'))
        : {
            identity: identities.find((i) => i.collectionName === collection.name)!,
            fields: [...Object.keys(collection.model.rawAttributes), ...Object.keys(collection.model.associations)],
          },
    );
    reads = new AccessReadService(db, adapter, queries, resolver);
    permissions = new Map();
    entryResolver = vi.fn((_collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      entryResolver,
    );
  });
  describe('absolute date filtering', () => {
    beforeEach(async () => {
      for (const [id, date] of [
        [1, '2026-09-15T16:00:00.000Z'],
        [2, '2026-09-16T15:59:59.999Z'],
        [3, '2026-09-16T00:00:00.000Z'],
        [4, '2026-09-15T15:59:59.999Z'],
        [5, '2026-09-16T16:00:00.000Z'],
        [6, '2026-09-16T00:00:00.000Z'],
        [7, '2026-09-16T00:00:00.000Z'],
      ] as const)
        await docs.model.update({ occurredAt: new Date(date) }, { where: { id }, paranoid: false });
    });
    it('selects the local calendar day within role and tenant scopes', async () => {
      expect(
        await entryReads.listFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } },
        }),
      ).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
    });
    it('resolves page date shortcuts from a trusted fixed clock', async () => {
      expect(
        await entryReads.listFromParams(
          ctx,
          mainIdentity,
          auth,
          {
            fields: ['name'],
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
          },
          undefined,
          { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' },
        ),
      ).toEqual([{ name: 'Owned' }, { name: 'Visible' }]);
    });
    describe('page date context', () => {
      const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
      const filter = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
      it('summary params share list dates, role conditions and tenant scopes', async () => {
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(2);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(30);
        permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(1);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(20);
      });
      it('summary params preserve field GMT metadata and absolute date behavior without context', async () => {
        docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter }, undefined, dates)).toBe(2);
        expect(
          await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter }, undefined, dates),
        ).toBe(70);
        const absolute = { occurredAt: { $dateOn: '2026-09-16+08:00' } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: absolute })).toBe(2);
        expect(await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: absolute })).toBe(30);
      });
      it('summary params independently constrain linked date targets and their role filters', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        const linked = { 'project.occurredAt': { $dateOn: '{{$date.today}}' } };
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates)).toBe(1);
        expect(
          await entryReads.sumFromParams(
            ctx,
            mainIdentity,
            auth,
            { field: 'amount', filter: linked },
            undefined,
            dates,
          ),
        ).toBe(10);
        permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
        expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates)).toBe(0);
        expect(
          await entryReads.sumFromParams(
            ctx,
            mainIdentity,
            auth,
            { field: 'amount', filter: linked },
            undefined,
            dates,
          ),
        ).toBeNull();
        permissions.set('project', null);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(
          entryReads.countFromParams(ctx, mainIdentity, auth, { filter: linked }, undefined, dates),
        ).rejects.toThrow(/authorized/);
        await expect(
          entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: linked }, undefined, dates),
        ).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it.each(['count', 'sum'] as const)(
        'summary params capture %s filter and dates before asynchronous scope queries',
        async (kind) => {
          const context = { ...dates };
          const params = {
            filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } },
            ...(kind === 'sum' ? { field: 'amount' } : {}),
          };
          const original = queries.scopeQuery.bind(queries);
          vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
            context.now = '2027-01-01T00:00:00.000Z';
            context.timezone = '-05:00';
            params.filter.occurredAt.$dateOn = '2027-01-01';
            if (kind === 'sum') params.field = 'id';
            return original(...args);
          });
          expect(
            await entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](
              ctx,
              mainIdentity,
              auth,
              params,
              undefined,
              context,
            ),
          ).toBe(kind === 'sum' ? 30 : 2);
        },
      );
      it.each(['count', 'sum'] as const)(
        'summary params reject malformed and unauthorized %s requests before SQL',
        async (kind) => {
          const getter = vi.fn(() => ({ $dateOn: '{{$nDate.today}}' }));
          const execute = (params: object, context: typeof dates | undefined = dates) =>
            entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](
              ctx,
              mainIdentity,
              auth,
              { ...(kind === 'sum' ? { field: 'amount' } : {}), ...params },
              undefined,
              context,
            );
          const query = vi.spyOn(db.sequelize, 'query');
          for (const params of [
            { filter, now: dates.now },
            { filter, timezone: dates.timezone },
            { filter, pageSize: 1 },
            { filter: { occurredAt: { $dateOn: '{{$nDate.unknown}}' } } },
            { filter: { occurredAt: { $dateOn: '2026-02-30' } } },
            { filter: { name: { $dateOn: '{{$nDate.today}}' } } },
            {
              filter: Object.defineProperty({}, 'occurredAt', { get: getter }),
            },
          ])
            await expect(execute(params)).rejects.toThrow();
          await expect(execute({ filter }, { ...dates, now: 'invalidZ' })).rejects.toThrow();
          await expect(
            entryReads[kind === 'sum' ? 'sumFromParams' : 'countFromParams'](ctx, mainIdentity, auth, {
              filter,
              ...(kind === 'sum' ? { field: 'amount' } : {}),
            }),
          ).rejects.toThrow(/unresolved/);
          permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
          await expect(execute({ filter })).rejects.toThrow(/authorized/);
          expect(getter).not.toHaveBeenCalled();
          expect(query).not.toHaveBeenCalled();
        },
      );
      const page = (params: object, context = dates) =>
        entryReads.listPageFromParams(
          ctx,
          mainIdentity,
          auth,
          { fields: ['id'], sort: ['id'], ...params },
          undefined,
          context,
        );
      it('shares resolved dates across page rows, counts and detail within role and tenant scopes', async () => {
        permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
        expect(await page({ filter, pageSize: 1 })).toEqual({
          rows: [{ id: 2 }],
          count: 1,
          page: 1,
          pageSize: 1,
          totalPage: 1,
        });
        expect(await page({ filter, pageSize: 1, page: 2 })).toEqual({
          rows: [],
          count: 1,
          page: 2,
          pageSize: 1,
          totalPage: 1,
        });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { filterByTk: 2, fields: ['id'], filter },
            undefined,
            dates,
          ),
        ).toEqual({ id: 2 });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { filterByTk: 1, fields: ['id'], filter },
            undefined,
            dates,
          ),
        ).toBeNull();
      });
      it('keeps linked date targets independently scoped and authorized', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        const linked = { project: { occurredAt: { $dateOn: '{{$date.today}}' } } };
        expect((await page({ filter: linked })).rows).toEqual([{ id: 1 }]);
        permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
        expect(await page({ filter: linked })).toMatchObject({ rows: [], count: 0 });
        permissions.set('project', null);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(page({ filter: linked })).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it('resolves logical groups, dotted fields and calendar ranges without merging conditions away', async () => {
        expect((await page({ filter: { $and: [filter, { $not: { amount: { $lt: 15 } } }] } })).rows).toEqual([
          { id: 2 },
        ]);
        expect(
          (await page({ filter: { $or: [filter, { occurredAt: { $dateOn: '{{$nDate.tomorrow}}' } }] } })).rows,
        ).toEqual([{ id: 1 }, { id: 2 }, { id: 5 }]);
        expect(
          (await page({ filter: { occurredAt: { $dateBetween: '{{$nDate.today}}', $dateBefore: '{{$nDate.now}}' } } }))
            .rows,
        ).toEqual([{ id: 1 }]);
      });
      it('honors actual GMT field metadata and explicit operand offsets', async () => {
        docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect((await page({ filter })).rows).toEqual([{ id: 2 }, { id: 5 }]);
        expect((await page({ filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } } })).rows).toEqual([
          { id: 1 },
          { id: 2 },
        ]);
        await projects.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: 101 } });
        projects.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
        expect((await page({ filter: { 'project.occurredAt': { $dateOn: '{{$nDate.today}}' } } })).rows).toEqual([]);
      });
      it('uses the supplied clock across a local day boundary and for instant comparisons', async () => {
        const beforeDay = { now: '2026-09-15T15:59:59.999Z', timezone: '+08:00' };
        expect((await page({ filter }, beforeDay)).rows).toEqual([{ id: 4 }]);
        expect((await page({ filter: { occurredAt: { $dateOn: '{{$nDate.now}}' } } }, beforeDay)).rows).toEqual([
          { id: 4 },
        ]);
      });
      it('captures the date context and filter before asynchronous queries', async () => {
        const context = { ...dates };
        const input = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
        const original = queries.scopeQuery.bind(queries);
        vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
          context.now = '2027-01-01T00:00:00.000Z';
          context.timezone = '-05:00';
          input.occurredAt.$dateOn = '2027-01-01';
          return original(...args);
        });
        expect(await page({ filter: input }, context)).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], count: 2 });
      });
      it('rejects date overrides in action params and malformed or unauthorized dates before SQL', async () => {
        const query = vi.spyOn(db.sequelize, 'query');
        for (const params of [
          { filter, now: dates.now },
          { filter, timezone: dates.timezone },
          { filter, dates },
          { filter: { occurredAt: { $dateOn: '{{$nDate.unknown}}' } } },
          { filter: { name: { $dateOn: '{{$nDate.today}}' } } },
        ])
          await expect(page(params)).rejects.toThrow();
        await expect(page({ filter }, { ...dates, now: 'invalidZ' })).rejects.toThrow();
        permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
        await expect(page({ filter })).rejects.toThrow(/authorized/);
        expect(query).not.toHaveBeenCalled();
      });
      it('applies explicit entry timezone to implicit arrays while preserving calls without context', async () => {
        const range = { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)'] } };
        expect((await page({ filter: range })).rows).toEqual([{ id: 1 }, { id: 2 }]);
        expect(
          await entryReads.listFromParams(ctx, mainIdentity, auth, { fields: ['id'], sort: ['id'], filter: range }),
        ).toEqual([{ id: 2 }, { id: 5 }]);
        const query = vi.spyOn(db.sequelize, 'query');
        await expect(entryReads.listFromParams(ctx, mainIdentity, auth, { filter })).rejects.toThrow(/unresolved/);
        expect(query).not.toHaveBeenCalled();
      });
    });
    describe('calendar period dates', () => {
      const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
      const page = (filter: unknown, context = dates) =>
        entryReads.listPageFromParams(
          ctx,
          mainIdentity,
          auth,
          { fields: ['id'], sort: ['id'], filter },
          undefined,
          context,
        );
      it('distinguishes Sunday and Monday week starts in real pages and details', async () => {
        await docs.model.update({ occurredAt: new Date('2026-09-13T04:00:00Z') }, { where: { id: 1 } });
        await docs.model.update({ occurredAt: new Date('2026-09-20T04:00:00Z') }, { where: { id: 2 } });
        const ordinary = { occurredAt: { $dateOn: '{{$nDate.thisWeek}}' } };
        const iso = { occurredAt: { $dateOn: '{{$nDate.thisIsoWeek}}' } };
        expect(await page(ordinary)).toMatchObject({ rows: [{ id: 1 }, { id: 4 }, { id: 5 }], count: 3 });
        expect(await page(iso)).toMatchObject({ rows: [{ id: 2 }, { id: 4 }, { id: 5 }], count: 3 });
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { fields: ['id'], filterByTk: 1, filter: iso },
            undefined,
            dates,
          ),
        ).toBeNull();
        expect(
          await entryReads.getFromParams(
            ctx,
            mainIdentity,
            auth,
            { fields: ['id'], filterByTk: 1, filter: ordinary },
            undefined,
            dates,
          ),
        ).toEqual({ id: 1 });
        permissions.set('', { allowed: true, params: { filter: { amount: { $lt: 40 } } } });
        expect(await page(iso)).toMatchObject({ rows: [{ id: 2 }], count: 1 });
      });
      describe('quarter boundaries', () => {
        beforeEach(async () => {
          for (const [id, instant] of [
            [1, '2026-06-30T16:00:00.000Z'],
            [2, '2026-09-30T15:59:59.999Z'],
            [4, '2026-06-30T15:59:59.999Z'],
            [5, '2026-09-30T16:00:00.000Z'],
          ] as const)
            await docs.model.update({ occurredAt: new Date(instant) }, { where: { id } });
        });
        it('preserves full quarter boundaries for calendar operators and field GMT', async () => {
          for (const [operator, ids] of [
            ['$dateOn', [1, 2]],
            ['$dateNotOn', [4, 5]],
            ['$dateBefore', [4]],
            ['$dateNotBefore', [1, 2, 5]],
            ['$dateAfter', [5]],
            ['$dateNotAfter', [1, 2, 4]],
            ['$dateBetween', [1, 2]],
          ] as const)
            expect(await page({ occurredAt: { [operator]: '{{$date.thisQuarter}}' } })).toMatchObject({
              rows: ids.map((id) => ({ id })),
              count: ids.length,
            });
          docs.getField('occurredAt').options.uiSchema = { 'x-component-props': { gmt: true } };
          expect((await page({ occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } })).rows).toEqual([
            { id: 2 },
            { id: 5 },
          ]);
        });
        it('uses finalized role period conditions without exposing hidden date fields', async () => {
          permissions.set('', {
            allowed: true,
            params: {
              fields: ['id'],
              appends: [],
              filter: { occurredAt: { $dateOn: '2026Q3+08:00' } },
            },
          });
          expect(await entryList()).toEqual([{ id: 1 }, { id: 2 }]);
          expect(await entryReads.count(ctx, mainIdentity, auth)).toBe(2);
          await expect(page({ occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } })).rejects.toThrow(/authorized/);
        });
      });
      it('intersects period filters with linked target visibility and role conditions', async () => {
        await projects.model.update({ occurredAt: new Date(dates.now) }, { where: { id: [101, 102] } });
        await projects.model.update({ occurredAt: new Date('2026-10-01T00:00:00Z') }, { where: { id: 103 } });
        const linked = { project: { occurredAt: { $dateOn: '{{$nDate.thisQuarter}}' } } };
        expect(await page(linked)).toMatchObject({ rows: [{ id: 1 }], count: 1 });
        permissions.set('project', {
          allowed: true,
          params: { filter: { occurredAt: { $dateBefore: '2026Q3+08:00' } } },
        });
        expect(await page(linked)).toMatchObject({ rows: [], count: 0 });
      });
      it('keeps ISO week 53 in its week year when the calendar year has changed', async () => {
        for (const [id, instant] of [
          [1, '2020-12-27T16:00:00.000Z'],
          [2, '2021-01-03T15:59:59.999Z'],
          [4, '2020-12-27T15:59:59.999Z'],
          [5, '2021-01-03T16:00:00.000Z'],
        ] as const)
          await docs.model.update({ occurredAt: new Date(instant) }, { where: { id } });
        const context = { now: '2021-01-01T00:00:00.000Z', timezone: '+08:00' };
        expect(await page({ occurredAt: { $dateOn: '{{$nDate.thisIsoWeek}}' } }, context)).toMatchObject({
          rows: [{ id: 1 }, { id: 2 }],
          count: 2,
        });
        expect(await page({ occurredAt: { $dateOn: '{{$nDate.thisWeek}}' } }, context)).toMatchObject({
          rows: [{ id: 1 }, { id: 4 }],
          count: 2,
        });
      });
      it('rejects nonexistent week and quarter labels before SQL', async () => {
        const query = vi.spyOn(db.sequelize, 'query');
        for (const value of ['2021W53', '2026w53', '2026W54', '2026Q5', '2026Q3+15:00'])
          await expect(page({ occurredAt: { $dateOn: value } })).rejects.toThrow();
        expect(query).not.toHaveBeenCalled();
      });
    });
    it.each([
      ['$dateOn', [1, 2]],
      ['$dateNotOn', [4, 5]],
      ['$dateBefore', [4]],
      ['$dateNotBefore', [1, 2, 5]],
      ['$dateAfter', [5]],
      ['$dateNotAfter', [1, 2, 4]],
      ['$dateBetween', [1, 2]],
    ])('keeps %s calendar boundaries, NULL and tenant restrictions', async (operator, ids) => {
      await docs.model.create({ id: 8, tenantId: 'B', name: 'No date', amount: 80 });
      const value = operator === '$dateBetween' ? '[2026-09-16,2026-09-17)+08:00' : '2026-09-16+08:00';
      expect(
        await entryReads.list(ctx, mainIdentity, auth, {
          attributes: ['id'],
          sort: ['id'],
          filter: { occurredAt: { [operator as string]: value } },
        }),
      ).toEqual((ids as number[]).map((id) => ({ id })));
    });
    it.each([
      ['$dateOn', [1]],
      ['$dateNotOn', [2, 4, 5]],
      ['$dateBefore', [4]],
      ['$dateNotBefore', [1, 2, 5]],
      ['$dateAfter', [2, 5]],
      ['$dateNotAfter', [1, 4]],
    ])('retains %s instant comparisons instead of calendar precision', async (operator, ids) => {
      expect(
        await entryReads.list(ctx, mainIdentity, auth, {
          attributes: ['id'],
          sort: ['id'],
          filter: { occurredAt: { [operator as string]: '2026-09-15T16:00:00.000Z' } },
        }),
      ).toEqual((ids as number[]).map((id) => ({ id })));
    });
    it('uses the same date and role conditions for pages, detail, counts and sums', async () => {
      const filter = { occurredAt: { $dateOn: '2026-09-16+08:00' } };
      permissions.set('', { allowed: true, params: { filter: { amount: { $gte: 15 } } } });
      expect(
        await entryReads.listPageFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter,
          pageSize: 1,
          page: 1,
        }),
      ).toEqual({ rows: [{ name: 'Visible' }], count: 1, page: 1, pageSize: 1, totalPage: 1 });
      expect(
        await entryReads.listPageFromParams(ctx, mainIdentity, auth, {
          fields: ['name'],
          filter,
          pageSize: 1,
          page: 2,
        }),
      ).toEqual({ rows: [], count: 1, page: 2, pageSize: 1, totalPage: 1 });
      expect(await entryReads.count(ctx, mainIdentity, auth, { filter })).toBe(1);
      expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount', filter })).toBe(20);
      expect(
        await entryReads.getFromParams(ctx, mainIdentity, auth, { filterByTk: 2, fields: ['name'], filter }),
      ).toEqual({ name: 'Visible' });
      expect(
        await entryReads.getFromParams(ctx, mainIdentity, auth, { filterByTk: 1, fields: ['name'], filter }),
      ).toBeNull();
    });
    it('allows hidden date fields in finalized root role conditions but not user filtering', async () => {
      permissions.set('', {
        allowed: true,
        params: {
          fields: ['id', 'amount'],
          appends: [],
          filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } },
        },
      });
      expect(await entryList()).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await entryReads.count(ctx, mainIdentity, auth)).toBe(2);
      expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount' })).toBe(30);
      await expect(entryList({ filter: { occurredAt: { $dateOn: '2026-09-16+08:00' } } })).rejects.toThrow(
        /authorized/,
      );
    });
    it('allows internal relationship date facts without granting target payload access', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-16T00:00:00Z') }, { where: { id: 102 } });
      permissions.set('', {
        allowed: true,
        params: {
          fields: ['id'],
          appends: [],
          filter: { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } },
        },
      });
      permissions.set('project', { allowed: false, params: {} });
      expect(await entryList()).toEqual([{ id: 2 }]);
      await expect(entryList({ filter: { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } } })).rejects.toThrow(
        /authorized/,
      );
    });
    it('independently constrains targets of public relationship date filters', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-16T00:00:00Z') }, { where: { id: [101, 102] } });
      const filter = { project: { occurredAt: { $dateOn: '2026-09-16+08:00' } } };
      expect(await entryList({ filter })).toEqual([{ id: 1 }]);
      permissions.set('project', { allowed: true, params: { filter: { name: { $ne: 'Zebra' } } } });
      expect(await entryList({ filter })).toEqual([]);
    });
    it('intersects multiple date operators on the same field', async () => {
      expect(
        await entryList({
          filter: {
            occurredAt: {
              $dateOn: '2026-09-16+08:00',
              $dateBefore: '2026-09-16T00:00:00.000Z',
            },
          },
        }),
      ).toEqual([{ id: 1 }]);
    });
    it.each([false, true])('does not merge away conflicting date predicates (reverse=%s)', async (reverse) => {
      const entries: Array<[string, unknown]> = [
        ['$dateOn', '2026-09-16+08:00'],
        ['$dateBetween', '[2026-09-17,2026-09-18)+08:00'],
      ];
      const filter = { occurredAt: Object.fromEntries(reverse ? entries.reverse() : entries) };
      expect(await entryList({ filter })).toEqual([]);
      permissions.set('', { allowed: true, params: { fields: ['id'], filter } });
      expect(await entryList()).toEqual([]);
    });
    it('uses the captured scalar timezone and the core UTC default for array ranges', async () => {
      db.options.timezone = '+08:00';
      expect(await entryList({ filter: { occurredAt: { $dateOn: '2026-09-16' } } })).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await entryList({ filter: { occurredAt: { $dateOn: '2026-09-16+00:00' } } })).toEqual([
        { id: 2 },
        { id: 5 },
      ]);
      expect(await entryList({ filter: { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)'] } } })).toEqual(
        [{ id: 2 }, { id: 5 }],
      );
      expect(
        await entryList({ filter: { occurredAt: { $dateBetween: ['2026-09-16', '2026-09-17', '[)', '+08:00'] } } }),
      ).toEqual([{ id: 1 }, { id: 2 }]);
    });
    it('snapshots date range arrays and timezone before asynchronous scope queries', async () => {
      db.options.timezone = '+08:00';
      const range = ['2026-09-16', '2026-09-17', '[)', '+08:00'];
      const original = queries.scopeQuery.bind(queries);
      vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
        range[0] = '2027-01-01';
        db.options.timezone = '-05:00';
        return original(...args);
      });
      expect(await entryList({ filter: { occurredAt: { $dateBetween: range } } })).toEqual([{ id: 1 }, { id: 2 }]);
    });
    it('rejects unresolved and invalid date filters before SQL', async () => {
      const query = vi.spyOn(db.sequelize, 'query');
      for (const filter of [
        { occurredAt: { $dateOn: '{{$nDate.today}}' } },
        { occurredAt: { $dateOn: '2026-02-29' } },
        { name: { $dateOn: '2026-09-16' } },
      ])
        await expect(entryList({ filter })).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
    it('preserves core DATEONLY predicates on a registered physical date field', async () => {
      await docs.model.update({ calendarDate: '2026-09-16' }, { where: { id: [1, 2] } });
      for (const operator of [
        '$dateOn',
        '$dateNotOn',
        '$dateBefore',
        '$dateNotBefore',
        '$dateAfter',
        '$dateNotAfter',
        '$dateBetween',
      ]) {
        const value = operator === '$dateBetween' ? '[2026-09-16,2026-09-17)+00:00' : '2026-09-16+00:00';
        const filter = { calendarDate: { [operator]: value } };
        const parsed = new FilterParser(filter, { collection: docs }).toSequelizeParams();
        const expected = await docs.model.findAll({
          attributes: ['id'],
          where: { [Op.and]: [parsed.where!, { id: [1, 2, 4, 5] }] },
          order: [['id', 'ASC']],
          raw: true,
        });
        expect(await entryList({ filter, sort: ['id'] })).toEqual(expected);
      }
      expect(await entryList({ filter: { calendarDate: { $dateOn: '2026-09-16+00:00' } } })).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "read_documents", "read_projects", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });
  const list = (request: object = {}) => reads.list(ctx, mainIdentity, auth, { attributes: ['id'], ...request });
  const get = (key: unknown, request: object = {}) =>
    reads.get(ctx, mainIdentity, auth, { key, attributes: ['id'], ...request });
  const count = (filter: unknown = {}) => reads.count(ctx, mainIdentity, auth, { filter });
  const sum = (filter: unknown = {}) => reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter });
  const entryList = (request: object = {}) =>
    entryReads.list(ctx, mainIdentity, auth, { attributes: ['id'], ...request });
  const entryOperation = (kind: 'list' | 'get' | 'count' | 'sum') => {
    if (kind === 'list') return entryList();
    if (kind === 'get') return entryReads.get(ctx, mainIdentity, auth, { key: 2, attributes: ['id'] });
    if (kind === 'count') return entryReads.count(ctx, mainIdentity, auth);
    return entryReads.sum(ctx, mainIdentity, auth, { field: 'amount' });
  };
  it('summary params require the specific operation permission rather than list permission', async () => {
    const kinds: string[] = [];
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      (_collection, _path, operation) => {
        kinds.push(operation.kind);
        return { allowed: operation.kind === 'count', params: { fields: ['id'] } };
      },
    );
    expect(await entryReads.countFromParams(ctx, mainIdentity, auth, {})).toBe(4);
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount' })).rejects.toThrow(/authorized/);
    await expect(entryReads.listFromParams(ctx, mainIdentity, auth, { fields: ['id'] })).rejects.toThrow(/authorized/);
    expect(query).not.toHaveBeenCalled();
    expect(kinds).toEqual(['count', 'sum', 'list']);
  });
  it('summary params reject nonnumeric and unauthorized root sum fields before SQL', async () => {
    const query = vi.spyOn(db.sequelize, 'query');
    for (const field of ['name', 'labels', 'occurredAt', 'project.amount', 'missing', 'amount; DROP TABLE documents'])
      await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field })).rejects.toThrow();
    permissions.set('', { allowed: true, params: { fields: ['id'], appends: [] } });
    await expect(entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount' })).rejects.toThrow(/authorized/);
    expect(query).not.toHaveBeenCalled();
  });
  it('entry supports relational finalized ACL conditions across all four reads without exposing fact fields', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    const role = acl.define({ role: 'reader' });
    role.grantAction('documents:view', {
      fields: ['id', 'amount'],
      appends: [],
      filter: { 'project.name': '{{ ctx.state.currentUser.projectName }}' },
    });
    acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
    const can = acl.can({ role: 'reader', resource: 'documents', action: 'list' })!;
    const params = await acl.parseJsonTemplate(structuredClone(can.params), {
      db,
      state: { currentRole: 'reader', currentUser: { projectName: 'Secret' } },
    } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
    permissions.set('', { allowed: true, params });
    permissions.set('project', { allowed: false, params: {} });
    expect(await entryOperation('list')).toEqual([{ id: 2 }]);
    expect(await entryOperation('get')).toEqual({ id: 2 });
    expect(await entryOperation('count')).toBe(1);
    expect(await entryOperation('sum')).toBe(20);
    await expect(entryList({ attributes: ['name'] })).rejects.toThrow(/authorized/);
    await expect(entryList({ filter: { project: { name: 'Secret' } } })).rejects.toThrow(/authorized/);
    expect(entryResolver.mock.calls.every(([, path]) => !path.length)).toBe(true);
  });
  it('entry keeps role conditions and G/V outside an OR request filter', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Zebra' } } } });
    expect(await entryList({ filter: { $or: [{ id: 3 }, { id: 1 }, { id: 2 }] } })).toEqual([{ id: 1 }]);
    expect(await entryReads.get(ctx, mainIdentity, auth, { key: 3, attributes: ['id'] })).toBeNull();
  });
  it('entry request associations remain scoped independently of role authorization facts', async () => {
    permissions.set('', {
      allowed: true,
      params: { fields: ['id', 'amount'], appends: ['project'], filter: { project: { name: 'Secret' } } },
    });
    permissions.set('project', { allowed: true, params: { fields: ['name'] } });
    expect(await entryList({ sort: ['project.name'] })).toEqual([{ id: 2 }]);
    const filter = { project: { name: 'Secret' } };
    expect(await entryList({ filter })).toEqual([]);
    expect(await entryReads.count(ctx, mainIdentity, auth, { filter })).toBe(0);
    expect(await entryReads.sum(ctx, mainIdentity, auth, { field: 'amount', filter })).toBeNull();
  });
  it.each(['list', 'get', 'count', 'sum'] as const)(
    'entry denies missing operation permission for %s',
    async (kind) => {
      permissions.set('', { allowed: false, params: {} });
      const query = vi.spyOn(db.sequelize, 'query');
      await expect(entryOperation(kind)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('entry snapshots permission JSON before asynchronous scope resolution and refreshes each operation', async () => {
    const permission = { allowed: true, params: { fields: ['id'], filter: { project: { name: 'Secret' } } } };
    permissions.set('', permission);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      permission.params.filter.project.name = 'Zebra';
      permission.params.fields[0] = 'amount';
      return original(...args);
    });
    expect(await entryList()).toEqual([{ id: 2 }]);
    expect(await entryList({ attributes: ['amount'] })).toEqual([{ amount: 10 }]);
    expect(entryResolver.mock.calls.filter(([, path]) => !path.length)).toHaveLength(2);
  });
  it('entry isolates simultaneous reads on the same service', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
    let resume!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const first = entryList();
    try {
      await Promise.race([started, first]);
      permissions.set('', { allowed: true, params: { filter: { project: { name: 'Zebra' } } } });
      expect(await entryList()).toEqual([{ id: 1 }]);
    } finally {
      resume();
    }
    expect(await first).toEqual([{ id: 2 }]);
  });
  it('entry resolves permissions for the specific operation and trusted identity', async () => {
    const kinds: string[] = [];
    entryReads = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => identities.find((identity) => identity.collectionName === collection.name),
      (_collection, _path, operation) => {
        expect(operation.context).toBe(ctx);
        expect(operation.source).toEqual(mainIdentity);
        expect(operation.authenticated).toEqual(auth);
        kinds.push(operation.kind);
        return { allowed: operation.kind !== 'get', params: { fields: ['id', 'amount'] } };
      },
    );
    expect(await entryOperation('list')).toHaveLength(4);
    await expect(entryOperation('get')).rejects.toThrow(/authorized/);
    expect(await entryOperation('count')).toBe(4);
    expect(await entryOperation('sum')).toBe(120);
    expect(kinds).toEqual(['list', 'get', 'count', 'sum']);
  });
  it.each([
    'fields prototype',
    'appends prototype',
    'permission prototype',
    'hidden permission key',
    'hidden params key',
    'hidden own',
  ])('entry rejects malformed permission %s before cloning or spreading', async (invalidCase) => {
    const permission = { allowed: true, params: { fields: ['id'], appends: ['project'] } };
    if (invalidCase === 'fields prototype')
      Object.setPrototypeOf(permission.params.fields, Object.create(Array.prototype));
    if (invalidCase === 'appends prototype')
      Object.setPrototypeOf(permission.params.appends, Object.create(Array.prototype));
    if (invalidCase === 'permission prototype') Object.setPrototypeOf(permission, { custom: true });
    if (invalidCase === 'hidden permission key') Object.defineProperty(permission, 'extra', { value: true });
    if (invalidCase === 'hidden params key') Object.defineProperty(permission.params, 'extra', { value: true });
    if (invalidCase === 'hidden own') Object.defineProperty(permission.params, 'own', { value: true });
    permissions.set('', permission);
    const query = vi.spyOn(db.sequelize, 'query');
    await expect(entryList()).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('entry preserves non-enumerable field restrictions', async () => {
    permissions.set('', { allowed: true, params: Object.defineProperty({}, 'fields', { value: ['id'] }) });
    expect(await entryList()).toHaveLength(4);
    await expect(entryList({ attributes: ['name'] })).rejects.toThrow(/authorized/);
  });
  it('entry rejects changed role-only metadata during scope preparation before root SQL', async () => {
    permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      projects.model.rawAttributes.name.field = 'changed_field';
      return result;
    });
    const find = vi.spyOn(docs.model, 'findAll');
    await expect(entryList()).rejects.toThrow(/changed/);
    expect(find).not.toHaveBeenCalled();
  });
  it.each(['list', 'get', 'count', 'sum'] as const)(
    'entry checks role-only metadata after executing %s',
    async (kind) => {
      permissions.set('', { allowed: true, params: { filter: { project: { name: 'Secret' } } } });
      const query = db.sequelize.query.bind(db.sequelize);
      vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
        const result = await query(...args);
        if (String(args[0]).includes('read_documents')) projects.model.rawAttributes.name.field = 'changed_field';
        return result;
      });
      await expect(entryOperation(kind)).rejects.toThrow(/changed/);
    },
  );
  it('entry checks sort-only target role facts captured before filtering awaits', async () => {
    projects.setField('related', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    await projects.model.update({ projectId: 103 }, { where: { id: 101 } });
    permissions.set('project', { allowed: true, params: { fields: ['name'], filter: { related: { name: 'Alpha' } } } });
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(projects.model.associations.related, { scope: { name: 'Zebra' } });
      return result;
    });
    const find = vi.spyOn(docs.model, 'findAll');
    await expect(entryList({ sort: ['project.name'] })).rejects.toThrow(/changed/);
    expect(find).not.toHaveBeenCalled();
  });
  it('uses the same G/V and root constraints for all four operations', async () => {
    expect(await list()).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
    expect(await get(2)).toEqual({ id: 2 });
    for (const id of [3, 6, 7, 999]) expect(await get(id)).toBeNull();
  });
  it('uses finalized role grants consistently without exposing role-filter fields', async () => {
    const acl = new ACL();
    acl.setAvailableAction('view', { aliases: ['get', 'list'] });
    const role = acl.define({ role: 'reader' });
    role.grantAction('documents:view', {
      fields: ['id', 'amount'],
      appends: ['project'],
      filter: { name: '{{ ctx.state.currentUser.name }}' },
    });
    role.grantAction('projects:view', { fields: ['name'], filter: { name: 'Zebra' } });
    acl.addFixedParams('documents', 'list', () => ({ filter: { amount: { $gte: 15 } } }));
    const entry = new AccessReadGrantAdapter(db, (collection) =>
      accessCollectionKey(identities.find((identity) => identity.collectionName === collection.name)!),
    );
    for (const identity of identities) {
      const can = acl.can({ role: 'reader', resource: identity.collectionName, action: 'list' })!;
      const params = await acl.parseJsonTemplate(structuredClone(can.params), {
        db,
        state: { currentRole: 'reader', currentUser: { name: 'Visible' } },
      } as unknown as Parameters<ACL['parseJsonTemplate']>[1]);
      grants.set(identity === mainIdentity ? '' : 'project', entry.capture(identity, { allowed: true, params }));
    }
    expect(await list()).toEqual([{ id: 2 }]);
    expect(await count()).toBe(1);
    expect(await sum()).toBe(20);
    expect(await get(2)).toEqual({ id: 2 });
    expect(await get(1)).toBeNull();
    const filter = { project: { name: 'Secret' } };
    expect(await list({ filter })).toEqual([]);
    expect(await count(filter)).toBe(0);
    expect(await sum(filter)).toBeNull();
    expect(await get(2, { filter })).toBeNull();
    await expect(list({ attributes: ['name'] })).rejects.toThrow(/authorized/);
  });
  it('combines parsed association filters with ordering without changing aggregate roots', async () => {
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await count(filter)).toBe(2);
    expect(await sum(filter)).toBe(50);
    expect(await get(1, { filter })).toEqual({ id: 1 });
    expect(await get(2, { filter })).toBeNull();
    expect(await list({ filter: { project: { name: 'Secret' } } })).toEqual([]);
  });
  it('intersects root and target role grants and preserves named bindings', async () => {
    grants.set('', {
      identity: mainIdentity,
      fields: ['id', 'amount', 'project'],
      where: literal('"documents"."record_id" <> $excluded'),
      bind: { excluded: 5 },
    });
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $wanted'),
      bind: { wanted: 'Zebra' },
    });
    const filter = { project: { name: { $includes: 'a' } } };
    expect(await list({ filter, sort: ['project.name'] })).toEqual([{ id: 1 }]);
    expect(await count(filter)).toBe(1);
    expect(await sum(filter)).toBe(10);
    expect(await list({ sort: ['project.name'] })).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }]);
  });
  it('reserves sort-only grant binding names before compiling filters', async () => {
    grants.set('project', {
      identity: projectIdentity,
      fields: ['name'],
      where: literal('"projects"."display_name" = $tac_scope0_0'),
      bind: { tac_scope0_0: 'Zebra' },
    });
    expect(await list({ sort: ['project.name'] })).toEqual([1, 2, 4, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
    expect(await sum()).toBe(120);
  });
  it('returns large authorized JSON values without applying mutation input limits', async () => {
    const labels = Array.from({ length: 10000 }, (_, index) => index);
    await docs.model.update({ labels }, { where: { id: 1 } });
    expect(await list({ attributes: ['labels'], filter: { id: 1 } })).toEqual([{ labels }]);
    expect(await get(1, { attributes: ['labels'] })).toEqual({ labels });
  });
  it('projects only authorized physical values without getters or internal keys', async () => {
    const getter = vi.fn(() => 'secret getter');
    Object.defineProperty(docs.model.rawAttributes.name, 'get', { value: getter, configurable: true });
    (docs.model as typeof docs.model & { refreshAttributes(): void }).refreshAttributes();
    expect((await docs.model.findByPk(1))?.get('name')).toBe('secret getter');
    getter.mockClear();
    grants.set('', { identity: mainIdentity, fields: ['name'] });
    expect(await list({ attributes: ['name'], limit: 1 })).toEqual([{ name: 'Owned' }]);
    expect(await get(1, { attributes: ['name'] })).toEqual({ name: 'Owned' });
    expect(getter).not.toHaveBeenCalled();
    await expect(list({ attributes: ['id'] })).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it('keeps page order stable with hidden targets last in both directions', async () => {
    expect(await list({ sort: ['project.name'], limit: 2 })).toEqual([{ id: 4 }, { id: 1 }]);
    expect(await list({ sort: ['project.name'], limit: 2, offset: 2 })).toEqual([{ id: 2 }, { id: 5 }]);
    expect(await list({ sort: ['-project.name'] })).toEqual([1, 4, 2, 5].map((id) => ({ id })));
    expect(await count()).toBe(4);
  });
  it('returns zero count and null sum for an empty readable set', async () => {
    const filter = { name: 'Missing' };
    expect(await list({ filter })).toEqual([]);
    expect(await count(filter)).toBe(0);
    expect(await sum(filter)).toBeNull();
  });
  it('reads an explicitly shared model without a tenant column or tenant identity', async () => {
    const key = (collection: Collection) =>
      accessCollectionKey(identities.find((i) => i.collectionName === collection.name)!);
    const store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: key }),
    );
    await store.save(
      projectIdentity,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    await db.sequelize.getQueryInterface().removeColumn('read_projects', 'tenant_id');
    projects.removeField('tenantId');
    adapter.release(ctx);
    await adapter.prepare(ctx, identities);
    const query = vi.spyOn(db.sequelize, 'query');
    expect(await reads.list(ctx, projectIdentity, {}, { attributes: ['name'] })).toEqual([
      { name: 'Zebra' },
      { name: 'Secret' },
      { name: 'Alpha' },
    ]);
    expect(await reads.get(ctx, projectIdentity, {}, { key: 102, attributes: ['name'] })).toEqual({ name: 'Secret' });
    expect(await reads.count(ctx, projectIdentity, {})).toBe(3);
    expect(await reads.sum(ctx, projectIdentity, {}, { field: 'amount' })).toBeNull();
    expect(query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('tenant_id');
  });
  it('rejects virtual projection and missing root grants', async () => {
    docs.setField('derived', { type: 'virtual', get: () => 'Secret' });
    await expect(list({ attributes: ['derived'] })).rejects.toThrow();
    grants.set('', null);
    await expect(list()).rejects.toThrow();
    await expect(count()).rejects.toThrow();
    await expect(sum()).rejects.toThrow();
  });
  it.each([
    { limit: 0 },
    { limit: 1001 },
    { limit: '20' },
    { offset: -1 },
    { offset: 1000001 },
    { offset: 1.1 },
    { attributes: [] },
    { attributes: ['nope'] },
    { attributes: ['project'] },
    { attributes: ['id', 'id'] },
    { attributes: ['id'], include: ['project'] },
    { raw: true },
    { where: {} },
    { bind: {} },
    { sort: ['amount DESC'] },
    { attributes: Object.assign([], { length: 1 }) },
  ])('rejects unsupported or malformed list requests: %j', async (request) => {
    await expect(list(request)).rejects.toThrow();
  });
  it('rejects nonnumeric and association sum fields and ORM options on non-list operations', async () => {
    for (const field of ['name', 'project.amount', 'labels', literal('amount')])
      await expect(reads.sum(ctx, mainIdentity, auth, { field })).rejects.toThrow();
    await expect(reads.count(ctx, mainIdentity, auth, { limit: 1 } as never)).rejects.toThrow();
    await expect(get('_')).rejects.toThrow();
  });
  it('rejects request accessors without invoking them', async () => {
    const getter = vi.fn(() => ['id']);
    // Pass the original object: spreading an accessor would invoke it before reaching the service.
    await expect(
      reads.list(ctx, mainIdentity, auth, Object.defineProperty({}, 'attributes', { get: getter }) as never),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('snapshots requests, identities and all grants before asynchronous scope resolution', async () => {
    const source = { ...mainIdentity };
    const authenticated = { tenantId: 'B' };
    const request = { attributes: ['id'], filter: { name: { $ne: 'Empty' } }, sort: ['project.name'] };
    const root: AccessFilterReadGrant = {
      identity: { ...mainIdentity },
      fields: ['id', 'name', 'project'],
      where: { id: { [Op.ne]: 2 } },
    };
    const target: AccessFilterReadGrant = {
      identity: { ...projectIdentity },
      fields: ['name'],
      where: { name: { [Op.ne]: 'Alpha' } },
    };
    grants.set('', root);
    grants.set('project', target);
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      request.attributes[0] = 'tenantId';
      request.filter.name.$ne = 'Owned';
      request.sort[0] = '-amount';
      source.collectionKey = 'wrong';
      authenticated.tenantId = 'C';
      root.fields = ['tenantId'];
      root.where = {};
      target.where = {};
      return original(...args);
    });
    expect(await reads.list(ctx, source, authenticated, request)).toEqual([{ id: 1 }, { id: 4 }]);
    expect(resolver.mock.calls.filter(([, path]) => path.length === 0)).toHaveLength(1);
    expect(resolver.mock.calls.filter(([, path]) => path.join('.') === 'project')).toHaveLength(1);
  });
  it('rejects changes to sort-only relation metadata during filter compilation', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      Object.assign(docs.model.associations.project, { scope: { name: 'Secret' } });
      return result;
    });
    await expect(list({ sort: ['project.name'] })).rejects.toThrow(/changed/);
  });
  it('rejects ended phases after the actual database read instead of returning stale results', async () => {
    const original = docs.model.findAll.bind(docs.model);
    vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(list()).rejects.toThrow();
  });
  it.each(['get', 'count', 'sum'] as const)('checks the phase after executing %s', async (kind) => {
    const query = db.sequelize.query.bind(db.sequelize);
    vi.spyOn(db.sequelize, 'query').mockImplementation(async (...args) => {
      const result = await query(...args);
      if (String(args[0]).includes('read_documents')) adapter.release(ctx);
      return result;
    });
    await expect(kind === 'get' ? get(1) : kind === 'count' ? count() : sum()).rejects.toThrow();
  });
  it('rejects foreign, finished and fake transactions before reading records', async () => {
    const foreign = sqliteDatabase();
    const foreignTransaction = await foreign.sequelize.transaction();
    const finished = await db.sequelize.transaction();
    await finished.rollback();
    const find = vi.spyOn(docs.model, 'findAll');
    try {
      for (const transaction of [{}, foreignTransaction, finished])
        await expect(list({ transaction })).rejects.toThrow(/transaction/i);
      expect(find).not.toHaveBeenCalled();
    } finally {
      await foreignTransaction.rollback();
      await foreign.close();
    }
  });
  it('passes the execution transaction and bypasses ORM query hooks', async () => {
    const hook = vi.fn(() => {
      throw new Error('unexpected ORM hook');
    });
    docs.model.addHook('beforeFind', 'read-test', hook);
    docs.model.addHook('beforeCount', 'count-test', hook);
    const transaction = await db.sequelize.transaction();
    try {
      await docs.model.create({ id: 9, tenantId: 'B', name: 'Uncommitted', amount: 90 }, { transaction });
      expect(await list({ filter: { id: 9 }, transaction })).toEqual([{ id: 9 }]);
      expect(await reads.count(ctx, mainIdentity, auth, { filter: { id: 9 }, transaction })).toBe(1);
      expect(await reads.sum(ctx, mainIdentity, auth, { field: 'amount', filter: { id: 9 }, transaction })).toBe(90);
      expect(await entryReads.countFromParams(ctx, mainIdentity, auth, { filter: { id: 9 } }, transaction)).toBe(1);
      expect(
        await entryReads.sumFromParams(ctx, mainIdentity, auth, { field: 'amount', filter: { id: 9 } }, transaction),
      ).toBe(90);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      await transaction.rollback();
    }
    expect(await get(9)).toBeNull();
  });
  it('keeps SQL query count constant for 20 and 100 root rows', async () => {
    await docs.model.bulkCreate(
      Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, tenantId: 'B', name: 'More', projectId: 101 })),
    );
    const query = vi.spyOn(db.sequelize, 'query');
    const run = async (limit: number) => {
      query.mockClear();
      expect(await list({ sort: ['project.name'], limit })).toHaveLength(limit);
      return query.mock.calls.length;
    };
    expect(await run(20)).toBe(await run(100));
    expect(await list()).toHaveLength(20);
  });
});
