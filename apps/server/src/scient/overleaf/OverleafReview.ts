// @effect-diagnostics nodeBuiltinImport:off -- Captured bytes are staged in a private folder for Git.
/**
 * Reviews write/send nothing. Different inputs or choices must produce a new immutable
 * review/digest so confirmation cannot authorize a changed applier plan.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import type { OverleafConnectionDocument } from "./OverleafConnectionState.ts";
import { newOverleafId } from "./OverleafGitExecutor.ts";
import {
  isOverleafLfsPointer,
  isOverleafRepositoryShape,
  OVERLEAF_LIMITS,
  overleafPathExclusion,
  type OverleafAddition,
  type OverleafInventory,
  type OverleafLimits,
} from "./OverleafInventory.ts";
import {
  OverleafRepository,
  OverleafRepositoryError,
  type TreeChange,
} from "./OverleafRepository.ts";
import {
  applyChoices,
  canMergeInEditor,
  type ConflictChoice,
  type ConflictGroup,
  conflictGroups,
  type FileTree,
  guardedPaths,
  hasConflictMarkers,
  type Rename,
} from "./syncRules.ts";
import { manuscriptCollisionKey } from "./unicodeCaseFold.ts";
import type { WorkspaceApplyPlan } from "./WorkspaceApplier.ts";

export type OverleafReviewWarning =
  /** The connection has never completed a sync. Overleaf advises against mixing Git and its editor. */
  | { readonly kind: "first-sync" }
  /** No sync history while the folder already has files: one-sided files are additions, not deletions. */
  | { readonly kind: "no-sync-history" }
  /** Overleaf treats a Git rename as delete-and-create and drops comments and tracked changes. */
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  /** An outgoing file equals one of its last synced versions: a checkpoint restore or branch switch. */
  | { readonly kind: "restores-older-version"; readonly path: string }
  | { readonly kind: "over-recommended-size"; readonly bytes: number }
  | { readonly kind: "too-large-to-edit"; readonly path: string; readonly bytes: number }
  | { readonly kind: "editable-total-exceeded"; readonly bytes: number }
  /**
   * An earlier send's outcome is unknown: Overleaf may hold it, so this sync could
   * repeat or overwrite its changes.
   */
  | {
      readonly kind: "unresolved-publication";
      readonly attemptNumber: number;
      readonly candidateCommit: string;
    };

/** Warnings the user must acknowledge by confirming this exact review. */
const ACKNOWLEDGED: ReadonlySet<OverleafReviewWarning["kind"]> = new Set([
  "first-sync",
  "no-sync-history",
  "rename",
  "restores-older-version",
  "unresolved-publication",
]);

export interface OverleafReviewConflict extends ConflictGroup {
  /** Stable across reviews while the group's paths are the same. */
  readonly key: string;
  readonly allowed: ReadonlyArray<ConflictChoice>;
  readonly chosen: ConflictChoice | null;
}

/** Everything a confirmation must still match. Its digest is the review's identity. */
export interface OverleafReviewBinding {
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly baseGeneration: number;
  readonly baseTree: string | null;
  readonly checkoutEpoch: number;
  readonly credentialEpoch: number;
  readonly authority: OverleafConnectionDocument["binding"];
  readonly folderIdentity: OverleafConnectionDocument["folder"]["identity"];
  readonly localTree: string;
  readonly remoteCommit: string;
  readonly remoteTree: string;
  readonly selectedAdditions: ReadonlyArray<string>;
  /** Additions sent by default that this review leaves out: kept only on this computer on purpose. */
  readonly newLocalOnly: ReadonlyArray<string>;
  /** Local-only files this review sends; they leave the local-only list and become managed. */
  readonly sentLocalOnly: ReadonlyArray<string>;
  /**
   * The requests to keep files only here and to send files. `keepOnlyHere`
   * also holds every deliberate deselection, including one an explicit list
   * implied; `send` also holds every `sendLocalOnly` request. A replacement review applies them again to its own capture, so a
   * file that comes and goes, or changes size, keeps the decision made for it.
   */
  readonly keepOnlyHere: ReadonlyArray<string>;
  readonly send: ReadonlyArray<string>;
  /** Never-synchronized local files captured because Overleaf has content at their place. */
  readonly collisionPaths: ReadonlyArray<string>;
  readonly choices: ReadonlyArray<readonly [string, ConflictChoice]>;
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  /** Conflict material recorded before this review, and which of it is still unresolved. */
  readonly recordedMarkerPaths: ReadonlyArray<string>;
  readonly unresolvedMarkers: ReadonlyArray<string>;
  readonly candidateTree: string;
  readonly conflictKeys: ReadonlyArray<string>;
  /** Files where this review's plan writes new conflict material. */
  readonly markerPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<OverleafReviewWarning>;
  readonly acknowledgements: ReadonlyArray<OverleafReviewWarning["kind"]>;
}

