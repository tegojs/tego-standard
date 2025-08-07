import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'roles',
  model: 'RoleModel',
  fields: [
    {
      name: 'ownerUser',
      type: 'belongsTo',
      target: 'users',
      targetKey: 'id',
      foreignKey: 'ownerUserId',
      index: true,
    },
  ],
});
