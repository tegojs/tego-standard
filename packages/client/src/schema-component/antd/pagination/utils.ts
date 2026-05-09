type PaginationLike = {
  defaultPageSize?: number;
  pageSize?: number;
  showLessItems?: boolean;
  showQuickJumper?: unknown;
  simple?: unknown;
  total?: number;
};

const DEFAULT_PAGE_SIZE = 10;

const getPageBufferSize = (showLessItems?: boolean) => {
  return showLessItems ? 1 : 2;
};

const getQuickJumperAutoThreshold = (showLessItems?: boolean) => {
  return getPageBufferSize(showLessItems) * 2 + 3;
};

export const getPaginationPageCount = (pagination?: PaginationLike) => {
  if (!pagination) {
    return 0;
  }

  const total = Number(pagination.total);
  const pageSize = Number(pagination.pageSize || pagination.defaultPageSize || DEFAULT_PAGE_SIZE);

  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(pageSize) || pageSize <= 0) {
    return 0;
  }

  return Math.ceil(total / pageSize);
};

export const shouldAutoEnableQuickJumper = (pagination?: PaginationLike) => {
  if (!pagination || pagination.showQuickJumper !== undefined || pagination.simple) {
    return false;
  }

  return getPaginationPageCount(pagination) > getQuickJumperAutoThreshold(pagination.showLessItems);
};

export const withAutoQuickJumper = <T extends PaginationLike | false | undefined>(pagination: T): T => {
  if (!pagination || pagination === false || !shouldAutoEnableQuickJumper(pagination)) {
    return pagination;
  }

  return {
    ...pagination,
    showQuickJumper: true,
  } as T;
};
