import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'eventSourceQueueJobs',
  dumpRules: {
    group: 'log',
  },
  createdAt: true,
  updatedAt: true,
  fields: [
    { name: 'sourceId', type: 'bigInt' },
    { name: 'stage', type: 'string' },
    { name: 'resourceName', type: 'string' },
    { name: 'actionName', type: 'string' },
    { name: 'workflowKey', type: 'string' },
    { name: 'payload', type: 'json' },
    { name: 'contextLite', type: 'json' },
    { name: 'status', type: 'string' },
    { name: 'attempt', type: 'integer' },
    { name: 'maxAttempts', type: 'integer' },
    { name: 'retryBackoffMs', type: 'integer' },
    { name: 'nextRunAt', type: 'date' },
    { name: 'lastError', type: 'text' },
    { name: 'lockedAt', type: 'date' },
    { name: 'lockedBy', type: 'string' },
  ],
});
