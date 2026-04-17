export const EVENT_SOURCE_COLLECTION = 'webhooks';
export const EVENT_SOURCE_REALTIME = process.env.EVENT_SOURCE_REALTIME === '0' ? false : true;
export const EVENT_SOURCE_QUEUE_COLLECTION = 'eventSourceQueueJobs';

export const EVENT_SOURCE_QUEUE_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED: 'failed',
  DEAD: 'dead',
} as const;
