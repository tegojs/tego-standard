import { defineCollection } from '@tego/server';

// 审批-待办
export default defineCollection({
  namespace: 'workflow.approvalRecords',
  dumpRules: 'required',
  name: 'approvalRecords',
  createdBy: true,
  fields: [
    {
      type: 'string',
      name: 'collectionName',
    },
    {
      type: 'belongsTo',
      name: 'approval',
    },
    {
      type: 'belongsTo',
      name: 'approvalExecution',
    },
    {
      type: 'belongsTo',
      name: 'user',
      target: 'users',
    },
    {
      type: 'belongsTo',
      name: 'job',
      target: 'jobs',
    },
    {
      type: 'belongsTo',
      name: 'execution',
    },
    {
      type: 'belongsTo',
      name: 'node',
      target: 'flow_nodes',
    },
    {
      type: 'belongsTo',
      name: 'workflow',
    },
    {
      type: 'string',
      name: 'index',
    },
    {
      type: 'integer',
      name: 'status',
    },
    {
      type: 'jsonb',
      name: 'snapshot',
      defaultValue: {},
    },
    {
      type: 'jsonb',
      name: 'summary',
      defaultValue: {},
    },
    {
      type: 'text',
      name: 'comment',
    },
  ],
});
