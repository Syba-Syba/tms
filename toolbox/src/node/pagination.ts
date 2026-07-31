export interface PageRequest {
  page?: number;
  pageSize?: number;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export function toSkipTake({ page = 1, pageSize = 20 }: PageRequest, maxPageSize = 100) {
  const size = Math.min(Math.max(pageSize, 1), maxPageSize);
  const current = Math.max(page, 1);
  return { skip: (current - 1) * size, take: size, page: current, pageSize: size };
}

export const toPageResult = <T>(items: T[], total: number, page: number, pageSize: number): PageResult<T> => ({
  items,
  page,
  pageSize,
  total,
  pageCount: Math.ceil(total / pageSize),
});
