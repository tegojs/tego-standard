import type { ICollection, Transaction } from '@tego/server';

import type { IJob } from '.';
import { JOB_STATUS } from '../constants';
import { bindWorkflowDataOperationRequest } from '../data-operation-authority';
import { withWorkflowDataSourceTransaction } from '../helpers/tenant-context';
import type Plugin from '../Plugin';
import type Processor from '../Processor';
import type { FlowNodeModel } from '../types';
import { toJSON } from '../utils';

export interface WorkflowWriteRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly params: Record<string, unknown>;
  readonly context: ReturnType<Processor['getRepositoryContext']>;
  readonly transaction?: Transaction;
}

export type WorkflowCreateRequest = WorkflowWriteRequest;
export type WorkflowUpdateRequest = WorkflowWriteRequest;
export type WorkflowCreateResult = Record<string, unknown>;
export interface WorkflowUpdateResult {
  length: number;
  data: Record<string, unknown>[];
}
export type WorkflowCreateExecutor = (request: WorkflowCreateRequest) => Promise<WorkflowCreateResult>;
export type WorkflowUpdateExecutor = (request: WorkflowUpdateRequest) => Promise<WorkflowUpdateResult>;
/** Server-only synchronous selection; executors own the full write, response projection and authorization. */
export type WorkflowCreateResolver = (request: WorkflowCreateRequest) => WorkflowCreateExecutor | undefined;
export type WorkflowUpdateResolver = (request: WorkflowUpdateRequest) => WorkflowUpdateExecutor | undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Internal instruction bridge. Absent resolvers preserve the original attachment/transaction order. */
export async function runWorkflowWriteResolver(
  action: 'create' | 'update',
  workflow: Plugin,
  processor: Processor,
  node: FlowNodeModel,
  target: Omit<WorkflowWriteRequest, 'transaction'>,
  resolve: WorkflowCreateResolver | WorkflowUpdateResolver | undefined,
  runDefault: (transaction?: Transaction) => Promise<IJob>,
): Promise<IJob> {
  if (!resolve) return runDefault();
  return withWorkflowDataSourceTransaction(
    workflow,
    target.dataSourceName,
    processor.transaction,
    async (transaction) => {
      const request: WorkflowWriteRequest = Object.freeze({ ...target, transaction });
      bindWorkflowDataOperationRequest(request, action, processor, node);
      const execute = resolve(request);
      if (execute === undefined) return runDefault(transaction);
      if (typeof execute !== 'function') {
        await execute;
        throw new TypeError(`${action} resolver must select an executor or undefined`);
      }
      const result = toJSON(await execute(request));
      if (
        !record(result) ||
        (action === 'update' &&
          (typeof result.length !== 'number' ||
            !Number.isSafeInteger(result.length) ||
            result.length < 0 ||
            !Array.isArray(result.data) ||
            result.data.length > result.length ||
            !result.data.every(record)))
      )
        throw new TypeError(`Invalid ${action} executor result`);
      return { result, status: JOB_STATUS.RESOLVED };
    },
  );
}
