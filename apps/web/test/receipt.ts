/** A test deadline aborts its signal; it does not unwind a suspended await using. */
export async function waitForTestReceipt<T>(
  signal: AbortSignal,
  receipt: Promise<T>,
  dispose?: () => void,
): Promise<T> {
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const value = await Promise.race([receipt, cancelled.promise]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
    dispose?.();
  }
}
