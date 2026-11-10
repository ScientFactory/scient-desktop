/** Bound whole material operations, not individual reads that can retain buffers. */
export function createMaterialBudget(concurrency = 2, maxQueued = 64) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function withBudget<A>(operation: () => Promise<A>): Promise<A> {
    if (active >= concurrency) {
      if (queue.length >= maxQueued) throw new Error("PDF processing is busy. Try again shortly.");
      await new Promise<void>((resolve) => queue.push(resolve));
    } else active++;
    try {
      return await operation();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}
export const withMaterialBudget = createMaterialBudget();
