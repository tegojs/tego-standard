import { AsyncLocalStorage } from 'node:async_hooks';
import type { ICollection, Transaction } from '@tego/server';

import type Plugin from './Plugin';
import type Processor from './Processor';
import type { FlowNodeModel } from './types';

interface NodeExecution {
  processor: Processor;
  node: FlowNodeModel;
  active: boolean;
  requests: Set<object>;
}

interface DataOperationRequest {
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly context: object;
  readonly transaction?: Transaction;
}

const nodeExecutions = new AsyncLocalStorage<NodeExecution>();
const authorities = new WeakMap<object, { plugin: Plugin; authority: WorkflowDataOperationAuthority }>();

export interface WorkflowDataOperationAuthority {
  readonly actionName: 'list' | 'destroy';
  readonly dataSourceName: string;
  readonly collectionName: string;
  readonly collection: ICollection;
  readonly context: object;
  readonly transaction?: Transaction;
  readonly workflowId: string | number;
  readonly executionId: string | number;
  readonly nodeId: string | number;
  assertCurrent(): void;
}

function unavailable(): never {
  throw new TypeError('Workflow data operation authority is unavailable or has expired');
}

/** Internal Processor boundary, including nested and concurrent instruction execution. */
export function withWorkflowNodeExecution<T>(processor: Processor, node: FlowNodeModel, execute: () => T | Promise<T>) {
  const phase: NodeExecution = { processor, node, active: true, requests: new Set() };
  return nodeExecutions.run(phase, async () => {
    try {
      return await execute();
    } finally {
      phase.active = false;
      for (const request of phase.requests) authorities.delete(request);
      phase.requests.clear();
    }
  });
}

/** Internal built-in instruction boundary; direct instruction calls do not acquire runtime authority. */
export function bindWorkflowDataOperationRequest(
  request: DataOperationRequest,
  actionName: WorkflowDataOperationAuthority['actionName'],
  processor: Processor,
  node: FlowNodeModel,
): void {
  const phase = nodeExecutions.getStore();
  if (!phase) return;
  if (!phase.active || phase.processor !== processor || phase.node !== node || !Object.isFrozen(request)) unavailable();
  const execution = processor.execution;
  const plugin = processor.options.plugin;
  const workflowId = execution.workflowId;
  const executionId = execution.id;
  const nodeId = node.id;
  const { dataSourceName, collectionName, collection, context, transaction } = request;
  const assertCurrent = () => {
    if (
      !phase.active ||
      nodeExecutions.getStore() !== phase ||
      processor.execution !== execution ||
      processor.options.plugin !== plugin ||
      execution.workflowId !== workflowId ||
      execution.id !== executionId ||
      node.id !== nodeId ||
      node.workflowId !== workflowId ||
      plugin.app.dataSourceManager.dataSources.get(dataSourceName)?.collectionManager.getCollection(collectionName) !==
        collection
    )
      unavailable();
  };
  assertCurrent();
  const authority = Object.freeze({
    actionName,
    dataSourceName,
    collectionName,
    collection,
    context,
    transaction,
    workflowId,
    executionId,
    nodeId,
    assertCurrent,
  });
  authorities.set(request, { plugin, authority });
  phase.requests.add(request);
}

/**
 * Proof of the configured server operation, never a role ACL decision or a tenant data scope.
 * Only the original live executor request can be captured. Consumers must recheck before using it.
 */
export function captureWorkflowDataOperationAuthority(
  request: unknown,
  plugin: Plugin,
): WorkflowDataOperationAuthority {
  if (!request || typeof request !== 'object') return unavailable();
  const entry = authorities.get(request);
  if (!entry || entry.plugin !== plugin) return unavailable();
  entry.authority.assertCurrent();
  return entry.authority;
}