export interface OverleafReview {
  /** Server-generated; never supplied by a request. */
  readonly id: string;
  readonly digest: string;
  readonly binding: OverleafReviewBinding;
  /** Changes to the folder: from the captured state to the candidate. */
  readonly incoming: ReadonlyArray<TreeChange>;
  /** Changes to Overleaf: from its fetched state to the candidate. */
  readonly outgoing: ReadonlyArray<TreeChange>;
  readonly conflicts: ReadonlyArray<OverleafReviewConflict>;
  readonly warnings: ReadonlyArray<OverleafReviewWarning>;
  /** Recorded Scient conflict material still present; outgoing publication waits for it. */
  readonly unresolvedMarkers: ReadonlyArray<string>;
  /** Every conflict has an allowed choice. */
  readonly confirmable: boolean;
  /** Nothing to change on either side. */
  readonly upToDate: boolean;
  /** Local files kept because Overleaf has content at their place (contract A30). */
  readonly collisions: ReadonlyArray<string>;
  /**
   * Every new file in the folder, whether this review sends it, and why it is
   * left out by default (pr-c-design section 5). The app and the agent tools
   * confirm this selection as it is unless someone changes it.
   */
  readonly additions: ReadonlyArray<OverleafAddition & { readonly selected: boolean }>;
  /** Files kept only on this computer that stay there; selections can send them. */
  readonly localOnly: ReadonlyArray<string>;
  /** Bytes held by `applyPlan.target`, for bounding how many reviews are kept. */
  readonly targetBytes: number;
  readonly applyPlan: WorkspaceApplyPlan;
}

export type OverleafReviewRefusal =
  | { readonly reason: "remote-file-limit" }
  | { readonly reason: "remote-too-large" }
  | { readonly reason: "remote-file-too-large"; readonly path: string }
  /**
   * Overleaf has content the folder could never hold: a dropping, a reserved name,
   * an LFS pointer, or files that would make `path`, a folder, a Git repository.
   */
  | {
      readonly reason: "remote-forbidden";
      readonly path: string;
      readonly kind:
        | "reserved"
        | "dropping"
        | "staging"
        | "invalid-path"
        | "lfs-pointer"
        | "repository";
    }
  /** Two paths differ only by letter case or Unicode form; one would silently replace the other. */
  | { readonly reason: "path-alias"; readonly first: string; readonly second: string }
  /**
   * Applying would check `path`, which on disk is `onDisk`: an unchecked, local-only or
   * skipped entry, or something inside one, that this review never read. Check it,
   * move it, or rename it on Overleaf.
   */
  | { readonly reason: "unreviewed-path"; readonly path: string; readonly onDisk: string }
  /**
   * A file's name changed by letter case or Unicode form alone since the last
   * synchronization (`from` was synchronized, `to` is the new spelling), whether or not
   * Git saw a rename. Undo it, or rename through another name with a synchronization
   * in between.
   */
  | { readonly reason: "alias-rename"; readonly from: string; readonly to: string }
  | { readonly reason: "candidate-file-limit" }
  | { readonly reason: "candidate-too-large" }
  | { readonly reason: "candidate-file-too-large"; readonly path: string }
  /** More local-only paths than a connection can remember; choose a narrower folder. */
  | { readonly reason: "local-only-limit" }
  /** Overleaf has content where the folder has something never synchronized (a link, repository, dropping). */
  | { readonly reason: "remote-collides-with-excluded"; readonly path: string };

