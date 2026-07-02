export function normalizeActorUserId(actorUserId: unknown) {
  return actorUserId == null ? null : String(actorUserId);
}

export function normalizeAuditLogValues<T extends Record<string, unknown>>(values: T): T {
  return {
    ...values,
    actorUserId: normalizeActorUserId(values.actorUserId),
  } as T;
}
