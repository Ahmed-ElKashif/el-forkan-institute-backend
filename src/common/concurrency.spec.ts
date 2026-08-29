import { withConcurrency } from './concurrency';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const results = await withConcurrency([30, 10, 20], 3, async (ms) => {
      await delay(ms);
      return ms;
    });

    expect(
      results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
    ).toEqual([30, 10, 20]);
  });

  // The point of the limit: §7.7 caps the WhatsApp send at ~5 concurrent so a
  // section of 30 students does not open 30 sockets to Meta at once.
  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;

    await withConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      5,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await delay(5);
        running -= 1;
      },
    );

    expect(peak).toBe(5);
  });

  it('still processes every item', async () => {
    const seen: number[] = [];

    await withConcurrency(
      Array.from({ length: 17 }, (_, i) => i),
      4,
      async (n) => {
        seen.push(n);
        await delay(1);
      },
    );

    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 17 }, (_, i) => i),
    );
  });

  // "A loop bug in the last one messages real people" (§9). One failure must
  // not abandon the batch, and it must be reportable per message.
  it('reports a failure in its own slot without abandoning the batch', async () => {
    const results = await withConcurrency([1, 2, 3], 2, (n) =>
      n === 2 ? Promise.reject(new Error('send failed')) : Promise.resolve(n),
    );

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('never rejects, even when every worker throws', async () => {
    const results = await withConcurrency([1, 2], 2, () =>
      Promise.reject(new Error('all down')),
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it.each([
    ['an empty list', []],
    ['a single item', [1]],
  ])('handles %s', async (_label, items) => {
    const results = await withConcurrency(items, 5, (n) => Promise.resolve(n));

    expect(results).toHaveLength(items.length);
  });

  it('does not start more runners than there are items', async () => {
    // A limit far above the item count must not spin up idle lanes.
    const results = await withConcurrency([1], 100, (n) => Promise.resolve(n));

    expect(results).toEqual([{ status: 'fulfilled', value: 1 }]);
  });

  it('rejects a limit below one rather than hanging forever', async () => {
    await expect(
      withConcurrency([1], 0, (n) => Promise.resolve(n)),
    ).rejects.toThrow(RangeError);
  });
});