export interface OverleafReviewInput {
  readonly repo: string;
  readonly connection: OverleafConnectionDocument;
  readonly inventory: OverleafInventory;
  readonly remote: { readonly commit: string; readonly tree: string };
  /** Paths the inventory read in full because of an earlier `needs-capture`. */
  readonly collisionPaths: ReadonlyArray<string>;
  /** The `keepOnlyHere` and `send` requests the inventory applied, recorded in the binding. */
  readonly requests?: {
    readonly keepOnlyHere: ReadonlyArray<string>;
    readonly send: ReadonlyArray<string>;
  };
  /** Choices by conflict key. Keys of groups that no longer exist are ignored. */
  readonly choices: ReadonlyMap<string, ConflictChoice>;
  /** File identities an earlier apply left interrupted: forced conflicts. */
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  /** Files where Scient wrote conflict material that has not been resolved yet. */
  readonly markerPaths: ReadonlyArray<string>;
  readonly epochs: { readonly checkout: number; readonly credential: number };
  /** Private folder for staging captured bytes as blobs; cleared afterwards. */
  readonly scratch: string;
  readonly limits?: Partial<OverleafLimits>;
}

export type OverleafReviewResult =
  | { readonly _tag: "review"; readonly review: OverleafReview }
  /**
   * Capture exactly these local paths in full (and no others as collisions)
   * and build the review again.
   */
  | { readonly _tag: "needs-capture"; readonly paths: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly refusal: OverleafReviewRefusal };

/** Code-unit order: the same on every machine, unlike locale-aware comparison. */
const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sorted = (paths: Iterable<string>) => [...paths].sort(byPath);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const ancestors = (path: string) => {
  const out: string[] = [];
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1))
    out.push(path.slice(0, cut));
  return out;
};
const toMap = (entries: ReadonlyArray<{ readonly path: string; readonly oid: string }>) =>
  new Map(entries.map((entry) => [entry.path, entry.oid] as const));
const renamesOf = (changes: ReadonlyArray<TreeChange>): Rename[] =>
  changes.flatMap((change) =>
    change.kind === "renamed" ? [{ from: change.from, to: change.to }] : [],
  );
/** A conflict's identity is its set of paths; a choice follows the group, not its position. */
export const overleafConflictKey = (paths: ReadonlyArray<string>) =>
  sha256(sorted(paths).join("\0"));
/** Editable on Overleaf means text; a NUL byte early on means it is stored as an upload. */
const looksLikeText = (bytes: Uint8Array) => !bytes.subarray(0, 8_000).includes(0);
/** LFS pointers are small by specification; larger blobs need no prefix check. */
const LFS_POINTER_MAX_BYTES = 1024;

/** JSON with object keys sorted at every level, so equal bindings always digest equally. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort(byPath)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
};
export const overleafReviewDigest = (binding: OverleafReviewBinding) =>
  sha256(canonicalJson(binding));

/**
 * Never-synchronized local files Overleaf has content at, under or above. They
 * must be captured and decided in the review, never treated as absent.
 */
