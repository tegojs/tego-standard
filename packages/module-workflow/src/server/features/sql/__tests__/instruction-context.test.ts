import { vi } from 'vitest';

import SQLInstruction from '../SQLInstruction';

describe('workflow > instructions > sql > context', () => {
  it('should expose only tenant-safe repository context to SQL templates', async () => {
    let parsedScope: any;
    const query = vi.fn().mockResolvedValue([[], undefined]);
    const instruction = Object.create(SQLInstruction.prototype);
    instruction.workflow = {
      app: {
        dataSourceManager: {
          dataSources: {
            get: () => ({
              collectionManager: {
                db: {
                  sequelize: {
                    query,
                  },
                },
              },
            }),
          },
        },
      },
    };
    const repositoryContext = {
      app: { secret: true },
      db: { secret: true },
      state: {
        currentTenantId: 'tenant-a',
        currentTenant: { id: 'tenant-a' },
        currentTenantDescendantIds: ['tenant-b'],
        currentTenancyMode: 'tenantInherited',
        currentLegacyDataTenantIds: ['tenant-a'],
        token: 'secret-token',
      },
      stack: ['node-a'],
    };
    const processor = {
      execution: {
        get: () => null,
      },
      options: {},
      transaction: undefined,
      getRepositoryContext: () => repositoryContext,
      getParsedValue: (_value: string, _nodeId: number, scope: any) => {
        parsedScope = scope;
        return 'SELECT 1';
      },
    };

    await instruction.run({ id: 1, config: {} }, {}, processor as any);

    expect(parsedScope.$repositoryContext).not.toHaveProperty('app');
    expect(parsedScope.$repositoryContext).not.toHaveProperty('db');
    expect(parsedScope.$repositoryContext.state).toEqual({
      currentTenant: { id: 'tenant-a' },
      currentTenantId: 'tenant-a',
      currentTenantDescendantIds: ['tenant-b'],
      currentTenancyMode: 'tenantInherited',
      currentLegacyDataTenantIds: ['tenant-a'],
    });
    expect(parsedScope.$tenantContext).toEqual(parsedScope.$repositoryContext.state);
    expect(query).toHaveBeenCalledWith('SELECT 1', {
      transaction: undefined,
    });
  });
});
