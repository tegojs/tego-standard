import { parseWorkflowQueryParams } from '../../access-control/resource-read-params';

describe('normalized workflow query params', () => {
  it('preserves a paged query without treating limit and offset as HTTP pagination', () => {
    expect(parseWorkflowQueryParams({ fields: ['id'], sort: ['-id'], limit: 3, offset: 6 }, true)).toEqual({
      request: { fields: ['id'], sort: ['-id'], limit: 3, offset: 6 },
      complete: false,
    });
  });
  it('bounds an unpaginated query as complete rather than silently paging it', () => {
    expect(parseWorkflowQueryParams({ appends: undefined, sort: [] }, true)).toEqual({
      request: { sort: [], limit: 1000, offset: 0 },
      complete: true,
    });
  });
  it('selects one matching row at the requested offset under list authorization', () => {
    expect(parseWorkflowQueryParams({ limit: 20, offset: 40, filter: { id: { $gt: 1 } } }, false)).toEqual({
      request: { filter: { id: { $gt: 1 } }, limit: 1, offset: 40 },
      complete: false,
    });
  });
  it('captures mutable fields and filters before server metadata callbacks', () => {
    const query = { fields: ['id'], filter: { name: 'original' }, tree: false };
    const captured = parseWorkflowQueryParams(query, true);
    query.fields[0] = 'secret';
    query.filter.name = 'changed';
    expect(captured.request.fields).toEqual(['id']);
    expect(captured.request.filter).toEqual({ name: 'original' });
  });
  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 1001 },
    { limit: '20' },
    { offset: -1 },
    { offset: 1.5 },
    { offset: 1000001 },
    { offset: '0' },
    { offset: 1 },
    { tree: true },
    { page: 1 },
    { paginate: false },
    { filterByTk: 1 },
    { where: {} },
    { transaction: {} },
    { context: {} },
    { permission: {} },
    { tenantId: 'other' },
  ])('rejects unsupported normalized options %j', (query) => {
    expect(() => parseWorkflowQueryParams(query, true)).toThrow();
  });
  it.each([null, undefined, [], new Date(), Object.create({ limit: 1 })])('rejects non-plain query %s', (query) => {
    expect(() => parseWorkflowQueryParams(query, true)).toThrow();
  });
  it('rejects accessors, sparse arrays and hidden control options without running getters', () => {
    const getter = () => {
      throw new Error('getter executed');
    };
    for (const query of [
      Object.defineProperty({}, 'filter', { get: getter }),
      Object.defineProperty({}, 'limit', { get: getter }),
      Object.defineProperty({}, 'transaction', { value: {} }),
      { fields: Array(1) },
      { filter: Object.defineProperty({}, 'id', { get: getter }) },
    ])
      expect(() => parseWorkflowQueryParams(query, true)).toThrow(/params|accessors|dense|options/i);
  });
  it.each([undefined, null, 'true', 1])('requires an explicit boolean query cardinality %s', (multiple) => {
    expect(() => parseWorkflowQueryParams({}, multiple)).toThrow();
  });
});
