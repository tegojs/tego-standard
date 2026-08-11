import { QueryInstruction } from '../../instructions/QueryInstruction';

describe('QueryInstruction', () => {
  function createProcessor() {
    return {
      getParsedValue: vi.fn((value) => value),
      getRepositoryContext: vi.fn(() => ({ state: {} })),
      transaction: 'tx-1',
    };
  }

  it('should throw a guarded error when the configured data source is missing', async () => {
    const instruction = new QueryInstruction({
      app: {
        dataSourceManager: {
          dataSources: new Map(),
        },
      },
    } as any);

    await expect(
      instruction.run(
        {
          id: 1,
          config: {
            collection: 'missing:posts',
          },
        } as any,
        null,
        createProcessor() as any,
      ),
    ).rejects.toThrow('data source missing for query data on query node not found');
  });

  it('should throw a guarded error when the configured collection is missing', async () => {
    const instruction = new QueryInstruction({
      app: {
        dataSourceManager: {
          dataSources: new Map([
            [
              'main',
              {
                collectionManager: {
                  getCollection: vi.fn(() => null),
                },
              },
            ],
          ]),
        },
      },
      useDataSourceTransaction: vi.fn(),
    } as any);

    await expect(
      instruction.run(
        {
          id: 1,
          config: {
            collection: 'posts',
          },
        } as any,
        null,
        createProcessor() as any,
      ),
    ).rejects.toThrow('collection posts repository for query data on query node not found');
  });
});