function findCollisions(input: {
  readonly inventory: OverleafInventory;
  readonly remote: FileTree;
  /** Paths captured for an earlier `needs-capture`; still never-synchronized. */
  readonly collisionPaths: ReadonlySet<string>;
}) {
  const { inventory } = input;
  // A local-only file being sent is still never synchronized: Overleaf content at
  // its place makes it a reviewed collision, never a merge that could replace it.
  const sent = new Set(inventory.sentLocalOnly);
  const unsynced = new Set([
    ...inventory.localOnly,
    ...inventory.sentLocalOnly,
    ...inventory.additions.map((entry) => entry.path),
    ...input.collisionPaths,
  ]);
  const beneath = new Map<string, string[]>();
  for (const path of unsynced)
    for (const folder of ancestors(path))
      beneath.set(folder, [...(beneath.get(folder) ?? []), path]);
  const excluded = new Set(inventory.excluded.map((entry) => entry.path));
  const excludedBeneath = new Set(inventory.excluded.flatMap((entry) => ancestors(entry.path)));
  const capture = new Set<string>();
  /** For each captured local path, the Overleaf paths it meets. */
  const meets = new Map<string, Set<string>>();
  const meet = (local: string, remote: string) => {
    capture.add(local);
    meets.set(local, (meets.get(local) ?? new Set()).add(remote));
  };
  for (const path of input.remote.keys()) {
    if (inventory.captured.has(path) && !input.collisionPaths.has(path) && !sent.has(path))
      continue;
    if (
      excluded.has(path) ||
      excludedBeneath.has(path) ||
      ancestors(path).some((folder) => excluded.has(folder))
    )
      return { excluded: path, capture: [], groups: [] };
    if (unsynced.has(path)) meet(path, path);
    for (const below of beneath.get(path) ?? []) meet(below, path);
    for (const folder of ancestors(path)) if (unsynced.has(folder)) meet(folder, path);
  }
  return {
    excluded: null,
    capture: sorted(capture),
    groups: sorted(capture).map((local) => sorted([local, ...(meets.get(local) ?? [])])),
  };
}

/**
 * A folder that these paths together would make a Git repository, or null. The
 * inventory never walks into one already on disk, so one found here is made by
 * Overleaf's content; the file layer would refuse to write into it partway.
 */
function repositoryFolder(paths: Iterable<string>) {
  const children = new Map<string, Set<string>>();
  for (const path of paths) {
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      const parent = segments.slice(0, index).join("/");
      const names = children.get(parent) ?? new Set<string>();
      names.add(segment);
      children.set(parent, names);
    }
  }
  for (const [folder, names] of [...children].toSorted(([left], [right]) => byPath(left, right)))
    if (isOverleafRepositoryShape(names)) return folder === "" ? "." : folder;
  return null;
}

/**
 * Two whole paths, the first from `before` where either is, spelled differently by
 * letter case or Unicode form alone, or null. Folders are not compared: files in
 * folders spelled two ways are different files unless their whole paths collide.
 */
function respelling(before: Iterable<string>, after: Iterable<string>) {
  const seen = new Map<string, string>();
  for (const path of [...before, ...after]) {
    const key = manuscriptCollisionKey(path);
    const earlier = seen.get(key);
    if (earlier !== undefined && earlier !== path) return { from: earlier, to: path };
    seen.set(key, path);
  }
  return null;
}

/**
 * An applier check must address something the review read or found absent. Collision keys include
 * alternate spellings; unchecked/skipped paths cannot silently become readable reviewed inputs.
 */
function unreviewedOccupant(paths: Iterable<string>, inventory: OverleafInventory) {
  const unread = new Map<string, string>();
  for (const path of [
    ...inventory.additions.map((entry) => entry.path),
    ...inventory.localOnly,
    ...inventory.excluded.map((entry) => entry.path),
  ])
    if (!inventory.captured.has(path)) unread.set(manuscriptCollisionKey(path), path);
  const folders = new Map(inventory.folders.map((path) => [manuscriptCollisionKey(path), path]));
  const skipped = new Map(
    inventory.excluded.map((entry) => [manuscriptCollisionKey(entry.path), entry.path]),
  );
  for (const path of paths) {
    if (inventory.captured.has(path)) continue;
    const key = manuscriptCollisionKey(path);
    const file = unread.get(key);
    if (file !== undefined) return { path, onDisk: file };
    const folder = folders.get(key);
    if (folder !== undefined && folder !== path) return { path, onDisk: folder };
    for (const above of ancestors(path)) {
      const entry = skipped.get(manuscriptCollisionKey(above));
      if (entry !== undefined) return { path, onDisk: entry };
    }
  }
  return null;
}

/** Two different spellings of one path, by letter case or Unicode form, or null. */
function findAlias(paths: Iterable<string>) {
  const seen = new Map<string, string>();
  for (const path of paths) {
    for (const name of [...ancestors(path), path]) {
      const key = manuscriptCollisionKey(name);
      const earlier = seen.get(key);
      if (earlier !== undefined && earlier !== name)
        return earlier < name ? { first: earlier, second: name } : { first: name, second: earlier };
      seen.set(key, name);
    }
  }
  return null;
}

