/** Internal diagnostics; entry adapters translate these codes before displaying them. */
export class AccessMutationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_ACCESS_MUTATION'
      | 'UNSUPPORTED_ACCESS_MUTATION'
      | 'ACCESS_RECORD_UNAVAILABLE'
      | 'ACCESS_OWNERSHIP_CHANGE_FORBIDDEN'
      | 'LEGACY_DATA_READ_ONLY'
      | 'ACCESS_MUTATION_CONFLICT',
    message: string,
    public readonly status = 403,
  ) {
    super(message);
    this.name = 'AccessMutationError';
  }
}
