const inFlightExports = new Map<string, Promise<unknown>>();

/** One renderer/publication operation per logical document at a time. */
export function runBrowserPdfExport<T>(key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlightExports.get(key);
  if (existing) return existing as Promise<T>;

  const started = task().finally(() => {
    if (inFlightExports.get(key) === started) inFlightExports.delete(key);
  });
  inFlightExports.set(key, started);
  return started;
}
