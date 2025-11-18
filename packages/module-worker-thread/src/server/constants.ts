export const WORKER_COUNT = ctx.tego.environment.getVariables().WORKER_COUNT
  ? +ctx.tego.environment.getVariables().WORKER_COUNT
  : 1;
export const WORKER_COUNT_MAX = ctx.tego.environment.getVariables().WORKER_COUNT_MAX
  ? +ctx.tego.environment.getVariables().WORKER_COUNT_MAX
  : 8;
// in second
export const WORKER_TIMEOUT = ctx.tego.environment.getVariables().WORKER_TIMEOUT
  ? +ctx.tego.environment.getVariables().WORKER_TIMEOUT
  : 1800;
export const WORKER_ERROR_RETRY = ctx.tego.environment.getVariables().WORKER_ERROR_RETRY
  ? +ctx.tego.environment.getVariables().WORKER_ERROR_RETRY
  : 3;
// sub account init worker count, default 0
export const WORKER_COUNT_SUB = ctx.tego.environment.getVariables().WORKER_COUNT_SUB
  ? +ctx.tego.environment.getVariables().WORKER_COUNT_SUB
  : 0;

export const WORKER_FILE = './worker';

// 子应用最大的工作线程数
export const WORKER_COUNT_MAX_SUB = ctx.tego.environment.getVariables().WORKER_COUNT_MAX_SUB
  ? +ctx.tego.environment.getVariables().WORKER_COUNT_MAX_SUB
  : 1;
