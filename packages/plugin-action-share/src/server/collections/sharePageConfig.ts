import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'sharePageConfig',
  dumpRules: 'required',
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      allowNull: false,
      primaryKey: true,
    },
    {
      type: 'boolean',
      name: 'linkStatus',
    },
    {
      type: 'password',
      name: 'password',
    },
    {
      type: 'boolean',
      name: 'permanent',
    },
    {
      type: 'date',
      name: 'shareTime',
    },
    {
      type: 'string',
      name: 'permission',
    },
    {
      type: 'string',
      name: 'generateLink',
    },
    {
      type: 'jsonb',
      name: 'tabs',
    },
  ],
});
