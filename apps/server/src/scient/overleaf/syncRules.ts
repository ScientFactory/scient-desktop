/**
 * The decisions of an Overleaf sync, as pure functions over file trees. No
 * Git, no filesystem, no clock. These are the rules that were explored
 * exhaustively as a model before any of this was written; each one names the
 * failure it prevents.
 *
 * A tree is a map from manuscript path to the Git blob id of the file there.
 */

export type FileTree = ReadonlyMap<string, string>;

/** A file that kept its identity while its path changed, on either side. */
export interface Rename {
  readonly from: string;
  readonly to: string;
}

export type ConflictOrigin = "merge" | "guard" | "interrupted";

export interface ConflictGroup {
  /** Every path this one decision covers, sorted. */
  readonly paths: ReadonlyArray<string>;
  /** Git's conflict types, or the planner's own reason. */
  readonly types: ReadonlyArray<string>;
  readonly origins: ReadonlyArray<ConflictOrigin>;
}

export type ConflictChoice = "mine" | "theirs" | "markers";

export type FileChange =
  | { readonly kind: "added" | "deleted" | "modified"; readonly path: string }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string };

export const changePaths = (change: FileChange): ReadonlyArray<string> =>
  change.kind === "renamed" ? [change.from, change.to] : [change.path];

/**
 * All paths of the files that `paths` belong to. A file keeps its identity
 * across a rename on either side, so everything decided "per file" is decided
 * for its old and new paths together. Deciding per path let a failed write to
 * a locally renamed file advance the base for its old name, and the next sync
 * removed a collaborator's edit.
 */
export function closeOverRenames(
  paths: Iterable<string>,
  renames: ReadonlyArray<Rename>,
): ReadonlyArray<string> {
  const out = new Set(paths);
  for (let grew = true; grew;) {
    grew = false;
    for (const rename of renames) {
      if (out.has(rename.from) !== out.has(rename.to)) {
        out.add(rename.from).add(rename.to);
        grew = true;
      }
    }
  }
  return [...out].sort();
}

/**
 * Files changed locally since the base that the merge would delete without
 * moving their content elsewhere. Git can do this with a clean exit when a
 * rename is half-applied; the planner turns each into a conflict instead of
 * trusting the merge.
 */
export function guardedPaths(input: {
  readonly base: FileTree;
  readonly local: FileTree;
  readonly merged: FileTree;
  /** Changes from `local` to `merged`. */
  readonly incoming: ReadonlyArray<FileChange>;
}): ReadonlyArray<string> {
  const movedAway = new Set(
    input.incoming.flatMap((change) => (change.kind === "renamed" ? [change.from] : [])),
  );
  return [...input.local.keys()]
    .filter(
      (path) =>
        input.local.get(path) !== input.base.get(path) &&
        !input.merged.has(path) &&
        !movedAway.has(path),
    )
    .sort();
}

/**
 * The conflicts of one plan as decisions: Git's records, the planner guard and
 * any group left interrupted by an earlier apply, widened to rename counterparts
 * and structural counterparts in all four trees. A file/folder choice includes
 * the folder's contents so restoring the file cannot leave children beneath it.
 */
