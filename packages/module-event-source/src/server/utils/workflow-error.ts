export function formatWorkflowError(result: unknown): string {
  if (result instanceof Error) {
    return result.message;
  }
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object') {
    const message = (result as { message?: unknown }).message;
    if (typeof message === 'string' && message) {
      return message;
    }
    try {
      return JSON.stringify(result) ?? Object.prototype.toString.call(result);
    } catch {
      return Object.prototype.toString.call(result);
    }
  }
  return String(result ?? 'Workflow execution failed');
}
