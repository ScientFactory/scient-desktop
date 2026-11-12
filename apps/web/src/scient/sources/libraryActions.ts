import type { EnvironmentId, ScientSourcesLibraryOrganizeAction } from "@t3tools/contracts";

import { organizeScientSources } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";

export type ProjectSourcesChange = Extract<
  ScientSourcesLibraryOrganizeAction,
  { action: "pin" | "unpin" }
>;

/**
 * The most changes the panel sends in one `change-pins` request (the route takes 20,000):
 * 19,000 in one took 36 s on a Windows runner, past the 15 s organize timeout (scale gate).
 */
const PIN_CHANGES_PER_REQUEST = 2_000;

/**
 * Adds sources to this project or removes them from it in one request; the Library keeps them.
 * A source already in (or already out of) the project counts as neither changed nor failed.
 */
export async function changeProjectSources(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly changes: ReadonlyArray<ProjectSourcesChange>;
}) {
  let changed = 0;
  let failed = 0;
  let error = null as string | null;
  const succeeded: ProjectSourcesChange[] = [];
  for (let start = 0; start < input.changes.length; start += PIN_CHANGES_PER_REQUEST) {
    const changes = input.changes.slice(start, start + PIN_CHANGES_PER_REQUEST);
    const result = await organizeScientSources(input.environmentId, {
      root: input.root,
      change: { action: "change-pins", changes },
    }).catch((cause: unknown) => {
      error ??= scientSourcesErrorMessage(cause, import.meta.env.DEV);
      return null;
    });
    for (const [index, change] of changes.entries()) {
      const outcome = result?.pinChanges?.[index]?.outcome;
      if (outcome === "pinned" || outcome === "unpinned") {
        changed += 1;
        succeeded.push(change);
      } else if (outcome !== "existing" && outcome !== "not-pinned") failed += 1;
    }
  }
  return { changed, failed, error, succeeded };
}

export type ProjectSourcesOutcome = Awaited<ReturnType<typeof changeProjectSources>>;

/** Snapshot rows whose unpin succeeded: only they are gone from this computer. */
export function removedSnapshotCount(
  records: ReadonlyArray<{
    readonly citationKey?: string | undefined;
    readonly fromSnapshot?: boolean | undefined;
  }>,
  outcome: ProjectSourcesOutcome,
): number {
  const removedKeys = new Set(
    outcome.succeeded.flatMap((change) => (change.action === "unpin" ? [change.citationKey] : [])),
  );
  return records.filter(
    (record) =>
      record.fromSnapshot === true &&
      record.citationKey !== undefined &&
      removedKeys.has(record.citationKey),
  ).length;
}

/** Every key this project cites the source under: two after it merged two sources it used. */
export const projectKeys = (record: {
  readonly citationKey?: string | undefined;
  readonly alsoCitedAs?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> =>
  record.citationKey ? [record.citationKey, ...(record.alsoCitedAs ?? [])] : [];

/** Sources with at least one key removed, so a source cited under two keys counts once. */
export function removedSourceCount(
  records: ReadonlyArray<Parameters<typeof projectKeys>[0]>,
  outcome: ProjectSourcesOutcome,
): number {
  const removedKeys = new Set(
    outcome.succeeded.flatMap((change) => (change.action === "unpin" ? [change.citationKey] : [])),
  );
  return records.filter((record) => projectKeys(record).some((key) => removedKeys.has(key))).length;
}
