// Outside components and hooks: the React Compiler does not compile `finally`,
// and skips the whole component when it meets one.
export async function settleAfter<T>(run: () => Promise<T>, settle: () => void): Promise<T> {
  try {
    return await run();
  } finally {
    settle();
  }
}