export function conflictGroups(input: {
  readonly merge: ReadonlyArray<{ readonly type: string; readonly paths: ReadonlyArray<string> }>;
  readonly guarded: ReadonlyArray<string>;
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  readonly renames: ReadonlyArray<Rename>;
  readonly trees: {
    readonly base: FileTree;
    readonly local: FileTree;
    readonly remote: FileTree;
    readonly merged: FileTree;
  };
}): ReadonlyArray<ConflictGroup> {
  interface Draft {
    paths: Set<string>;
    types: Set<string>;
    origins: Set<ConflictOrigin>;
  }
  const seeds: Array<{ paths: ReadonlyArray<string>; type: string; origin: ConflictOrigin }> = [
    ...input.merge.map((record) => ({
      paths: record.paths,
      type: record.type,
      origin: "merge" as const,
    })),
    ...input.guarded.map((path) => ({
      paths: [path],
      type: "locally changed file would be removed",
      origin: "guard" as const,
    })),
    ...input.interrupted.map((paths) => ({
      paths,
      type: "interrupted earlier",
      origin: "interrupted" as const,
    })),
  ];
  const knownPaths = new Set([
    ...Object.values(input.trees).flatMap((tree) => [...tree.keys()]),
    ...seeds.flatMap((seed) => seed.paths),
    ...input.renames.flatMap((rename) => [rename.from, rename.to]),
  ]);
  const neighbors = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    for (const [from, to] of [
      [left, right],
      [right, left],
    ] as const) {
      const adjacent = neighbors.get(from) ?? new Set<string>();
      adjacent.add(to);
      neighbors.set(from, adjacent);
    }
  };
  for (const rename of input.renames) link(rename.from, rename.to);
  for (const path of knownPaths) {
    for (
      let separator = path.indexOf("/");
      separator !== -1;
      separator = path.indexOf("/", separator + 1)
    ) {
      const parent = path.slice(0, separator);
      if (knownPaths.has(parent)) link(parent, path);
    }
  }
  const closeOverPaths = (paths: ReadonlyArray<string>) => {
    const closed = new Set(paths);
    for (const path of closed) {
      for (const adjacent of neighbors.get(path) ?? []) closed.add(adjacent);
    }
    return [...closed];
  };
  const groups: Draft[] = [];
  for (const seed of seeds) {
    const paths = closeOverPaths(seed.paths);
    const touching = groups.filter((group) => paths.some((path) => group.paths.has(path)));
    const target = touching[0] ?? { paths: new Set(), types: new Set(), origins: new Set() };
    if (touching.length === 0) groups.push(target);
    for (const path of paths) target.paths.add(path);
    target.types.add(seed.type);
    target.origins.add(seed.origin);
    for (const other of touching.slice(1)) {
      for (const path of other.paths) target.paths.add(path);
      for (const type of other.types) target.types.add(type);
      for (const origin of other.origins) target.origins.add(origin);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups
    .map((group) => ({
      paths: [...group.paths].sort(),
      types: [...group.types].sort(),
      origins: [...group.origins].sort(),
    }))
    .sort((left, right) => (left.paths[0] ?? "").localeCompare(right.paths[0] ?? ""));
}

const MARKER_TYPES = new Set(["CONFLICT (contents)", "CONFLICT (add/add)"]);

/**
 * "Merge in editor" is offered only for a single text file whose only problem
 * is overlapping content, and only when the merge actually produced markers.
 */
export function canMergeInEditor(
  group: ConflictGroup,
  mergedHasMarkers: (path: string) => boolean,
): boolean {
  const [only] = group.paths;
  return (
    group.paths.length === 1 &&
    only !== undefined &&
    group.origins.every((origin) => origin === "merge") &&
    group.types.every((type) => MARKER_TYPES.has(type)) &&
    mergedHasMarkers(only)
  );
}

/**
 * The tree the user confirmed. "Keep mine" sets every path of the group to its
 * local state, "use Overleaf's" to its Overleaf state, absent included. One
 * rule for every conflict type.
 */
export function applyChoices(input: {
  readonly merged: FileTree;
  readonly local: FileTree;
  readonly remote: FileTree;
  readonly conflicts: ReadonlyArray<ConflictGroup>;
  readonly choices: ReadonlyArray<ConflictChoice>;
}): Map<string, string> {
  const out = new Map(input.merged);
  input.conflicts.forEach((group, index) => {
    const choice = input.choices[index];
    if (choice === undefined || choice === "markers") return;
    const side = choice === "mine" ? input.local : input.remote;
    for (const path of group.paths) {
      const oid = side.get(path);
      if (oid === undefined) out.delete(path);
      else out.set(path, oid);
    }
  });
  return out;
}

/**
 * Nothing is written if any file about to change no longer matches what was
 * captured. Returns the first such path.
 */
export function firstStaleFile(input: {
  readonly captured: FileTree;
  readonly target: FileTree;
  /** Current content id of a path in the folder, or `undefined` when absent. */
  readonly current: (path: string) => string | undefined;
}): string | null {
  for (const path of new Set([...input.captured.keys(), ...input.target.keys()])) {
    if (
      input.captured.get(path) !== input.target.get(path) &&
      input.current(path) !== input.captured.get(path)
    ) {
      return path;
    }
  }
  return null;
}

/**
 * Changes that succeed or fail together: everything that touches one file
 * identity or comes from one conflict decision. Applying them independently
 * let one decision land half-way, and the next sync published the opposite of
 * what the user chose.
 */
export function applyUnits(input: {
  readonly changes: ReadonlyArray<FileChange>;
  readonly renames: ReadonlyArray<Rename>;
  readonly conflicts: ReadonlyArray<ConflictGroup>;
}): ReadonlyArray<ReadonlyArray<number>> {
  const reach = input.changes.map((change) => {
    const paths = new Set(closeOverRenames(changePaths(change), input.renames));
    for (const group of input.conflicts) {
      if (group.paths.some((path) => paths.has(path)))
        for (const path of group.paths) paths.add(path);
    }
    return paths;
  });
  const units: number[][] = [];
  const unitReach: Array<Set<string>> = [];
  input.changes.forEach((_, index) => {
    const mine = reach[index] ?? new Set<string>();
    const touching = units
      .map((_, unitIndex) => unitIndex)
      .filter((unitIndex) => [...mine].some((path) => unitReach[unitIndex]?.has(path)));
    const target = touching[0];
    if (target === undefined) {
      units.push([index]);
      unitReach.push(new Set(mine));
      return;
    }
    units[target]?.push(index);
    for (const path of mine) unitReach[target]?.add(path);
    for (const other of touching.slice(1).toReversed()) {
      units[target]?.push(...(units[other] ?? []));
      for (const path of unitReach[other] ?? []) unitReach[target]?.add(path);
      units.splice(other, 1);
      unitReach.splice(other, 1);
    }
  });
  return units.map((unit) => [...unit].sort((left, right) => left - right));
}

export type UnitOutcome = "done" | "skipped" | "interrupted";

/**
 * A unit is done only if every part is. A unit that is partly on disk is
 * interrupted as a whole; one that left nothing behind is merely skipped.
 */
export function unitOutcome(parts: ReadonlyArray<UnitOutcome>): UnitOutcome {
  if (parts.every((part) => part === "done")) return "done";
  return parts.some((part) => part === "done" || part === "interrupted")
    ? "interrupted"
    : "skipped";
}

/**
 * The base after an apply. The folder has absorbed Overleaf's version of
 * every file whose unit completed, so those take Overleaf's entry. Files of
 * units that did not complete keep their old entry, across all their paths.
 */
export function advanceBase(input: {
  readonly before: FileTree;
  readonly remote: FileTree;
  /** Paths of the changes in every unit that did not complete. */
  readonly undonePaths: ReadonlyArray<string>;
  readonly renames: ReadonlyArray<Rename>;
}): Map<string, string> {
  const out = new Map(input.remote);
  for (const path of closeOverRenames(input.undonePaths, input.renames)) {
    const previous = input.before.get(path);
    if (previous === undefined) out.delete(path);
    else out.set(path, previous);
  }
  return out;
}

export type EarlierPublish =
  /** Overleaf holds, or held, exactly what was sent. The base becomes what was sent. */
  | "accepted"
  /** Nothing in Overleaf's history shows it. The review must say so. */
  | "not-established";

/**
 * What became of a publish whose response never arrived. Without this, an
 * accepted publish followed by a collaborator's revert was published again
 * over their revert.
 */
export function classifyEarlierPublish(input: {
  readonly sentTree: string;
  readonly sentCommit: string;
  readonly remoteHeadCommit: string;
  readonly remoteHeadTree: string;
  /** Trees of Overleaf's commits since the head the publish was built on. */
  readonly treesSince: ReadonlyArray<{ readonly commit: string; readonly tree: string }>;
}): EarlierPublish {
  if (input.remoteHeadCommit === input.sentCommit || input.remoteHeadTree === input.sentTree) {
    return "accepted";
  }
  return input.treesSince.some(
    (entry) => entry.commit === input.sentCommit || entry.tree === input.sentTree,
  )
    ? "accepted"
    : "not-established";
}

const CONFLICT_MARKER =
  /^(?:<{7,}(?:[ \t].*)?|>{7,}(?:[ \t].*)?|\|{7,}(?:[ \t].*)?|={7,}[ \t]*)\r?$/mu;

/**
 * Conservative publication guard: even a lone marker or separator needs attention.
 * The bare adapter emits standard markers; callers importing shorter configured
 * markers must supply that size as well. Longer markers are always detected.
 */
export function hasConflictMarkers(text: string, markerSize = 7): boolean {
  if (!Number.isSafeInteger(markerSize) || markerSize < 1) {
    throw new RangeError("A conflict marker size must be a positive integer.");
  }
  if (markerSize >= 7) return CONFLICT_MARKER.test(text);
  const remaining = new RegExp(
    `^(?:<{${markerSize},}(?:[ \\t].*)?|>{${markerSize},}(?:[ \\t].*)?|\\|{${markerSize},}(?:[ \\t].*)?|={${markerSize},}[ \\t]*)\\r?$`,
    "mu",
  );
  return remaining.test(text);
}
