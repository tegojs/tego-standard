/**
 * Provides the normalize actor user id helper for this module.
 */
export function normalizeActorUserId(actorUserId: unknown) {
  return actorUserId == null ? null : String(actorUserId);
}

/**
 * Provides the normalize audit log values helper for this module.
 */
export function normalizeAuditLogValues<T extends Record<string, unknown>>(values: T): T {
  return {
    ...values,
    actorUserId: normalizeActorUserId(values.actorUserId),
  } as T;
}
