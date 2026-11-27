import { compileAccessScopes } from '../../access-control/compile';
import type { AccessCondition, CompileOptions } from '../../access-control/types';
import { configFor, documents, exampleConfig, ownerCondition, quoteIdentifier } from './fixtures';

describe('access SQL binding namespaces', () => {
  it('uses a caller-selected safe parameter prefix without modifying quoted identifiers', () => {
    const plan = compileAccessScopes(configFor(ownerCondition), {
      collection: documents,
      context: { 'tenant.id': 'B' },
      quoteIdentifier,
      parameterPrefix: 'request_scope_2_',
      rootAlias: '$tac_0',
    });
    expect(plan.read.bind).toEqual({ request_scope_2_0: 'B' });
    expect(plan.read.sql).toContain('"$tac_0"."tenant_id"');
    expect(plan.read.sql).toContain('$request_scope_2_0');
  });

  it.each(['', '1bad', 'bad-prefix', 'unsafe;SQL', '$binding', 'safe\n', null, { toString: () => 'safe' }])(
    'rejects invalid parameter prefix %j',
    (prefix) => {
      expect(() =>
        compileAccessScopes(configFor(ownerCondition), {
          collection: documents,
          context: { 'tenant.id': 'B' },
          quoteIdentifier,
          parameterPrefix: prefix as string,
        }),
      ).toThrow('parameter prefix');
    },
  );
});

function compile(config: unknown = exampleConfig, context: CompileOptions['context'] = { 'tenant.id': 'B' }) {
  return compileAccessScopes(config, { collection: documents, context, quoteIdentifier });
}

