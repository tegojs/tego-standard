import createManualFormRecord from '../forms/create';

describe('workflow > manual forms > create errors', () => {
  function runCreate(dataSourceManager: any, config: any = { dataSource: 'main', collection: 'posts' }) {
    return createManualFormRecord.call(
      {
        workflow: {
          app: {
            dataSourceManager,
          },
        },
      } as any,
      { result: {} },
      config,
      {} as any,
    );
  }

  it('should distinguish missing data source, collection, and repository errors', async () => {
    await expect(
      runCreate({
        dataSources: new Map(),
      }),
    ).rejects.toThrow('data source main for create data on manual node not found');

    await expect(
      runCreate({
        dataSources: new Map([
          [
            'main',
            {
              collectionManager: {
                getCollection: () => null,
              },
            },
          ],
        ]),
      }),
    ).rejects.toThrow('collection posts for create data on manual node not found');

    await expect(
      runCreate({
        dataSources: new Map([
          [
            'main',
            {
              collectionManager: {
                getCollection: () => ({ repository: null }),
              },
            },
          ],
        ]),
      }),
    ).rejects.toThrow('repository for collection posts on manual node not found');
  });
});
