export function hasExecutionContext(workflow: any, execution: any, nodes: any): boolean {
  return Boolean(workflow?.type && execution && Array.isArray(nodes));
}