describe('tenant access rule compilation', () => {
  it('separates read visibility from ownership and binds values', () => {
    const scopes = compile();
    expect(scopes.ownership.sql).toContain('"tenant_id"');
    expect(scopes.ownership.sql).not.toContain('EXISTS');
    expect(scopes.visibility.sql).toContain('EXISTS');
    expect(scopes.read.sql).toContain(scopes.ownership.sql);
    expect(scopes.read.sql).toContain(scopes.visibility.sql);
    expect(scopes.read.sql).not.toContain("'B'");
    expect(Object.values(scopes.read.bind)).toContain('B');
  });

  it('denies both scopes when no rules are configured', () => {
    const scopes = compile({ ...exampleConfig, rules: [] });
    expect(scopes.ownership.sql).toBe('FALSE');
    expect(scopes.visibility.sql).toBe('FALSE');
  });

  it('permits an explicit shared rule without tenant context or tenant fields', () => {
    const shared = { ...documents, fields: { id: documents.fields.id } };
    const scopes = compileAccessScopes(configFor({ type: 'constant', value: true }), {
      collection: shared,
      context: {},
      quoteIdentifier,
    });
    expect(scopes.ownership.sql).toBe('TRUE');
    expect(scopes.read.sql).not.toContain('tenant_id');
  });

  it('does not turn missing context into permission through negation', () => {
    expect(() => compile(configFor({ type: 'not', child: ownerCondition }), {})).toThrow(/context/i);
  });

  it('validates all branches even when another branch is explicitly true', () => {
    expect(() =>
      compile(configFor({ type: 'any', children: [{ type: 'constant', value: true }, ownerCondition] }), {}),
    ).toThrow(/context/i);
  });

  it('uses SQL NULL propagation instead of negating a precomputed false', () => {
    const scopes = compile(configFor({ type: 'not', child: ownerCondition }));
    expect(scopes.ownership.sql).toContain('NOT');
    expect(scopes.ownership.sql).not.toMatch(/COALESCE|IS NOT TRUE/i);
  });

  it('keeps SQL-looking values out of SQL text', () => {
    const value = "B' OR TRUE --";
    const scopes = compile(exampleConfig, { 'tenant.id': value });
    expect(scopes.read.sql).not.toContain(value);
    expect(Object.values(scopes.read.bind)).toContain(value);
  });

  it.each([
    null,
    { ...exampleConfig, schemaVersion: 2 },
    { ...exampleConfig, revision: -1 },
    { ...exampleConfig, ownership: { enabled: 'true' } },
    { ...exampleConfig, rules: [null] },
    { ...exampleConfig, rules: [{ ...exampleConfig.rules[0], category: 'admin' }] },
    { ...exampleConfig, rules: [{ ...exampleConfig.rules[0], enabled: 'false' }] },
    { ...exampleConfig, rules: [exampleConfig.rules[0], exampleConfig.rules[0]] },
    configFor({ type: 'all', children: [] }),
    configFor({
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'missing' },
      right: { type: 'literal', value: 1 },
    }),
    configFor({ type: 'exists', path: 'missing', condition: { type: 'constant', value: true } }),
    configFor({
      type: 'compare',
      operator: 'gt',
      left: { type: 'field', path: 'name' },
      right: { type: 'literal', value: 'B' },
    }),
    configFor({
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'amount' },
      right: { type: 'literal', value: true },
    }),
    configFor({
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'amount' },
      right: { type: 'literal', value: null },
    }),
  ])('rejects invalid configuration %#', (config) => {
    expect(() => compile(config)).toThrow();
  });

  it('rejects record fields in the visitor condition', () => {
    const config = configFor(ownerCondition);
    config.rules[0].subject = ownerCondition;
    expect(() => compile(config)).toThrow(/subject/i);
  });

  it.each([
    { ...ownerCondition, operator: ['eq'] },
    { type: 'tenantRelation', tenant: { type: 'field', path: 'tenantId' }, relation: ['ancestor'], includeSelf: true },
  ])('rejects values that only coerce to valid operators', (condition) => {
    const config = configFor(ownerCondition);
    expect(() =>
      compile(
        { ...config, rules: [{ ...config.rules[0], condition }] },
        { 'tenant.id': 'H', 'tenant.descendantIds': ['B'] },
      ),
    ).toThrow();
  });

  it('ignores disabled rules only after validating their structure', () => {
    const config = configFor(ownerCondition);
    config.rules[0].enabled = false;
    const scopes = compile(config, {});
    expect(scopes.ownership.sql).toBe('FALSE');
    expect(() => compile({ ...config, rules: [{ ...config.rules[0], category: 'admin' }] })).toThrow();
  });

  it('refuses more than three association hops across nested exists conditions', () => {
    const recursive = { ...documents, associations: {} };
    recursive.associations = { next: { target: recursive, sourceField: 'id', targetField: 'id' } };
    const condition: AccessCondition = {
      type: 'exists',
      path: 'next.next',
      condition: {
        type: 'exists',
        path: 'next.next',
        condition: { type: 'constant', value: true },
      },
    };
    expect(() =>
      compileAccessScopes(configFor(condition), {
        collection: recursive,
        context: {},
        quoteIdentifier,
      }),
    ).toThrow(/depth|hops/i);
  });

  it('uses trusted hierarchy lists for ancestor ownership', () => {
    const config = configFor({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'ancestor',
      includeSelf: true,
    });
    const scopes = compileAccessScopes(config, {
      collection: documents,
      context: { 'tenant.id': 'H', 'tenant.descendantIds': ['B', 'C'] },
      quoteIdentifier,
    });
    expect(Object.values(scopes.read.bind)).toEqual(expect.arrayContaining(['H', 'B', 'C']));
    expect(() => compile(config)).toThrow(/context/i);
  });

  it.each([null, '', false, NaN, Number.MAX_SAFE_INTEGER + 1, ['B']])(
    'rejects malformed active tenant context %#',
    (tenant) => {
      expect(() => compile(exampleConfig, { 'tenant.id': tenant })).toThrow(/context/i);
    },
  );

  it('keeps only bindings referenced by a simplified scope', () => {
    const config = configFor({ type: 'any', children: [{ type: 'constant', value: true }, ownerCondition] });
    const scopes = compile(config);
    expect(scopes.ownership).toEqual({ sql: 'TRUE', bind: {} });
    expect(scopes.visibility).toEqual({ sql: 'FALSE', bind: {} });
  });

  it('limits condition size before recursion can exhaust the stack', () => {
    let condition: AccessCondition = ownerCondition;
    for (let depth = 0; depth < 20; depth++) condition = { type: 'not', child: condition };
    expect(() => compile(configFor(condition))).toThrow(/depth/i);
  });

  it('rejects unknown keys instead of silently ignoring a restriction', () => {
    const config = configFor(ownerCondition);
    expect(() => compile({ ...config, rules: [{ ...config.rules[0], deny: true }] })).toThrow();
  });

  it.each(['not a date', '2026-02-30', '2026-13-01', '1900-02-29', '2026-10-13T10:00:00', '2026-10-13T24:00:00Z'])(
    'rejects invalid date literals: %s',
    (value) => {
      const config = configFor({
        type: 'compare',
        operator: 'gte',
        left: { type: 'field', path: 'date' },
        right: { type: 'literal', value },
      });
      expect(() =>
        compileAccessScopes(config, {
          collection: { ...documents, fields: { date: { column: 'effective_date', type: 'date' } } },
          context: {},
          quoteIdentifier,
        }),
      ).toThrow(/date/i);
    },
  );

  it.each(['2024-02-29', '2000-02-29', '2026-10-13T10:00:00+08:00', '2026-10-13T02:00:00.000Z'])(
    'accepts an explicit ISO date literal: %s',
    (value) => {
      const config = configFor({
        type: 'compare',
        operator: 'gte',
        left: { type: 'field', path: 'date' },
        right: { type: 'literal', value },
      });
      const scope = compileAccessScopes(config, {
        collection: { ...documents, fields: { date: { column: 'effective_date', type: 'date' } } },
        context: {},
        quoteIdentifier,
      }).read;
      expect(Object.values(scope.bind)).toEqual([value]);
    },
  );
});
