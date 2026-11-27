/** Internal errors. HTTP integration must translate them without discarding the status/code. */
export class AccessConfigError extends Error {
  constructor(
    public readonly code: 'ACCESS_CONFIG_CONFLICT' | 'ACCESS_COLLECTION_NOT_FOUND' | 'INVALID_ACCESS_CONFIG_WRITE',
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AccessConfigError';
  }
}
