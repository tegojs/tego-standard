import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'roles',
  fields: [
    {
      name: 'menuShareUiSchemas',
      type: 'belongsToMany',
      interface: null,
      collectionName: 'roles',
      parentKey: null,
      reverseKey: null,
      uiSchemaUid: null,
      uiSchema: {},
      target: 'uiSchemas',
      targetKey: 'x-uid',
      foreignKey: 'roleName',
      sourceKey: 'name',
      otherKey: 'uiSchemaXUid',
      through: 'rolesShareUischemas',
    },
  ],
});
