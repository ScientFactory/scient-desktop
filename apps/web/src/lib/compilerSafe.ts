/**
 * React Compiler cannot compile `finally` or `throw` inside components and hooks. These helpers
 * keep that control flow in plain functions, which the compiler leaves alone.
 */

/** Runs `work`, then `cleanup` whether it finished or failed, and returns or rethrows its result. */
export async function andFinally<T>(work: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await work();
  } finally {
    cleanup();
  }
}

/** Throws an error with this message. */
export function fail(message: string): never {
  throw new Error(message);
}
