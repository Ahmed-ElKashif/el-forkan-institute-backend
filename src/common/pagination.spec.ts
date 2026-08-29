import { MAX_PAGE_SIZE, PageQuerySchema, toPrismaPage } from './pagination';

describe('PageQuerySchema', () => {
  it('defaults to the first page when the query string is empty', () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  // Spec §9 requires a hard ceiling: without it, `?pageSize=100000` is a
  // one-request export of the entire student body.
  it('rejects a page size above the ceiling instead of clamping it', () => {
    expect(() =>
      PageQuerySchema.parse({ pageSize: MAX_PAGE_SIZE + 1 }),
    ).toThrow();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s page number', (_label, page) => {
    expect(() => PageQuerySchema.parse({ page })).toThrow();
  });
});

describe('toPrismaPage', () => {
  // Off-by-one boundary: page 1 must skip nothing, page 2 must skip exactly
  // one page's worth.
  it.each([
    [1, 25, 0],
    [2, 25, 25],
    [3, 10, 20],
  ])('page %i of size %i skips %i rows', (page, pageSize, expectedSkip) => {
    expect(toPrismaPage({ page, pageSize })).toEqual({
      skip: expectedSkip,
      take: pageSize,
    });
  });
});