/**
 * Writes captured files as blobs and their tree. The bytes are staged first, so Git
 * stores exactly what was hashed, not a later read of the folder.
 */
export const writeCapturedTree = Effect.fn("OverleafReview.writeCapturedTree")(function* (input: {
  readonly repo: string;
  readonly captured: OverleafInventory["captured"];
  /** Private folder for the staged bytes; cleared afterwards. */
  readonly scratch: string;
}) {
  const repos = yield* OverleafRepository;
  const stage = NodePath.join(input.scratch, `capture-${newOverleafId()}`);
  const paths = sorted(input.captured.keys());
  const oids = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(stage, { recursive: true, mode: 0o700 });
        const files: string[] = [];
        for (const [index, path] of paths.entries()) {
          const file = NodePath.join(stage, String(index));
          await NodeFSP.writeFile(file, input.captured.get(path)!.bytes, { mode: 0o600 });
          files.push(file);
        }
        return files;
      },
      catch: (cause) =>
        new OverleafRepositoryError({
          reason: "git-failed",
          detail: "Could not stage captured files.",
          cause,
        }),
    }),
    (files) => repos.writeBlobsFromFiles({ repo: input.repo, files }),
    () => Effect.promise(() => NodeFSP.rm(stage, { recursive: true, force: true })),
  );
  const blobs = new Map(paths.map((path, index) => [path, oids[index]!] as const));
  const tree = yield* repos.writeTree({
    repo: input.repo,
    entries: paths.map((path) => ({ path, oid: blobs.get(path)! })),
  });
  return { blobs, tree };
});

