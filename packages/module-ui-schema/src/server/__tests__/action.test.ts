import { createMockServer, MockServer } from '@tachybase/test';

describe('action test', () => {
  let app: MockServer;

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      plugins: ['ui-schema-storage'],
    });
  });

  afterAll(async () => {
    await app.destroy();
  });

  const createSchema = (prefix: string) => ({
    'x-uid': `${prefix}-n1`,
    name: `${prefix}-a`,
    type: 'object',
    properties: {
      b: {
        'x-uid': `${prefix}-n2`,
        type: 'object',
        properties: {
          c: { 'x-uid': `${prefix}-n3` },
        },
      },
      d: { 'x-uid': `${prefix}-n4` },
    },
  });

  test('insert action', async () => {
    const schema = createSchema('insert-action');
    const response = await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    expect(response.statusCode).toEqual(200);
  });

  test('getJsonSchema with async node', async () => {
    const schema = createSchema('async-node');
    schema.properties.b['x-async'] = true;

    await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    let response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
    });

    expect(response.body.data.properties.b).toBeUndefined();

    response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
      includeAsyncNode: true,
    });

    expect(response.body.data.properties.b).toBeDefined();
  });

  test('getJsonSchema', async () => {
    const schema = createSchema('get-json-schema');
    await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    const response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
    });

    const { data } = response.body;
    expect(data.properties.b.properties.c['x-uid']).toEqual('get-json-schema-n3');
  });

  test('getJsonSchema when uid not exists', async () => {
    const response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: 'not-exists',
    });

    expect(response.statusCode).toEqual(200);
  });

  test('get properties when uid not exists', async () => {
    const response = await app.agent().resource('uiSchemas').getProperties({
      resourceIndex: 'not-exists',
    });

    expect(response.statusCode).toEqual(200);
  });

  test('remove', async () => {
    const schema = createSchema('remove');
    await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    let response = await app.agent().resource('uiSchemas').remove({
      resourceIndex: 'remove-n2',
    });

    expect(response.statusCode).toEqual(200);

    response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
    });

    const { data } = response.body;
    expect(data.properties.b).not.toBeDefined();
  });

  test('patch', async () => {
    const schema = createSchema('patch');
    await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    let response = await app
      .agent()
      .resource('uiSchemas')
      .patch({
        values: {
          'x-uid': schema['x-uid'],
          properties: {
            b: {
              properties: {
                c: {
                  title: 'c-title',
                },
              },
            },
          },
        },
      });

    expect(response.statusCode).toEqual(200);
    response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
    });

    const { data } = response.body;
    expect(data.properties.b['properties']['c']['title']).toEqual('c-title');
  });

  test('insert adjacent', async () => {
    const schema = createSchema('insert-adjacent');
    await app.agent().resource('uiSchemas').insert({
      values: schema,
    });

    let response = await app
      .agent()
      .resource('uiSchemas')
      .insertAdjacent({
        resourceIndex: 'insert-adjacent-n2',
        position: 'beforeBegin',
        values: {
          'x-uid': 'insert-adjacent-n5',
          name: 'e',
        },
      });

    expect(response.statusCode).toEqual(200);
    response = await app.agent().resource('uiSchemas').getJsonSchema({
      resourceIndex: schema['x-uid'],
    });

    const { data } = response.body;
    expect(data.properties.e['x-uid']).toEqual('insert-adjacent-n5');
  });

  test('insert adjacent with bit schema', async () => {
    const schema = (await import('./fixtures/data')).default;
    const rootUid = 'insert-big-root';
    const aUid = 'insert-big-A';

    await app
      .agent()
      .resource('uiSchemas')
      .insert({
        values: {
          'x-uid': rootUid,
          properties: {
            A: {
              'x-uid': aUid,
            },
            B: {
              'x-uid': 'insert-big-B',
            },
          },
        },
      });

    const response = await app.agent().resource('uiSchemas').insertAdjacent({
      resourceIndex: aUid,
      position: 'afterEnd',
      values: schema,
    });

    expect(response.statusCode).toEqual(200);
  });
});
