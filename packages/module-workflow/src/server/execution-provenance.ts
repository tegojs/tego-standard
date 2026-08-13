export const EVENT_SOURCE_EXECUTION_ORIGIN = 'event-source' as const;

export type WorkflowExecutionOrigin = typeof EVENT_SOURCE_EXECUTION_ORIGIN;

const EXECUTION_ORIGIN_CAPABILITY = Symbol('workflow-execution-origin');

type WorkflowExecutionOptions = Record<PropertyKey, any>;

/** Marks a workflow invocation as originating from the server-side event-source subsystem. */
export function markEventSourceWorkflowExecution<T extends WorkflowExecutionOptions>(options: T): T {
  return {
    ...options,
    [EXECUTION_ORIGIN_CAPABILITY]: EVENT_SOURCE_EXECUTION_ORIGIN,
  };
}

/** Resolves provenance only from the private in-process capability. */
export function getWorkflowExecutionOrigin(options: unknown): WorkflowExecutionOrigin | null {
  if (
    options &&
    typeof options === 'object' &&
    (options as WorkflowExecutionOptions)[EXECUTION_ORIGIN_CAPABILITY] === EVENT_SOURCE_EXECUTION_ORIGIN
  ) {
    return EVENT_SOURCE_EXECUTION_ORIGIN;
  }
  return null;
}

/** Restores the private capability from server-owned execution metadata. */
export function restoreWorkflowExecutionProvenance<T extends WorkflowExecutionOptions>(execution: any, options: T): T {
  const origin = execution?.get?.('executionOrigin') ?? execution?.executionOrigin;
  if (origin !== EVENT_SOURCE_EXECUTION_ORIGIN) {
    return options;
  }
  return markEventSourceWorkflowExecution(options);
}
