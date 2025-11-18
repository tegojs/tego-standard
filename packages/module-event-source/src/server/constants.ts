export const EVENT_SOURCE_COLLECTION = 'webhooks';
export const EVENT_SOURCE_REALTIME = ctx.tego.environment.getVariables().EVENT_SOURCE_REALTIME === '0' ? false : true;
