import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { isHostedStaticApp } from "../../hostedPairing";
import { environmentShell } from "../../state/shell";

/**
 * Environments whose thread list this client holds: a live shell snapshot.
 * A connected transport alone is not enough, since the snapshot loads after
 * it (and can fail to sync while the connection stays up). Joined into a
 * sorted key so consumers only re-render when the set changes.
 */
export const loadedThreadEnvironmentsKeyAtom = Atom.make((get): string => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const loaded: string[] = [];
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) loaded.push(environmentId);
  }
  return loaded.toSorted().join("\n");
}).pipe(Atom.withLabel("scient-sections-loaded-thread-environments"));

/**
 * Enabled environments without a live thread list, whose placement holds its last known
 * state, as a sorted key. Null until the catalog lists every environment: the persisted
 * catalog can emit before platform discovery registers the primary, and before then a
 * missing environment is not known to be one that is offline.
 */
export const frozenPlacementEnvironmentsKeyAtom = Atom.make((get): string | null => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady || catalog.entries.size === 0) return null;
  const hasPrimary = Array.from(catalog.entries.values()).some(
    (entry) => entry.target._tag === "PrimaryConnectionTarget",
  );
  if (!hasPrimary && !isHostedStaticApp()) return null;
  const loaded = new Set(get(loadedThreadEnvironmentsKeyAtom).split("\n"));
  return Array.from(enabledEnvironmentIds(catalog))
    .filter((environmentId) => !loaded.has(environmentId))
    .toSorted()
    .join("\n");
}).pipe(Atom.withLabel("scient-sections-frozen-placement-environments"));

/** What a shell snapshot says about the older settled threads it left out. */
type OmittedThreads = {
  readonly counts: ReadonlyArray<{ readonly count: number }>;
  /** Per section, the left-out threads it holds; absent from servers that do not count them. */
  readonly sectionCounts?: ReadonlyArray<{ readonly sectionId: string; readonly count: number }>;
};

/** Marks an environment whose shell left threads out without naming their sections. */
export const UNKNOWN_OMITTED_SECTIONS = "*";

/**
 * `${environmentId}\t${sectionId}` lines for the sections that hold threads a shell left out, or
 * `${environmentId}\t*` when the shell left threads out but did not name their sections.
 */
function omittedSectionLines(environmentId: string, omitted: OmittedThreads | undefined): string[] {
  if (omitted === undefined || omitted.counts.every(({ count }) => count === 0)) return [];
  if (omitted.sectionCounts === undefined) {
    return [`${environmentId}\t${UNKNOWN_OMITTED_SECTIONS}`];
  }
  return omitted.sectionCounts.flatMap(({ sectionId, count }) =>
    count > 0 ? [`${environmentId}\t${sectionId}`] : [],
  );
}

/**
 * Sections occupied by threads the live shells left out (older settled threads), as sorted
 * `omittedSectionLines`. The loaded threads alone cannot show that such a section is empty.
 */
export const omittedSectionsKeyAtom = Atom.make((get): string => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const lines: string[] = [];
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
    lines.push(...omittedSectionLines(environmentId, shell.snapshot.value.olderSettled));
  }
  return lines.toSorted().join("\n");
}).pipe(Atom.withLabel("scient-sections-omitted-sections"));
