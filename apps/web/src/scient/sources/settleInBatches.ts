/** Requests sent together; the server takes them one at a time under its Library lock. */
const BATCH_SIZE = 4;

/** Runs `work` on every item, a few at a time, and settles each: none is dropped on a failure. */
export async function settleInBatches<A, B>(
  items: ReadonlyArray<A>,
  work: (item: A) => Promise<B>,
): Promise<ReadonlyArray<PromiseSettledResult<B>>> {
  const settled: PromiseSettledResult<B>[] = [];
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    settled.push(...(await Promise.allSettled(items.slice(start, start + BATCH_SIZE).map(work))));
  }
  return settled;
}
