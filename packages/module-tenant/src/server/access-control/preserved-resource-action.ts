const preserved = new WeakSet<object>();

/** Preserve the native association descriptor only during a selected, prepared request. */
export function preserveAccessResourceAction(ctx: object): () => void {
  preserved.add(ctx);
  return () => {
    preserved.delete(ctx);
  };
}

export function hasPreservedAccessResourceAction(ctx: object): boolean {
  return preserved.has(ctx);
}
