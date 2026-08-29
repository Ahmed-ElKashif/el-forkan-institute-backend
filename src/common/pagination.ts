import { z } from 'zod';

// Spec §9: "Every list endpoint paginated with a hard `take` ceiling." The
// ceiling is enforced here rather than per-endpoint so a new list route
// cannot accidentally ship without one.
export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function toPrismaPage(query: PageQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

export function buildPage<T>(
  items: T[],
  total: number,
  query: PageQuery,
): Page<T> {
  return { items, total, page: query.page, pageSize: query.pageSize };
}
