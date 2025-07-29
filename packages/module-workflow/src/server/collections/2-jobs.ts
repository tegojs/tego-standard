import { extendCollection } from '@tego/server';

export default extendCollection({
  name: 'jobs',
  fields: [
    {
      type: 'belongsToMany',
      name: 'users',
      through: 'users_jobs',
    },
    {
      type: 'hasMany',
      name: 'usersJobs',
      target: 'users_jobs',
      foreignKey: 'jobId',
      onDelete: 'CASCADE',
    },
  ],
});
