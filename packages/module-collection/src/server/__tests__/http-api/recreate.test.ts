import { MockServer } from '@tachybase/test';

import { createApp } from '../index';

describe('recreate field', () => {
  let app: MockServer;
  let agent;

  beforeAll(async () => {
    app = await createApp();
    agent = app.agent();
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should recreate field', async () => {
    const sourceName = 'recreateFieldSource';
    const targetName = 'recreateFieldTarget';

    await agent.resource('collections').create({
      values: {
        name: sourceName,
      },
    });

    await agent.resource('collections').create({
      values: {
        name: targetName,
      },
    });

    await agent.resource('fields').create({
      values: {
        name: 'a',
        type: 'string',
        collectionName: sourceName,
      },
    });

    await agent.resource(sourceName).create({
      values: {
        a: 'a-value',
      },
    });

    await agent.resource('fields').destroy({
      filter: {
        name: 'a',
        collectionName: sourceName,
      },
    });

    await agent.resource('fields').create({
      values: {
        name: 'a',
        type: 'belongsToMany',
        collectionName: sourceName,
        target: targetName,
      },
    });

    const response = await agent.resource(sourceName).list({
      appends: ['a'],
    });

    expect(response.statusCode).toBe(200);
  });

  it('should reset fields', async () => {
    const collectionName = 'resetFieldsCollection';

    await agent.resource('collections').create({
      values: {
        name: collectionName,
        fields: [
          {
            name: 'a',
            type: 'string',
          },
        ],
      },
    });

    expect(await app.db.getRepository('fields').count({ filter: { collectionName } })).toBe(1);
    const response = await agent.resource('collections').setFields({
      filterByTk: collectionName,
      values: {
        fields: [
          {
            name: 'a',
            type: 'bigInt',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);

    expect(await app.db.getRepository('fields').count({ filter: { collectionName } })).toBe(1);
  });
});
