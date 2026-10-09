export function resolveNoticeSnapshot({ snapshot, collectionName }, context) {
  const data = context?.data;
  if (snapshot?.id == null || data?.id !== snapshot.id || context?.collectionName !== collectionName) {
    return snapshot;
  }

  return { ...data, ...snapshot };
}
