/** Preserve the existing delete planner contract while sharing the same policy for all writes. */
export {
  AccessWorkflowWriteTransactionPlanner as AccessWorkflowDestroyTransactionPlanner,
  workflowWriteTransactionOptions as workflowDestroyTransactionOptions,
  type AccessWorkflowWriteTransactionTarget as AccessWorkflowDestroyTransactionTarget,
} from './workflow-write-transaction';
