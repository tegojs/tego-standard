import {
  parseResourceAssociationGetParams,
  parseResourceCountParams,
  parseResourceGetParams,
  parseResourceListParams,
  parseResourceSumParams,
} from '../../access-control/resource-read-params';

describe('resource read params', () => {
  describe('association detail params', () => {
    it('requires an explicit HasMany key and preserves its scalar value', () => {
      expect(parseResourceAssociationGetParams({ fields: ['name'], filterByTk: '9007199254740993' }, false)).toEqual({
        fields: ['name'],
        key: '9007199254740993',
      });
      expect(() => parseResourceAssociationGetParams({}, false)).toThrow();
    });
    it('allows a relation-located HasOne detail and ignores a supported scalar or null target key', () => {
      for (const filterByTk of [undefined, null, 1, 'unrelated'])
        expect(parseResourceAssociationGetParams({ fields: ['name'], filterByTk }, true)).toEqual({ fields: ['name'] });
    });
    it('does not broaden get input to accept list or execution capabilities', () => {
      const getter = vi.fn(() => 1);
      for (const input of [
        { sort: 'name' },
        { pageSize: 1 },
        { transaction: {} },
        { rootConstraint: {} },
        { filterByTk: {} },
        Object.defineProperty({}, 'filterByTk', { get: getter }),
      ])
        expect(() => parseResourceAssociationGetParams(input, true)).toThrow();
      expect(getter).not.toHaveBeenCalled();
    });
  });
  describe('summary params', () => {
    it('accepts only the count filter and the internal sum field/filter contract', () => {
      const filter = { amount: { $gte: 15 } };
      expect(parseResourceCountParams({})).toEqual({});
      expect(parseResourceCountParams({ filter })).toEqual({ filter });
      expect(parseResourceSumParams({ field: 'amount', filter })).toEqual({ field: 'amount', filter });
      expect(parseResourceSumParams({ field: 'amount' })).toEqual({ field: 'amount' });
    });
    it.each([
      'fields',
      'appends',
      'except',
      'sort',
      'page',
      'pageSize',
      'paginate',
      'tree',
      'filterByTk',
      'method',
      'aggregation',
      'where',
      'bind',
      'transaction',
      'tenantId',
      'permission',
      'now',
      'timezone',
    ])('rejects non-contract summary parameter %s', (key) => {
      expect(() => parseResourceCountParams({ [key]: {} })).toThrow();
      expect(() => parseResourceSumParams({ field: 'amount', [key]: {} })).toThrow();
    });
    it.each([undefined, null, '', 'amount.name', 'amount; DROP TABLE documents', 'x'.repeat(513), 1, [], {}])(
      'requires one bounded root sum field %j',
      (field) => {
        expect(() => parseResourceSumParams({ field })).toThrow();
      },
    );
    it('rejects accessors and symbols without invoking them, and captures hidden data properties', () => {
      const getter = vi.fn(() => 'amount');
      for (const parse of [parseResourceCountParams, parseResourceSumParams]) {
        expect(() => parse(Object.defineProperty({}, 'filter', { get: getter }))).toThrow();
        expect(() => parse({ [Symbol('filter')]: {} })).toThrow();
        for (const input of [null, undefined, [], new Date(), Object.create({ filter: {} })])
          expect(() => parse(input)).toThrow();
      }
      expect(() => parseResourceSumParams(Object.defineProperty({}, 'field', { get: getter }))).toThrow();
      expect(getter).not.toHaveBeenCalled();
      const filter = { id: 1 };
      const input = Object.defineProperty({ field: 'amount' }, 'filter', { value: filter });
      expect(parseResourceSumParams(input)).toEqual({ field: 'amount', filter });
      expect(parseResourceSumParams(input).filter).toBe(filter);
    });
  });
  it('uses the core main-source pagination defaults', () => {
    expect(parseResourceListParams({})).toEqual({ limit: 20, offset: 0 });
  });
  it.each([2, '2'])('converts page and pageSize without rounding (%s)', (page) => {
    expect(parseResourceListParams({ page, pageSize: '25' })).toEqual({ limit: 25, offset: 25 });
  });
  it('accepts the existing pagination boundaries', () => {
    expect(parseResourceListParams({ page: '1001', pageSize: '1000' })).toEqual({ limit: 1000, offset: 1000000 });
  });
  it.each([0, -1, 1.5, NaN, Infinity, null, '', ' 2', '2 ', '02', '+2', '2x', '2.0', '2e1', true, {}, []])(
    'rejects ambiguous or invalid pagination %j',
    (page) => {
      expect(() => parseResourceListParams({ page })).toThrow();
      expect(() => parseResourceListParams({ pageSize: page })).toThrow();
    },
  );
  it.each([{ pageSize: 1001 }, { page: 1000002, pageSize: 1 }, { page: Number.MAX_SAFE_INTEGER, pageSize: 1000 }])(
    'rejects oversized pagination %j',
    (request) => expect(() => parseResourceListParams(request)).toThrow(),
  );
  it.each([true, 'true', undefined])('accepts explicitly paginated flat lists (%s)', (paginate) => {
    expect(parseResourceListParams({ paginate, tree: false })).toEqual({ limit: 20, offset: 0 });
    expect(parseResourceListParams({ tree: 'false' })).toEqual({ limit: 20, offset: 0 });
  });
  it.each([{ paginate: false }, { paginate: 'false' }, { paginate: 1 }, { tree: true }, { tree: 'true' }])(
    'rejects unsupported list execution modes %j',
    (request) => expect(() => parseResourceListParams(request)).toThrow(),
  );
  it('translates a detail key without losing a large integer string', () => {
    expect(parseResourceGetParams({ filterByTk: '9007199254740993', fields: ['name'] })).toEqual({
      key: '9007199254740993',
      fields: ['name'],
    });
    expect(parseResourceGetParams({ filterByTk: 42 })).toEqual({ key: 42 });
  });
  it.each([{}, { filterByTk: undefined }, { filterByTk: null }, { filterByTk: [] }, { filterByTk: {} }])(
    'requires an explicit scalar detail key %j',
    (request) => expect(() => parseResourceGetParams(request)).toThrow(),
  );
  it('captures field arrays and converts comma-separated sorting without modifying input', () => {
    const fields = ['name'];
    const appends = ['project.name'];
    const except = ['amount'];
    const request = { fields, appends, except, sort: '-amount,project.name' };
    const result = parseResourceListParams(request);
    fields.push('payload');
    appends.length = 0;
    except.length = 0;
    expect(result).toEqual({
      fields: ['name'],
      appends: ['project.name'],
      except: ['amount'],
      sort: ['-amount', 'project.name'],
      limit: 20,
      offset: 0,
    });
    expect(request.sort).toBe('-amount,project.name');
  });
  it('preserves filters for downstream strict validation and snapshots non-enumerable root values', () => {
    const filter = { name: 'Owned' };
    const request = Object.defineProperty({ pageSize: 2 }, 'filter', { value: filter });
    expect(parseResourceListParams(request)).toEqual({ filter, limit: 2, offset: 0 });
    expect(parseResourceListParams(request).filter).toBe(filter);
  });
  it.each(['fields', 'appends', 'except', 'sort'])('rejects bad %s array descriptors before copying', (name) => {
    const getter = vi.fn(() => 'name');
    for (const value of [
      Array(1),
      Object.setPrototypeOf(['name'], {}),
      Object.defineProperty(['name'], '0', { get: getter }),
    ])
      expect(() => parseResourceListParams({ [name]: value })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    { sort: '' },
    { sort: 'name,' },
    { sort: Array(21).fill('name') },
    { sort: 'x'.repeat(513) },
    { fields: 'name' },
    { appends: Array(1001).fill('project') },
    { except: ['x'.repeat(1025)] },
  ])('rejects malformed or oversized field lists %j', (request) =>
    expect(() => parseResourceListParams(request)).toThrow(),
  );
  it.each(['list', 'get'])('rejects root accessors and non-contract parameters for %s', (kind) => {
    const parse = kind === 'list' ? parseResourceListParams : parseResourceGetParams;
    const getter = vi.fn(() => ['name']);
    expect(() =>
      parse(Object.defineProperty(kind === 'get' ? { filterByTk: 1 } : {}, 'fields', { get: getter })),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    for (const name of ['where', 'bind', 'transaction', 'attributes', 'limit', 'tenantId', 'permission'])
      expect(() => parse({ ...(kind === 'get' ? { filterByTk: 1 } : {}), [name]: {} })).toThrow();
  });
  it.each([null, undefined, [], new Date(), Object.create({ page: 1 })])(
    'rejects non-plain root params %j',
    (request) => {
      expect(() => parseResourceListParams(request)).toThrow();
      expect(() => parseResourceGetParams(request)).toThrow();
    },
  );
  it('copies sort arrays before subsequent caller changes', () => {
    const sort = ['name'];
    const result = parseResourceListParams({ sort });
    sort[0] = '-name';
    expect(result.sort).toEqual(['name']);
  });
});
