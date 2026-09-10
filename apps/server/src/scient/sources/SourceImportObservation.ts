export type SourceImportOutcome = "imported" | "skipped" | "failed";

/** No source IDs, paths, metadata or exception contents cross this boundary. */
export type SourceImportObserver = () => Promise<
  ((outcome: SourceImportOutcome) => Promise<void>) | undefined
>;

/** Observe one actual attempt without owning its execution, retry or persistence. */
export async function observeSourceImport<A>(
  observer: SourceImportObserver | undefined,
  run: () => Promise<A>,
  outcome: (result: A) => SourceImportOutcome,
): Promise<A> {
  if (!observer) return run();
  let complete: Awaited<ReturnType<SourceImportObserver>>;
  try {
    complete = await observer();
  } catch {
    // Analytics is optional; an observer must not prevent the import.
  }
  if (!complete) return run();
  const finish = async (result: SourceImportOutcome) => {
    try {
      await complete?.(result);
    } catch {
      // Never convert an analytics failure into an import failure.
    }
  };
  let result: A;
  try {
    result = await run();
  } catch (error) {
    await finish("failed");
    throw error;
  }
  try {
    await finish(outcome(result));
  } catch {
    // A classification defect is not a product failure either.
  }
  return result;
}