export const buildOverleafReview = Effect.fn("OverleafReview.build")(function* (
  input: OverleafReviewInput,
) {
  const repos = yield* OverleafRepository;
  const limits: OverleafLimits = { ...OVERLEAF_LIMITS, ...input.limits };
  const { repo, connection, inventory } = input;
  const refused = (refusal: OverleafReviewRefusal): OverleafReviewResult => ({
    _tag: "refused",
    refusal,
  });

  // Overleaf's content is held to the same limits before any of it is read.
  const remoteSizes = yield* repos.treeSizes({ repo, tree: input.remote.tree });
  if (remoteSizes.size > limits.managedFiles) return refused({ reason: "remote-file-limit" });
  let remoteBytes = 0;
  for (const [path, size] of remoteSizes) {
    if (size > limits.fileBytes) return refused({ reason: "remote-file-too-large", path });
    remoteBytes += size;
  }
  if (remoteBytes > limits.totalBytes) return refused({ reason: "remote-too-large" });
  const remote = toMap(yield* repos.readTree({ repo, tree: input.remote.tree }));
  const baseTree = connection.base.tree ?? (yield* repos.writeTree({ repo, entries: [] }));
  const base = toMap(yield* repos.readTree({ repo, tree: baseTree }));

  // And to the same rules: nothing arrives that the folder's own inventory would refuse.
  for (const [path, oid] of remote) {
    const kind = overleafPathExclusion(path);
    if (kind !== null) return refused({ reason: "remote-forbidden", path, kind });
    // Content already in the base was checked when it first arrived.
    if (base.get(path) === oid || (remoteSizes.get(path) ?? 0) > LFS_POINTER_MAX_BYTES) continue;
    const prefix = yield* repos.readBlob({ repo, oid, maxBytes: LFS_POINTER_MAX_BYTES });
    if (isOverleafLfsPointer(prefix))
      return refused({ reason: "remote-forbidden", path, kind: "lfs-pointer" });
  }
  const repository = repositoryFolder([
    ...remote.keys(),
    ...inventory.captured.keys(),
    ...inventory.additions.map((entry) => entry.path),
    ...inventory.localOnly,
    ...inventory.folders,
    ...inventory.excluded.map((entry) => entry.path),
  ]);
  if (repository !== null)
    return refused({ reason: "remote-forbidden", path: repository, kind: "repository" });
  const alias = findAlias([
    ...inventory.captured.keys(),
    ...inventory.additions.map((entry) => entry.path),
    ...inventory.localOnly,
    ...inventory.folders,
    ...inventory.excluded.map((entry) => entry.path),
    ...[...remote.keys()].filter((path) => !inventory.captured.has(path)),
  ]);
  if (alias !== null) return refused({ reason: "path-alias", ...alias });
  // Case/Unicode aliases may be one disk file even when Git reports separate paths. Refuse the plan
  // rather than attempting changes the applier cannot preserve safely through interruption.
  const respelled = respelling(base.keys(), [...remote.keys(), ...inventory.captured.keys()]);
  if (respelled !== null) return refused({ reason: "alias-rename", ...respelled });

  const requested = new Set(input.collisionPaths);
  const collisions = findCollisions({ inventory, remote, collisionPaths: requested });
  if (collisions.excluded !== null)
    return refused({ reason: "remote-collides-with-excluded", path: collisions.excluded });
  // Exactly the colliding paths are captured as collisions: no fewer, and none that no
  // longer collide, which would otherwise enter the local tree as if selected.
  if (
    collisions.capture.length !== requested.size ||
    collisions.capture.some((path) => !requested.has(path))
  )
    return { _tag: "needs-capture", paths: collisions.capture } satisfies OverleafReviewResult;

  // Only a deliberate choice is remembered: an addition sent by default that the
  // selection left out, or one an earlier review left out on purpose. Additions a
  // rule skips are judged again at every sync.
  const newLocalOnly = inventory.deselected;
  const sent = new Set(inventory.sentLocalOnly);
  const keptLocalOnly = connection.localOnlyPaths.filter(
    (path) => !requested.has(path) && !sent.has(path),
  );
  if (new Set([...keptLocalOnly, ...newLocalOnly]).size > limits.localOnlyPaths)
    return refused({ reason: "local-only-limit" });

  const { blobs: local, tree: localTree } = yield* writeCapturedTree({
    repo,
    captured: inventory.captured,
    scratch: input.scratch,
  });

  const merge = yield* repos.merge({
    repo,
    base: baseTree,
    local: localTree,
    remote: input.remote.tree,
  });
  const merged = toMap(yield* repos.readTree({ repo, tree: merge.tree }));
  const mergedSizes = yield* repos.treeSizes({ repo, tree: merge.tree });
  /** Sizes by blob, so candidate limits apply before any blob is read. */
  const blobSizes = new Map<string, number>();
  for (const [path, oid] of remote) blobSizes.set(oid, remoteSizes.get(path) ?? 0);
  for (const [path, oid] of merged) blobSizes.set(oid, mergedSizes.get(path) ?? 0);
  for (const [path, oid] of local) blobSizes.set(oid, inventory.captured.get(path)!.bytes.length);

  const renames = [
    ...renamesOf(yield* repos.diff({ repo, from: baseTree, to: localTree })),
    ...renamesOf(yield* repos.diff({ repo, from: baseTree, to: input.remote.tree })),
  ];
  const guarded = guardedPaths({
    base,
    local,
    merged,
    incoming: yield* repos.diff({ repo, from: localTree, to: merge.tree }),
  });
  const interrupted = input.interrupted
    .map((paths) => sorted(paths))
    .sort((left, right) => byPath(left.join("\0"), right.join("\0")));
  const groups = conflictGroups({
    merge: merge.conflicts,
    guarded,
    interrupted,
    collisions: collisions.groups,
    renames,
    trees: { base, local, remote, merged },
  }).toSorted((left, right) => byPath(left.paths.join("\0"), right.paths.join("\0")));
  // Conflict-generated and retained names also need reviewed-or-empty paths. Check before applying
  // choices so an unexpected file cannot cause an unreviewed read or stop a group partway.
  const applied = new Set([
    ...base.keys(),
    ...remote.keys(),
    ...local.keys(),
    ...merged.keys(),
    ...renames.flatMap((rename) => [rename.from, rename.to]),
    ...groups.flatMap((group) => group.paths),
  ]);
  const twoSpellings = respelling(applied, []);
  if (twoSpellings !== null)
    return refused({
      reason: "path-alias",
      ...(twoSpellings.from < twoSpellings.to
        ? { first: twoSpellings.from, second: twoSpellings.to }
        : { first: twoSpellings.to, second: twoSpellings.from }),
    });
  const occupied = unreviewedOccupant(applied, inventory);
  if (occupied !== null) return refused({ reason: "unreviewed-path", ...occupied });

  const conflicts: OverleafReviewConflict[] = [];
  for (const group of groups) {
    const key = overleafConflictKey(group.paths);
    const allowed: ConflictChoice[] = ["mine", "theirs"];
    // Merge-in-editor is judged only for an eligible group, and only within the file limit;
    // an oversized intermediate result never blocks choosing either side.
    const [only] = group.paths;
    const mergedOid = only === undefined ? undefined : merged.get(only);
    if (
      mergedOid !== undefined &&
      canMergeInEditor(group, () => true) &&
      (blobSizes.get(mergedOid) ?? Infinity) <= limits.fileBytes
    ) {
      const text = new TextDecoder().decode(
        yield* repos.readBlob({ repo, oid: mergedOid, maxBytes: limits.fileBytes }),
      );
      if (canMergeInEditor(group, () => hasConflictMarkers(text))) allowed.push("markers");
    }
    const wanted = input.choices.get(key);
    conflicts.push({
      ...group,
      key,
      allowed,
      chosen: wanted !== undefined && allowed.includes(wanted) ? wanted : null,
    });
  }
  // Unchosen groups keep the merged state; such a review is not confirmable.
  const candidate = applyChoices({
    merged,
    local,
    remote,
    conflicts,
    choices: conflicts.map((conflict) => conflict.chosen ?? "markers"),
  });
  if (candidate.size > limits.managedFiles) return refused({ reason: "candidate-file-limit" });
  const candidatePaths = sorted(candidate.keys());
  let candidateBytes = 0;
  for (const path of candidatePaths) {
    const size = blobSizes.get(candidate.get(path)!) ?? Infinity;
    if (size > limits.fileBytes) return refused({ reason: "candidate-file-too-large", path });
    candidateBytes += size;
  }
  if (candidateBytes > limits.totalBytes) return refused({ reason: "candidate-too-large" });
  const candidateTree = yield* repos.writeTree({
    repo,
    entries: candidatePaths.map((path) => ({ path, oid: candidate.get(path)! })),
  });

  // The applier receives every target file's bytes; unchanged files reuse the capture.
  const target = new Map<string, { readonly bytes: Uint8Array }>();
  for (const path of candidatePaths) {
    const oid = candidate.get(path)!;
    target.set(path, {
      bytes:
        local.get(path) === oid
          ? inventory.captured.get(path)!.bytes
          : yield* repos.readBlob({ repo, oid, maxBytes: limits.fileBytes }),
    });
  }

  const incoming = yield* repos.diff({ repo, from: localTree, to: candidateTree });
  const outgoing = yield* repos.diff({ repo, from: input.remote.tree, to: candidateTree });

  const warnings: OverleafReviewWarning[] = [];
  if (connection.base.tree === null) {
    warnings.push({ kind: "first-sync" });
    if (local.size > 0) warnings.push({ kind: "no-sync-history" });
  }
  for (const rename of renamesOf(outgoing)) warnings.push({ kind: "rename", ...rename });
  // Contract section 6: every earlier send still unresolved is named and acknowledged.
  for (const attempt of connection.attempts)
    if (attempt.outcome === "unknown" || attempt.outcome === "superseded-unresolved")
      warnings.push({
        kind: "unresolved-publication",
        attemptNumber: attempt.attemptNumber,
        candidateCommit: attempt.candidateCommit,
      });
  const priorTrees: FileTree[] = [];
  for (const prior of connection.priorBases) {
    if (prior.tree !== baseTree)
      priorTrees.push(toMap(yield* repos.readTree({ repo, tree: prior.tree })));
  }
  for (const change of outgoing) {
    const path = change.kind === "renamed" ? change.to : change.path;
    const oid = candidate.get(path);
    if (change.kind === "deleted" || oid === undefined) continue;
    if (priorTrees.some((tree) => tree.get(path) === oid))
      warnings.push({ kind: "restores-older-version", path });
  }
  if (candidateBytes > limits.recommendedTotalBytes)
    warnings.push({ kind: "over-recommended-size", bytes: candidateBytes });
  let editableBytes = 0;
  for (const path of candidatePaths) {
    const { bytes } = target.get(path)!;
    if (!looksLikeText(bytes)) continue;
    editableBytes += bytes.length;
    if (bytes.length > limits.editableFileBytes)
      warnings.push({ kind: "too-large-to-edit", path, bytes: bytes.length });
  }
  if (editableBytes > limits.editableTotalBytes)
    warnings.push({ kind: "editable-total-exceeded", bytes: editableBytes });

  const markerPaths = sorted(
    conflicts
      .filter((conflict) => conflict.chosen === "markers")
      .flatMap((conflict) => conflict.paths),
  );
  const recordedMarkerPaths = sorted(new Set(input.markerPaths));
  const unresolvedMarkers = recordedMarkerPaths.filter((path) => {
    const file = inventory.captured.get(path);
    return file !== undefined && hasConflictMarkers(new TextDecoder().decode(file.bytes));
  });

  const binding: OverleafReviewBinding = {
    connectionId: connection.connectionId,
    connectionRevision: connection.revision,
    baseGeneration: connection.base.generation,
    baseTree: connection.base.tree,
    checkoutEpoch: input.epochs.checkout,
    credentialEpoch: input.epochs.credential,
    authority: connection.binding,
    folderIdentity: connection.folder.identity,
    localTree,
    remoteCommit: input.remote.commit,
    remoteTree: input.remote.tree,
    selectedAdditions: sorted(inventory.selectedAdditions.map((addition) => addition.path)),
    // Deselected default additions are remembered as local-only once the review is applied.
    newLocalOnly: sorted(newLocalOnly),
    sentLocalOnly: sorted(sent),
    // A deliberate deselection is a request to keep the file here from now on,
    // whether or not the file is there when a replacement review is built.
    keepOnlyHere: sorted(new Set([...(input.requests?.keepOnlyHere ?? []), ...newLocalOnly])),
    send: sorted(new Set(input.requests?.send ?? [])),
    collisionPaths: sorted(requested),
    choices: conflicts.flatMap((conflict) =>
      conflict.chosen === null ? [] : [[conflict.key, conflict.chosen] as const],
    ),
    interrupted,
    recordedMarkerPaths,
    unresolvedMarkers,
    candidateTree,
    conflictKeys: conflicts.map((conflict) => conflict.key),
    markerPaths,
    warnings,
    acknowledgements: [...new Set(warnings.map((warning) => warning.kind))].filter((kind) =>
      ACKNOWLEDGED.has(kind),
    ),
  };
  const review: OverleafReview = {
    id: newOverleafId(),
    digest: overleafReviewDigest(binding),
    binding,
    incoming,
    outgoing,
    conflicts,
    warnings,
    unresolvedMarkers,
    confirmable: conflicts.every((conflict) => conflict.chosen !== null),
    upToDate: incoming.length === 0 && outgoing.length === 0 && conflicts.length === 0,
    collisions: sorted(requested),
    additions: [
      ...inventory.selectedAdditions.map((addition) => ({ ...addition, selected: true })),
      ...inventory.additions.map((addition) => ({ ...addition, selected: false })),
    ].toSorted((left, right) => byPath(left.path, right.path)),
    localOnly: inventory.localOnly,
    targetBytes: candidateBytes,
    applyPlan: {
      base,
      remote,
      captured: new Map(
        sorted(inventory.captured.keys()).map((path) => [
          path,
          inventory.captured.get(path)!.revision,
        ]),
      ),
      target,
      renames,
      conflicts: groups,
      markerPaths,
    },
  };
  return { _tag: "review", review } satisfies OverleafReviewResult;
});
