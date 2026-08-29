/**
 * Runs `worker` over `items`, at most `limit` at a time.
 *
 * Spec §7.7 asks for "p-limit (~5 concurrent)" on the WhatsApp send path. That
 * package is ESM-only from v7, and this is a CommonJS NestJS build, so pulling
 * it in would mean interop shims around fifteen lines of logic. Written here
 * instead — a new dependency is permanent maintenance and supply-chain
 * surface, and this one would not have earned it.
 *
 * Never rejects: a worker that throws is reported in its own result slot, so
 * one failed message cannot abandon the rest of the batch mid-send. Results
 * come back in input order regardless of completion order, so a caller can
 * line them up against what it passed in.
 */
export type Settled<T> =
  { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

export async function withConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<Array<Settled<TResult>>> {
  if (limit < 1) {
    throw new RangeError('Concurrency limit must be at least 1');
  }

  const results = new Array<Settled<TResult>>(items.length);
  let nextIndex = 0;

  // Each runner pulls the next unclaimed index rather than taking a fixed
  // slice, so one slow item does not idle a whole lane.
  const runner = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runner),
  );
  return results;
}
