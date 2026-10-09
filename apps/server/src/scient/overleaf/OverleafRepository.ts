/**
 * The private repository behind one Overleaf connection. It is bare: nothing
 * is ever checked out, and the manuscript folder is never its working tree.
 * Trees are built from captured bytes, merged with an explicit base, compared,
 * and published, all as Git objects.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type OverleafGitError,
  OverleafGitExecutor,
  type OverleafGitExecuteInput,
  newOverleafId,
} from "./OverleafGitExecutor.ts";
import { type ManuscriptTreeProblem, manuscriptTreeProblem } from "./manuscriptPaths.ts";

const NETWORK_TIMEOUT = "5 minutes";
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
/** Labels Git writes into conflict markers; they are branch names in the private repository. */
const LOCAL_SIDE_LABEL = "Scient";
const REMOTE_SIDE_LABEL = "Overleaf";

export interface TreeEntry {
  readonly path: string;
  /** Git blob id of the file's bytes. */
  readonly oid: string;
}

export interface MergeConflict {
  /** Git's conflict type, for example `CONFLICT (contents)` or `CONFLICT (rename/rename)`. */
  readonly type: string;
  readonly paths: ReadonlyArray<string>;
}

export interface MergeResult {
  /** The merged tree. Conflicted text files in it carry conflict markers. */
  readonly tree: string;
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

export type TreeChange =
  | { readonly kind: "added" | "deleted" | "modified"; readonly path: string }
  | { readonly kind: "renamed"; readonly from: string; readonly to: string };

export type PushOutcome =
  /** Overleaf acknowledged the update. */
  | { readonly _tag: "accepted" }
  /** Overleaf said plainly that its branch has moved on. Nothing was applied. */
  | { readonly _tag: "out-of-date" }
  /** Anything else. The update may or may not have been applied. */
  | { readonly _tag: "unknown"; readonly detail: string };

export const OverleafRepositoryFailureReason = Schema.Literals([
  "git-failed",
  "invalid-tree",
  "unsupported-entry",
  "unreadable-output",
]);

export class OverleafRepositoryError extends Schema.TaggedError<OverleafRepositoryError>()(
  "OverleafRepositoryError",
  {
    reason: OverleafRepositoryFailureReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Overleaf repository ${this.reason}: ${this.detail}`;
  }
}

const unreadable = (what: string) =>
  new OverleafRepositoryError({ reason: "unreadable-output", detail: what });

function describeTreeProblem(problem: ManuscriptTreeProblem): string {
  switch (problem.kind) {
    case "path":
      return `"${problem.path}" cannot be synchronized (${problem.problem}).`;
    case "duplicate":
      return `"${problem.path}" appears twice.`;
    case "file-and-folder":
      return `"${problem.file}" is a file, but "${problem.inside}" needs it to be a folder.`;
    case "case-collision":
    case "normalization-collision":
      return `"${problem.first}" and "${problem.second}" cannot be synchronized as different paths.`;
  }
}

export function parseRemoteBranchAdvertisement(output: string): "main" | "master" | null {
  const symbolicHead = /^ref:\s+refs\/heads\/(main|master)\s+HEAD$/mu.exec(output)?.[1];
  if (symbolicHead === "main" || symbolicHead === "master") return symbolicHead;
  const advertised = new Set<"main" | "master">();
  for (const match of output.matchAll(/^[0-9a-f]{40,64}\s+refs\/heads\/(main|master)$/gmu)) {
    advertised.add(match[1] as "main" | "master");
  }
  return advertised.size === 1 ? ([...advertised][0] ?? null) : null;
}

/** `git merge-tree --write-tree -z`: tree id, conflicted file info, then informational records. */
export function parseMergeTreeOutput(output: string, conflicted: boolean): MergeResult | null {
  const parts = output.split("\0");
  const tree = parts[0] ?? "";
  if (!OID.test(tree)) return null;
  const conflicts: MergeConflict[] = [];
  if (!conflicted) return { tree, conflicts };
  let index = 1;
  while (index < parts.length && parts[index] !== "") index++;
  index++;
  while (index < parts.length && parts[index] !== "") {
    const count = Number(parts[index]);
    if (!Number.isInteger(count) || count < 0) return null;
    const paths = parts.slice(index + 1, index + 1 + count);
    const type = parts[index + 1 + count];
    if (paths.length !== count || type === undefined || parts[index + 2 + count] === undefined) {
      return null;
    }
    index += count + 3;
    if (type.startsWith("CONFLICT")) conflicts.push({ type, paths });
  }
  // A failed merge without a single conflict record cannot be acted on safely.
  return conflicts.length === 0 ? null : { tree, conflicts };
}

export function parseNameStatus(output: string): ReadonlyArray<TreeChange> | null {
  const parts = output.split("\0");
  const changes: TreeChange[] = [];
  for (let index = 0; index < parts.length && parts[index] !== "";) {
    const status = parts[index] ?? "";
    if (/^R\d{1,3}$/u.test(status)) {
      const from = parts[index + 1];
      const to = parts[index + 2];
      if (from === undefined || to === undefined) return null;
      changes.push({ kind: "renamed", from, to });
      index += 3;
      continue;
    }
    const path = parts[index + 1];
    if (!/^[ADM]$/u.test(status) || path === undefined) return null;
    changes.push({
      kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
      path,
    });
    index += 2;
  }
  return changes;
}

/** One line of `git push --porcelain` for the single ref Scient pushes. */
export function parsePushPorcelain(stdout: string, stderr: string): PushOutcome {
  const line = stdout.split("\n").find((candidate) => /^[ +\-*=!]\t/u.test(candidate));
  if (line === undefined)
    return { _tag: "unknown", detail: stderr.trim() || "no push status line" };
  const flag = line[0];
  const summary = line.split("\t")[2] ?? "";
  if (flag === " " || flag === "*" || flag === "=") return { _tag: "accepted" };
  if (flag === "!" && /\((?:non-fast-forward|fetch first)\)/u.test(summary)) {
    return { _tag: "out-of-date" };
  }
  return { _tag: "unknown", detail: summary || stderr.trim() };
}

export class OverleafRepository extends Context.Service<
  OverleafRepository,
  {
    /** Creates the bare repository at `repo` if it does not exist, and points it at `gitUrl`. */
    readonly initialize: (input: {
      readonly repo: string;
      readonly gitUrl: string;
    }) => Effect.Effect<void, OverleafRepositoryError | OverleafGitError>;
    readonly writeBlob: (input: {
      readonly repo: string;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<string, OverleafRepositoryError | OverleafGitError>;
    /** Stores files that Scient itself wrote to a private staging area; returns ids in order. */
    readonly writeBlobsFromFiles: (input: {
      readonly repo: string;
      readonly files: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<string>, OverleafRepositoryError | OverleafGitError>;
    readonly writeTree: (input: {
      readonly repo: string;
      readonly entries: ReadonlyArray<TreeEntry>;
    }) => Effect.Effect<string, OverleafRepositoryError | OverleafGitError>;
    /** Regular files only. A tree with links, submodules or unsafe paths is rejected. */
    readonly readTree: (input: {
      readonly repo: string;
      readonly tree: string;
    }) => Effect.Effect<ReadonlyArray<TreeEntry>, OverleafRepositoryError | OverleafGitError>;
    readonly readBlob: (input: {
      readonly repo: string;
      readonly oid: string;
      readonly maxBytes: number;
    }) => Effect.Effect<Uint8Array, OverleafRepositoryError | OverleafGitError>;
    readonly commit: (input: {
      readonly repo: string;
      readonly tree: string;
      readonly parents: ReadonlyArray<string>;
      readonly message: string;
    }) => Effect.Effect<string, OverleafRepositoryError | OverleafGitError>;
    readonly treeOf: (input: {
      readonly repo: string;
      readonly commit: string;
    }) => Effect.Effect<string, OverleafRepositoryError | OverleafGitError>;
    /** Three-way merge of two trees over an explicit base tree. Nothing is checked out. */
    readonly merge: (input: {
      readonly repo: string;
      readonly base: string;
      readonly local: string;
      readonly remote: string;
    }) => Effect.Effect<MergeResult, OverleafRepositoryError | OverleafGitError>;
    /** Changes from one tree to another, with Git's rename detection. */
    readonly diff: (input: {
      readonly repo: string;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<ReadonlyArray<TreeChange>, OverleafRepositoryError | OverleafGitError>;
    readonly discoverBranch: (input: {
      readonly repo: string;
      readonly token: Uint8Array;
    }) => Effect.Effect<"main" | "master" | null, OverleafRepositoryError | OverleafGitError>;
    /** Fetches Overleaf's branch and returns its head commit and tree. */
    readonly fetch: (input: {
      readonly repo: string;
      readonly branch: "main" | "master";
      readonly token: Uint8Array;
    }) => Effect.Effect<
      { readonly commit: string; readonly tree: string },
      OverleafRepositoryError | OverleafGitError
    >;
    /** Publishes one commit to Overleaf's branch, never forced. Network trouble is an outcome, not a failure. */
    readonly push: (input: {
      readonly repo: string;
      readonly commit: string;
      readonly branch: "main" | "master";
      readonly token: Uint8Array;
    }) => Effect.Effect<PushOutcome, OverleafRepositoryError | OverleafGitError>;
    readonly isAncestor: (input: {
      readonly repo: string;
      readonly ancestor: string;
      readonly descendant: string;
    }) => Effect.Effect<boolean, OverleafRepositoryError | OverleafGitError>;
    /** Trees of the commits after `after` up to `head`, newest first, bounded. */
    readonly treesSince: (input: {
      readonly repo: string;
      readonly after: string;
      readonly head: string;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly commit: string; readonly tree: string }>,
      OverleafRepositoryError | OverleafGitError
    >;
    /** Scient's own references, under `refs/scient/`. They keep snapshots alive. */
    readonly setRef: (input: {
      readonly repo: string;
      readonly name: string;
      readonly oid: string;
    }) => Effect.Effect<void, OverleafRepositoryError | OverleafGitError>;
    readonly readRef: (input: {
      readonly repo: string;
      readonly name: string;
    }) => Effect.Effect<string | null, OverleafRepositoryError | OverleafGitError>;
    readonly deleteRef: (input: {
      readonly repo: string;
      readonly name: string;
    }) => Effect.Effect<void, OverleafRepositoryError | OverleafGitError>;
  }
>()("t3/scient/overleaf/OverleafRepository") {}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (value: string) => new TextEncoder().encode(value);

export const make = Effect.gen(function* () {
  const git = yield* OverleafGitExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const run = (
    repo: string,
    args: ReadonlyArray<string>,
    extra: Partial<OverleafGitExecuteInput> = {},
  ) => git.execute({ cwd: repo, args, ...extra });
  const line = (
    repo: string,
    args: ReadonlyArray<string>,
    extra: Partial<OverleafGitExecuteInput> = {},
  ) => run(repo, args, extra).pipe(Effect.map((result) => text(result.stdout).trim()));
  const oidLine = Effect.fnUntraced(function* (
    repo: string,
    args: ReadonlyArray<string>,
    extra: Partial<OverleafGitExecuteInput> = {},
  ) {
    const value = yield* line(repo, args, extra);
    if (!OID.test(value))
      return yield* unreadable(`git ${args[0] ?? ""} did not return an object id`);
    return value;
  });
  const refName = (name: string) => `refs/scient/${name}`;
  const fileSystemFailure = (detail: string) => (cause: unknown) =>
    new OverleafRepositoryError({ reason: "git-failed", detail, cause });

  const initialize: OverleafRepository["Service"]["initialize"] = Effect.fn(
    "OverleafRepository.initialize",
  )(function* (input) {
    const parent = path.dirname(input.repo);
    yield* fs
      .makeDirectory(parent, { recursive: true })
      .pipe(Effect.mapError(fileSystemFailure("Could not create the repository folder.")));
    const exists = yield* fs
      .exists(path.join(input.repo, "HEAD"))
      .pipe(Effect.mapError(fileSystemFailure("Could not inspect the repository folder.")));
    if (!exists) {
      yield* git.execute({ cwd: parent, args: ["init", "-q", "--bare", input.repo] });
    }
    const current = yield* run(input.repo, ["remote", "get-url", "origin"], {
      acceptExitCodes: [2],
    });
    if (current.exitCode !== 0) {
      yield* run(input.repo, ["remote", "add", "origin", input.gitUrl]);
    } else if (text(current.stdout).trim() !== input.gitUrl) {
      yield* run(input.repo, ["remote", "set-url", "origin", input.gitUrl]);
    }
  });

  const writeBlob: OverleafRepository["Service"]["writeBlob"] = (input) =>
    oidLine(input.repo, ["hash-object", "-w", "--no-filters", "--stdin"], { stdin: input.bytes });

  const writeBlobsFromFiles: OverleafRepository["Service"]["writeBlobsFromFiles"] = Effect.fn(
    "OverleafRepository.writeBlobsFromFiles",
  )(function* (input) {
    if (input.files.length === 0) return [];
    if (input.files.some((file) => /[\n\r]/u.test(file) || !path.isAbsolute(file))) {
      return yield* new OverleafRepositoryError({
        reason: "invalid-tree",
        detail: "Staged file names must be absolute and single-line.",
      });
    }
    const result = yield* run(input.repo, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      stdin: encode(`${input.files.join("\n")}\n`),
    });
    const oids = text(result.stdout).trim().split("\n");
    if (oids.length !== input.files.length || oids.some((oid) => !OID.test(oid))) {
      return yield* unreadable("git hash-object did not return one id per file");
    }
    return oids;
  });

  const readTree: OverleafRepository["Service"]["readTree"] = Effect.fn(
    "OverleafRepository.readTree",
  )(function* (input) {
    const result = yield* run(input.repo, ["ls-tree", "-r", "-z", "--full-tree", input.tree]);
    const entries: TreeEntry[] = [];
    for (const record of text(result.stdout).split("\0")) {
      if (record === "") continue;
      const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/su.exec(record);
      if (!match) return yield* unreadable("git ls-tree returned an unreadable entry");
      const [, mode, type, oid, entryPath] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (type !== "blob" || mode !== "100644") {
        return yield* new OverleafRepositoryError({
          reason: "unsupported-entry",
          detail: `"${entryPath}" is not a supported manuscript entry (executable files, links and submodules cannot be synchronized).`,
        });
      }
      entries.push({ path: entryPath, oid });
    }
    const problem = manuscriptTreeProblem(entries.map((entry) => entry.path));
    if (problem !== null) {
      return yield* new OverleafRepositoryError({
        reason: "invalid-tree",
        detail: describeTreeProblem(problem),
      });
    }
    return entries;
  });

  const writeTree: OverleafRepository["Service"]["writeTree"] = Effect.fn(
    "OverleafRepository.writeTree",
  )(function* (input) {
    const problem = manuscriptTreeProblem(input.entries.map((entry) => entry.path));
    if (problem !== null) {
      return yield* new OverleafRepositoryError({
        reason: "invalid-tree",
        detail: describeTreeProblem(problem),
      });
    }
    if (input.entries.some((entry) => !OID.test(entry.oid))) {
      return yield* new OverleafRepositoryError({
        reason: "invalid-tree",
        detail: "A tree entry does not name a stored file.",
      });
    }
    const indexFile = path.join(input.repo, `scient-index-${newOverleafId()}`);
    const tree = yield* Effect.gen(function* () {
      yield* run(input.repo, ["update-index", "-z", "--index-info"], {
        indexFile,
        stdin: encode(
          input.entries.map((entry) => `100644 ${entry.oid}\t${entry.path}\0`).join(""),
        ),
      });
      return yield* oidLine(input.repo, ["write-tree"], { indexFile });
    }).pipe(Effect.ensuring(fs.remove(indexFile, { force: true }).pipe(Effect.ignoreCause())));
    // Git's index plumbing can drop an entry without complaint; never trust it blindly.
    const written = yield* readTree({ repo: input.repo, tree });
    const wanted = new Map(input.entries.map((entry) => [entry.path, entry.oid]));
    if (
      written.length !== wanted.size ||
      written.some((entry) => wanted.get(entry.path) !== entry.oid)
    ) {
      return yield* new OverleafRepositoryError({
        reason: "invalid-tree",
        detail: "Git did not store the tree that was asked for.",
      });
    }
    return tree;
  });

  const readBlob: OverleafRepository["Service"]["readBlob"] = (input) =>
    run(input.repo, ["cat-file", "blob", input.oid], { maxOutputBytes: input.maxBytes }).pipe(
      Effect.map((result) => result.stdout),
    );

  const commit: OverleafRepository["Service"]["commit"] = (input) =>
    oidLine(
      input.repo,
      ["commit-tree", input.tree, ...input.parents.flatMap((parent) => ["-p", parent])],
      { stdin: encode(`${input.message}\n`) },
    );

  const treeOf: OverleafRepository["Service"]["treeOf"] = (input) =>
    oidLine(input.repo, ["rev-parse", "--verify", "--end-of-options", `${input.commit}^{tree}`]);

  const merge: OverleafRepository["Service"]["merge"] = Effect.fn("OverleafRepository.merge")(
    function* (input) {
      // Synthetic commits make the base explicit and independent of any history
      // Overleaf's bridge may have rewritten.
      const base = yield* commit({
        repo: input.repo,
        tree: input.base,
        parents: [],
        message: "base",
      });
      const local = yield* commit({
        repo: input.repo,
        tree: input.local,
        parents: [base],
        message: LOCAL_SIDE_LABEL,
      });
      const remote = yield* commit({
        repo: input.repo,
        tree: input.remote,
        parents: [base],
        message: REMOTE_SIDE_LABEL,
      });
      // Branch names become the labels in conflict markers.
      yield* run(input.repo, ["update-ref", "--stdin"], {
        stdin: encode(
          `update refs/heads/${LOCAL_SIDE_LABEL} ${local}\nupdate refs/heads/${REMOTE_SIDE_LABEL} ${remote}\n`,
        ),
      });
      const result = yield* run(
        input.repo,
        ["merge-tree", "--write-tree", "-z", LOCAL_SIDE_LABEL, REMOTE_SIDE_LABEL],
        { acceptExitCodes: [1] },
      );
      const parsed = parseMergeTreeOutput(text(result.stdout), result.exitCode === 1);
      if (parsed === null) return yield* unreadable("git merge-tree returned an unreadable result");
      return parsed;
    },
  );

  const diff: OverleafRepository["Service"]["diff"] = Effect.fn("OverleafRepository.diff")(
    function* (input) {
      if (input.from === input.to) return [];
      const result = yield* run(input.repo, [
        "diff-tree",
        "-r",
        "-M",
        "-z",
        "--name-status",
        input.from,
        input.to,
      ]);
      const parsed = parseNameStatus(text(result.stdout));
      if (parsed === null) return yield* unreadable("git diff-tree returned an unreadable result");
      return parsed;
    },
  );

  const discoverBranch: OverleafRepository["Service"]["discoverBranch"] = (input) =>
    run(
      input.repo,
      ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/main", "refs/heads/master"],
      { token: input.token, timeout: NETWORK_TIMEOUT },
    ).pipe(Effect.map((result) => parseRemoteBranchAdvertisement(text(result.stdout))));

  const fetch: OverleafRepository["Service"]["fetch"] = Effect.fn("OverleafRepository.fetch")(
    function* (input) {
      const tracking = `refs/remotes/origin/${input.branch}`;
      yield* run(
        input.repo,
        [
          "fetch",
          "--no-tags",
          "--prune",
          "--no-recurse-submodules",
          "origin",
          `+refs/heads/${input.branch}:${tracking}`,
        ],
        { token: input.token, timeout: NETWORK_TIMEOUT },
      );
      const head = yield* oidLine(input.repo, ["rev-parse", "--verify", `${tracking}^{commit}`]);
      return { commit: head, tree: yield* treeOf({ repo: input.repo, commit: head }) };
    },
  );

  const push: OverleafRepository["Service"]["push"] = Effect.fn("OverleafRepository.push")(
    function* (input) {
      yield* git.availability;
      return yield* run(
        input.repo,
        ["push", "--porcelain", "origin", `${input.commit}:refs/heads/${input.branch}`],
        { token: input.token, timeout: NETWORK_TIMEOUT, acceptExitCodes: [1] },
      ).pipe(
        Effect.map((result) => parsePushPorcelain(text(result.stdout), result.stderr)),
        // A timeout or a broken connection says nothing about what Overleaf did.
        Effect.catchTags({
          OverleafGitError: (error) =>
            Effect.succeed<PushOutcome>({
              _tag: "unknown",
              detail: `${error.reason}: ${error.detail}`,
            }),
        }),
      );
    },
  );

  const isAncestor: OverleafRepository["Service"]["isAncestor"] = (input) =>
    run(input.repo, ["merge-base", "--is-ancestor", input.ancestor, input.descendant], {
      acceptExitCodes: [1],
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const treesSince: OverleafRepository["Service"]["treesSince"] = Effect.fn(
    "OverleafRepository.treesSince",
  )(function* (input) {
    const result = yield* run(input.repo, [
      "log",
      "--first-parent",
      `--max-count=${String(Math.max(1, Math.floor(input.limit)))}`,
      "--format=%H %T",
      `${input.after}..${input.head}`,
    ]);
    const out: Array<{ commit: string; tree: string }> = [];
    for (const record of text(result.stdout).split("\n")) {
      if (record === "") continue;
      const [commitId, tree] = record.split(" ");
      if (commitId === undefined || tree === undefined || !OID.test(commitId) || !OID.test(tree)) {
        return yield* unreadable("git log returned an unreadable result");
      }
      out.push({ commit: commitId, tree });
    }
    return out;
  });

  const setRef: OverleafRepository["Service"]["setRef"] = (input) =>
    run(input.repo, ["update-ref", refName(input.name), input.oid]).pipe(Effect.asVoid);
  const readRef: OverleafRepository["Service"]["readRef"] = (input) =>
    run(input.repo, ["rev-parse", "--verify", "-q", refName(input.name)], {
      acceptExitCodes: [1],
    }).pipe(Effect.map((result) => (result.exitCode === 0 ? text(result.stdout).trim() : null)));
  const deleteRef: OverleafRepository["Service"]["deleteRef"] = (input) =>
    run(input.repo, ["update-ref", "-d", refName(input.name)]).pipe(Effect.asVoid);

  return OverleafRepository.of({
    initialize,
    writeBlob,
    writeBlobsFromFiles,
    writeTree,
    readTree,
    readBlob,
    commit,
    treeOf,
    merge,
    diff,
    discoverBranch,
    fetch,
    push,
    isAncestor,
    treesSince,
    setRef,
    readRef,
    deleteRef,
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const layer = Layer.effect(OverleafRepository, make);
