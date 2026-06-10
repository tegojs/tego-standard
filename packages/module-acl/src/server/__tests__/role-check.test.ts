import { CollectionRepository } from '@tachybase/module-collection';
import { MockServer } from '@tachybase/test';
import { Database } from '@tego/server';

import { prepareApp } from './prepare';

describe('role check action', () => {
  let app: MockServer;
  let db: Database;

  beforeAll(async () => {
    app = await prepareApp();
    db = app.db;
  });

  afterAll(async () => {
    await app.destroy();
  });

  it('should return role info', async () => {
    const roleName = 'role-check-info';
    const role = await db.getRepository('roles').create({
      values: {
        name: roleName,
      },
    });

    await role.createMenuUiSchema({
      values: {
        name: roleName,
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    const agent = app.agent().login(user);

    // @ts-ignore
    const response = await agent.resource('roles').check();

    expect(response.statusCode).toEqual(200);
  });

  it('should return updated roles info', async () => {
    const roleName = 'role-check-updated';
    const collectionName = 'roleCheckC1';
    const collectionManager = db.getRepository('collections') as CollectionRepository;
    await collectionManager.create({
      values: {
        name: collectionName,
        title: 'table1',
      },
      context: {},
    });

    await collectionManager.create({
      values: {
        name: 'roleCheckC2',
        title: 'table2',
      },
      context: {},
    });

    await db.getRepository('roles').create({
      values: {
        name: roleName,
        resources: [
          {
            name: collectionName,
            actions: [
              {
                name: 'create',
              },
            ],
          },
        ],
      },
    });

    const user = await db.getRepository('users').create({
      values: {
        roles: [roleName],
      },
    });

    const agent: any = app.agent().login(user);

    const checkResp1 = await agent.resource('roles').check();
    const actions = checkResp1.body.data.actions;
    expect(actions[`${collectionName}:create`]).toBeDefined();

    // update role
    await db.getRepository('roles').update({
      filter: {
        name: roleName,
      },
      values: {
        resources: [
          {
            name: collectionName,
            actions: [
              {
                name: 'create',
              },
              {
                name: 'update',
              },
            ],
          },
        ],
      },
    });

    const checkResp2 = await agent.resource('roles').check();
    const actions2 = checkResp2.body.data.actions;
    expect(actions2[`${collectionName}:create`]).toBeDefined();
    expect(actions2[`${collectionName}:update`]).toBeDefined();
  });
});
