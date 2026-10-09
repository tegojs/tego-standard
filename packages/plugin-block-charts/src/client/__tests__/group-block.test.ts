import { describe, expect, it } from 'vitest';

import { buildCustomQueryRequest } from '../block-group/GroupBlock';

describe('GroupBlock custom query requests', () => {
  it('marks custom summary requests for server-side read scoping', () => {
    expect(
      buildCustomQueryRequest({
        url: '/api/records:allweight',
        filter: { status: 'pending' },
        collection: 'records',
        dataSource: 'main',
      }),
    ).toEqual({
      url: '/api/records:allweight',
      method: 'POST',
      data: {
        filter: { status: 'pending' },
        collection: 'records',
        dataSource: 'main',
      },
    });
  });
});
