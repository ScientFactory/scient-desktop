// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ScientOverleafChange,
  ScientOverleafConflict,
  ScientOverleafConflictDetail,
  ScientOverleafReview,
  ScientOverleafWarning,
} from "@t3tools/contracts";
import { ScientOverleafOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { advisoryWarnings, ManagedTree, normalizeManagedPath } from "./ManagedTree.ts";
import type {
  PersistedOverleafAccount,
  PersistedOverleafConnection,
  TreeManifest,
} from "./model.ts";
import { OverleafGitExecutor, type OverleafGitExecuteResult } from "./OverleafGitExecutor.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";

const isOverleafOperationError = Schema.is(ScientOverleafOperationError);

interface GitContext {
  readonly operationId: string;
  readonly cwd: string;
  readonly token?: Uint8Array;
  readonly account?: PersistedOverleafAccount;
  readonly branch?: PersistedOverleafConnection["branch"];
}

function remoteBranch(input: GitContext): PersistedOverleafConnection["branch"] {
  return input.branch ?? "master";
}

function remoteTrackingRef(input: GitContext): string {
  return `refs/remotes/origin/${remoteBranch(input)}`;
}

export function parseRemoteBranchAdvertisement(
  output: string,
): PersistedOverleafConnection["branch"] | null {
  const symbolicHead = /^ref:\s+refs\/heads\/(main|master)\s+HEAD$/mu.exec(output)?.[1];
  if (symbolicHead === "main" || symbolicHead === "master") return symbolicHead;
  const advertised = new Set<PersistedOverleafConnection["branch"]>();
  for (const match of output.matchAll(/^[0-9a-f]{40,64}\s+refs\/heads\/(main|master)$/gmu))
    advertised.add(match[1] as PersistedOverleafConnection["branch"]);
  return advertised.size === 1 ? [...advertised][0]! : null;
}

function operationError(
  code:
    | "git_access_unavailable"
    | "network_failed"
    | "dns_failed"
    | "tls_failed"
    | "rate_limited"
    | "filesystem_failed"
    | "conflict"
    | "push_race"
    | "push_outcome_unknown"
    | "unsafe_tree"
    | "unsupported_tree"
    | "corrupt_state"
    | "workspace_changed",
  message: string,
  retryable: boolean,
) {
  return new ScientOverleafOperationError({ code, message, retryable });
}

function classifyRemoteFailure(stderr: string): ScientOverleafOperationError {
  if (
    /could not resolve host|name or service not known|temporary failure in name resolution/iu.test(
      stderr,
    )
  ) {
    return operationError("dns_failed", "The Overleaf host could not be resolved.", true);
  }
  if (/certificate|ssl|tls|schannel|secure channel/iu.test(stderr)) {
    return operationError(
      "tls_failed",
      "A secure TLS connection to Overleaf could not be established.",
      true,
    );
  }
  if (/\b429\b|rate.?limit|too many requests/iu.test(stderr)) {
    return operationError(
      "rate_limited",
      "Overleaf temporarily rate-limited this Git operation.",
      true,
    );
  }
  if (
    /authentication|access denied|forbidden|\b40[13]\b|repository not found|not authorized/iu.test(
      stderr,
    )
  ) {
    return operationError(
      "git_access_unavailable",
      "Git access to this Overleaf project is unavailable. Check the project or Git URL, collaborator permission, token expiry, Cloud project-owner Git eligibility, and Server Pro Git Bridge configuration.",
      false,
    );
  }
  return operationError(
    "network_failed",
    "The Overleaf Git operation could not reach the remote service.",
    true,
  );
}

function mapGitError(message: string, retryable = true) {
  return (cause: unknown) =>
    isOverleafOperationError(cause)
      ? cause
      : operationError("filesystem_failed", message, retryable);
}

export function parseNameStatus(output: string): ReadonlyArray<ScientOverleafChange> {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: ScientOverleafChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]!;
    const code = status[0];
    if (code === "R") {
      const match = status.match(/^R(\d{1,3})$/u);
      const oldField = fields[index++];
      const pathField = fields[index++];
      const similarity = match ? Number(match[1]) : Number.NaN;
      if (
        !match ||
        similarity < 0 ||
        similarity > 100 ||
        oldField === undefined ||
        pathField === undefined
      )
        throw operationError("corrupt_state", "Git returned an unreadable change record.", false);
      const oldPath = normalizeManagedPath(oldField);
      const path = normalizeManagedPath(pathField);
      changes.push({ kind: "renamed", oldPath, path, similarity });
      continue;
    }
    const pathField = fields[index++];
    if (!/^[ADM]$/u.test(code ?? "") || pathField === undefined)
      throw operationError("corrupt_state", "Git returned an unreadable change record.", false);
    const path = normalizeManagedPath(pathField);
    changes.push({
      kind: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      path,
    });
  }
  return changes;
}

interface UnmergedStage {
  readonly mode: string;
  readonly hash: string;
  readonly stage: number;
  readonly path: string;
}

export function parseUnmerged(output: string): ReadonlyArray<UnmergedStage> {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+) ([0-9a-f]+) ([123])\t(.+)$/u);
      if (!match)
        throw operationError("conflict", "Git returned an unreadable conflict record.", false);
      return {
        mode: match[1]!,
        hash: match[2]!,
        stage: Number(match[3]!),
        path: normalizeManagedPath(match[4]!),
      };
    });
}

export function uncertainPushWasAccepted(input: {
  readonly candidateTree: string;
  readonly headTree: string;
  readonly firstParentTrees: ReadonlyArray<string>;
  readonly candidateCommitReachable: boolean;
}): boolean {
  return (
    input.headTree === input.candidateTree ||
    input.firstParentTrees.includes(input.candidateTree) ||
    input.candidateCommitReachable
  );
}

function textPreview(bytes: Uint8Array | null): string | null {
  if (bytes === null || bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function hashPath(filePath: string): Promise<string> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function replaceMirrorTree(input: {
  readonly sourceRoot: string;
  readonly mirrorRoot: string;
  readonly desired: TreeManifest;
  readonly previous: TreeManifest;
}) {
  const desiredPaths = new Set(input.desired.files.map((file) => file.path));
  for (const previous of input.previous.files) {
    if (desiredPaths.has(previous.path)) continue;
    await NodeFSP.rm(NodePath.join(input.mirrorRoot, ...previous.path.split("/")), { force: true });
  }
  for (const file of input.desired.files) {
    const source = NodePath.join(input.sourceRoot, ...file.path.split("/"));
    const target = NodePath.join(input.mirrorRoot, ...file.path.split("/"));
    const sourceInfo = await NodeFSP.lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
      throw operationError(
        "workspace_changed",
        "A managed workspace file became unsafe after Sync began.",
        true,
      );
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.copyFile(source, target);
    const copiedHash = await hashPath(target);
    if (copiedHash !== file.hash) {
      await NodeFSP.rm(target, { force: true });
      throw operationError(
        "workspace_changed",
        "A managed workspace file changed while its snapshot was being copied.",
        true,
      );
    }
  }
}

export class OverleafMirror extends Context.Service<
  OverleafMirror,
  {
    readonly mirrorRoot: (connectionId: string) => string;
    readonly initialize: (
      input: GitContext & { readonly connectionId: string; readonly gitUrl: string },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly discoverBranch: (
      input: GitContext,
    ) => Effect.Effect<PersistedOverleafConnection["branch"], ScientOverleafOperationError>;
    readonly fetch: (input: GitContext) => Effect.Effect<string, ScientOverleafOperationError>;
    readonly checkout: (
      input: GitContext & { readonly commit: string },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly manifest: (
      input: GitContext & { readonly commit?: string },
    ) => Effect.Effect<TreeManifest, ScientOverleafOperationError>;
    readonly applyWorkspace: (
      input: GitContext & {
        readonly workspaceRoot: string;
        readonly desired: TreeManifest;
        readonly previous: TreeManifest;
      },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly stageAll: (input: GitContext) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly hasChanges: (
      input: GitContext,
    ) => Effect.Effect<boolean, ScientOverleafOperationError>;
    readonly commitSnapshot: (
      input: GitContext & { readonly message: string },
    ) => Effect.Effect<string | null, ScientOverleafOperationError>;
    readonly retainWorkspaceBase: (
      input: GitContext & { readonly commit: string },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly releaseOperationRef: (
      input: GitContext,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly rebaseSnapshot: (
      input: GitContext & { readonly snapshotCommit: string | null },
    ) => Effect.Effect<
      { readonly candidateCommit: string; readonly conflicted: boolean },
      ScientOverleafOperationError
    >;
    readonly rebaseRangeOnto: (
      input: GitContext & { readonly upstream: string; readonly fromExclusive: string },
    ) => Effect.Effect<
      { readonly candidateCommit: string; readonly conflicted: boolean },
      ScientOverleafOperationError
    >;
    readonly conflicts: (
      input: GitContext,
    ) => Effect.Effect<ReadonlyArray<ScientOverleafConflictDetail>, ScientOverleafOperationError>;
    readonly materializeBlob: (
      input: GitContext & {
        readonly hash: string;
        readonly destination: string;
        readonly maxBytes: number;
      },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly resolveConflict: (
      input: GitContext & {
        readonly conflict: ScientOverleafConflictDetail;
        readonly resolution: "overleaf" | "local" | "delete" | "both";
      },
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly continueRebase: (
      input: GitContext,
    ) => Effect.Effect<
      { readonly candidateCommit: string; readonly conflicted: boolean },
      ScientOverleafOperationError
    >;
    readonly abortRebase: (input: GitContext) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly review: (
      input: GitContext & {
        readonly connection: PersistedOverleafConnection;
        readonly candidateCommit: string;
        readonly candidateManifest: TreeManifest;
      },
    ) => Effect.Effect<ScientOverleafReview, ScientOverleafOperationError>;
    readonly push: (
      input: GitContext,
    ) => Effect.Effect<"confirmed" | "race" | "unknown", ScientOverleafOperationError>;
    readonly treeHash: (
      input: GitContext & { readonly commit: string },
    ) => Effect.Effect<string, ScientOverleafOperationError>;
    readonly candidateAccepted: (
      input: GitContext & {
        readonly candidateCommit: string;
        readonly candidateTree: string;
        readonly prePushBase: string;
      },
    ) => Effect.Effect<
      { readonly accepted: boolean; readonly head: string },
      ScientOverleafOperationError
    >;
  }
>()("t3/scient/overleaf/OverleafMirror") {}

export const make = Effect.fn("OverleafMirror.make")(function* () {
  const git = yield* OverleafGitExecutor;
  const state = yield* OverleafStateStore;
  const tree = yield* ManagedTree;
  const mirrorRoot = (connectionId: string) =>
    NodePath.join(state.connectionDirectory(connectionId), "mirror");
  const run = (
    context: GitContext,
    args: ReadonlyArray<string>,
    options?: {
      allowNonZeroExit?: boolean;
      timeoutMs?: number;
      credentialed?: boolean;
      unknownOnTimeout?: boolean;
      maxOutputBytes?: number;
      stdoutFile?: string;
    },
  ) => {
    const { credentialed = false, unknownOnTimeout = false, ...executeOptions } = options ?? {};
    return git
      .execute({
        operationId: context.operationId,
        cwd: context.cwd,
        args,
        ...(credentialed && context.token !== undefined ? { token: context.token } : {}),
        ...(context.account === undefined
          ? {}
          : { identity: { name: context.account.authorName, email: context.account.authorEmail } }),
        ...executeOptions,
      })
      .pipe(
        Effect.mapError((error) =>
          error.reason === "timeout"
            ? operationError(
                unknownOnTimeout ? "push_outcome_unknown" : "network_failed",
                unknownOnTimeout
                  ? "Overleaf may have accepted the push. Verify the remote before retrying."
                  : "The Overleaf Git operation timed out.",
                true,
              )
            : operationError(
                "filesystem_failed",
                "The private Overleaf Git operation failed.",
                error.retryable,
              ),
        ),
      );
  };

  const initialize: OverleafMirror["Service"]["initialize"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(input.cwd, { recursive: true }),
        catch: mapGitError("Unable to prepare the private Overleaf mirror."),
      });
      const existing = yield* Effect.tryPromise({
        try: async () => !!(await NodeFSP.stat(NodePath.join(input.cwd, ".git"))).isDirectory(),
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));
      if (!existing) {
        yield* run(input, ["init", "--initial-branch=master"]).pipe(
          Effect.mapError(mapGitError("Unable to initialize the private Overleaf mirror.")),
        );
        yield* run(input, ["remote", "add", "origin", input.gitUrl]).pipe(
          Effect.mapError(mapGitError("Unable to configure the private Overleaf mirror.")),
        );
      } else {
        const configured = yield* run(input, ["remote", "get-url", "origin"], {
          allowNonZeroExit: true,
        }).pipe(Effect.mapError(mapGitError("Unable to inspect the private Overleaf mirror.")));
        if (configured.exitCode !== 0 || configured.stdout.trim() !== input.gitUrl)
          return yield* operationError(
            "corrupt_state",
            "The private Overleaf mirror does not match this connection. Use Repair.",
            false,
          );
      }
    });

  const fetch: OverleafMirror["Service"]["fetch"] = (input) =>
    Effect.gen(function* () {
      const fetched = yield* run(
        input,
        [
          "fetch",
          "--prune",
          "--no-tags",
          "origin",
          `+refs/heads/${remoteBranch(input)}:${remoteTrackingRef(input)}`,
        ],
        { timeoutMs: 180_000, credentialed: true, allowNonZeroExit: true },
      );
      if (fetched.exitCode !== 0) return yield* classifyRemoteFailure(fetched.stderr);
      const head = (yield* run(input, ["rev-parse", remoteTrackingRef(input)]).pipe(
        Effect.mapError(mapGitError("The Overleaf project branch is unavailable.", false)),
      )).stdout.trim();
      if (input.account !== undefined) yield* state.markAccountValidated(input.account.accountId);
      return head;
    });

  const discoverBranch: OverleafMirror["Service"]["discoverBranch"] = (input) =>
    Effect.gen(function* () {
      const advertised = yield* run(
        input,
        ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/main", "refs/heads/master"],
        { timeoutMs: 180_000, credentialed: true, allowNonZeroExit: true },
      );
      if (advertised.exitCode !== 0) return yield* classifyRemoteFailure(advertised.stderr);
      const branch = parseRemoteBranchAdvertisement(advertised.stdout);
      if (branch === null)
        return yield* operationError(
          "unsupported_tree",
          "This Overleaf project does not expose an unambiguous main or master branch.",
          false,
        );
      return branch;
    });

  const checkout: OverleafMirror["Service"]["checkout"] = (input) =>
    Effect.gen(function* () {
      yield* run(input, ["checkout", "-B", "master", input.commit]).pipe(
        Effect.mapError(mapGitError("Unable to prepare the private Overleaf worktree.")),
      );
      yield* run(input, ["reset", "--hard", input.commit]).pipe(
        Effect.mapError(mapGitError("Unable to reset the private Overleaf worktree.")),
      );
      yield* run(input, ["clean", "-fdx"]).pipe(
        Effect.mapError(mapGitError("Unable to clean the private Overleaf worktree.")),
      );
    });

  const rawTreePaths = Effect.fnUntraced(function* (
    input: GitContext & { readonly commit: string },
  ) {
    const result = yield* run(input, ["ls-tree", "-r", "-z", "--full-tree", input.commit]).pipe(
      Effect.mapError(mapGitError("Unable to inspect the Overleaf project tree.")),
    );
    const paths: string[] = [];
    const foldedPaths = new Map<string, string>();
    for (const record of result.stdout.split("\0").filter(Boolean)) {
      const match = record.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/u);
      if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1]!))
        return yield* operationError(
          "unsafe_tree",
          "The Overleaf project contains an unsupported tree entry.",
          false,
        );
      const managedPath = normalizeManagedPath(match[4]!);
      const folded = managedPath.toLocaleLowerCase("en-US");
      const previous = foldedPaths.get(folded);
      if (previous !== undefined && previous !== managedPath)
        return yield* operationError(
          "unsafe_tree",
          "The Overleaf project contains paths that collide by letter case.",
          false,
        );
      foldedPaths.set(folded, managedPath);
      paths.push(managedPath);
    }
    return paths;
  });

  const manifest: OverleafMirror["Service"]["manifest"] = (input) =>
    Effect.gen(function* () {
      const commit = input.commit ?? "HEAD";
      const paths = yield* rawTreePaths({ ...input, commit });
      for (const attributesPath of paths.filter(
        (path) => NodePath.posix.basename(path) === ".gitattributes",
      )) {
        const attributes = yield* run(input, ["show", `${commit}:${attributesPath}`], {
          allowNonZeroExit: true,
          maxOutputBytes: 8 * 1024 * 1024,
        });
        if (attributes.exitCode !== 0)
          return yield* operationError(
            "unsafe_tree",
            "The Overleaf .gitattributes file could not be inspected safely.",
            false,
          );
        if (/(?:^|\s)filter=lfs(?:\s|$)/mu.test(attributes.stdout))
          return yield* operationError(
            "unsupported_tree",
            "Git LFS paths are not supported by Overleaf sync.",
            false,
          );
      }
      yield* checkout({ ...input, commit });
      return yield* tree.scan({
        operationId: input.operationId,
        root: input.cwd,
        trackedPaths: paths,
      });
    });

  const applyWorkspace: OverleafMirror["Service"]["applyWorkspace"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          replaceMirrorTree({
            sourceRoot: input.workspaceRoot,
            mirrorRoot: input.cwd,
            desired: input.desired,
            previous: input.previous,
          }),
        catch: (cause) =>
          isOverleafOperationError(cause)
            ? cause
            : operationError(
                "filesystem_failed",
                "Unable to copy the workspace snapshot into the private mirror.",
                true,
              ),
      });
      yield* run(input, ["add", "-A"]).pipe(
        Effect.mapError(mapGitError("Unable to stage the workspace snapshot.")),
      );
    });
  const stageAll: OverleafMirror["Service"]["stageAll"] = (input) =>
    run(input, ["add", "-A"]).pipe(
      Effect.asVoid,
      Effect.mapError(mapGitError("Unable to stage the Overleaf candidate.")),
    );

  const hasChanges: OverleafMirror["Service"]["hasChanges"] = (input) =>
    run(input, ["status", "--porcelain=v1", "-z"]).pipe(
      Effect.map((result) => result.stdout.length > 0),
      Effect.mapError(mapGitError("Unable to inspect the private Overleaf mirror.")),
    );

  const commitSnapshot: OverleafMirror["Service"]["commitSnapshot"] = (input) =>
    Effect.gen(function* () {
      const status = yield* run(input, ["status", "--porcelain=v1", "-z"]).pipe(
        Effect.mapError(mapGitError("Unable to inspect the private Overleaf mirror.")),
      );
      if (status.stdout.length === 0) return null;
      yield* run(input, ["commit", "--no-verify", "-m", input.message]).pipe(
        Effect.mapError(mapGitError("Unable to create the Overleaf snapshot commit.")),
      );
      const commit = (yield* run(input, ["rev-parse", "HEAD"]).pipe(
        Effect.mapError(mapGitError("Unable to identify the Overleaf snapshot commit.")),
      )).stdout.trim();
      yield* run(input, [
        "update-ref",
        `refs/scient-overleaf/operations/${input.operationId}/snapshot`,
        commit,
      ]).pipe(Effect.mapError(mapGitError("Unable to retain the operation snapshot safely.")));
      return commit;
    });

  const retainWorkspaceBase: OverleafMirror["Service"]["retainWorkspaceBase"] = (input) =>
    run(input, [
      "update-ref",
      `refs/scient-overleaf/operations/${input.operationId}/workspace-base`,
      input.commit,
    ]).pipe(
      Effect.asVoid,
      Effect.mapError(mapGitError("Unable to retain the click-time workspace base safely.")),
    );

  const releaseOperationRef: OverleafMirror["Service"]["releaseOperationRef"] = (input) =>
    Effect.gen(function* () {
      yield* run(
        input,
        ["update-ref", "-d", `refs/scient-overleaf/operations/${input.operationId}/snapshot`],
        { allowNonZeroExit: true },
      );
      yield* run(
        input,
        ["update-ref", "-d", `refs/scient-overleaf/operations/${input.operationId}/workspace-base`],
        { allowNonZeroExit: true },
      );
    }).pipe(Effect.mapError(mapGitError("Unable to release the completed operation snapshot.")));

  const rebaseSnapshot: OverleafMirror["Service"]["rebaseSnapshot"] = (input) =>
    Effect.gen(function* () {
      if (input.snapshotCommit === null) {
        yield* checkout({ ...input, commit: remoteTrackingRef(input) });
        const candidateCommit = (yield* run(input, ["rev-parse", "HEAD"]).pipe(
          Effect.mapError(mapGitError("Unable to identify the Overleaf candidate.")),
        )).stdout.trim();
        return { candidateCommit, conflicted: false };
      }
      const rebased = yield* run(input, ["rebase", remoteTrackingRef(input)], {
        allowNonZeroExit: true,
      });
      if (rebased.exitCode !== 0) {
        const unmerged = yield* run(input, ["ls-files", "-u", "-z"], { allowNonZeroExit: true });
        if (unmerged.stdout.length > 0)
          return { candidateCommit: input.snapshotCommit, conflicted: true };
        return yield* operationError(
          "conflict",
          "The Overleaf snapshot could not be rebased safely.",
          true,
        );
      }
      const candidateCommit = (yield* run(input, ["rev-parse", "HEAD"]).pipe(
        Effect.mapError(mapGitError("Unable to identify the rebased Overleaf candidate.")),
      )).stdout.trim();
      return { candidateCommit, conflicted: false };
    });

  const readBlob = (context: GitContext, hash: string | undefined) =>
    Effect.gen(function* () {
      if (hash === undefined) return null;
      const size = Number((yield* run(context, ["cat-file", "-s", hash])).stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0)
        return yield* operationError(
          "conflict",
          "Git returned an invalid conflict blob size.",
          false,
        );
      if (size > 2 * 1024 * 1024) return { size, bytes: null };
      const result = yield* run(context, ["cat-file", "blob", hash], {
        maxOutputBytes: 2 * 1024 * 1024 + 1,
      });
      return { size, bytes: result.stdoutBytes };
    });

  const conflicts: OverleafMirror["Service"]["conflicts"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseUnmerged(
        (yield* run(input, ["ls-files", "-u", "-z"]).pipe(
          Effect.mapError(mapGitError("Unable to inspect Overleaf conflicts.")),
        )).stdout,
      );
      const grouped = Map.groupBy(parsed, (stage) => stage.path);
      const results: ScientOverleafConflictDetail[] = [];
      for (const [relative, stages] of grouped) {
        const byStage = new Map(stages.map((stage) => [stage.stage, stage] as const));
        const baseBytes = yield* readBlob(input, byStage.get(1)?.hash);
        const overleafBytes = yield* readBlob(input, byStage.get(2)?.hash);
        const localBytes = yield* readBlob(input, byStage.get(3)?.hash);
        const previewable = [baseBytes, overleafBytes, localBytes].every(
          (blob) => blob === null || (blob.bytes !== null && textPreview(blob.bytes) !== null),
        );
        const conflict: ScientOverleafConflict = {
          conflictId: relative,
          kind: !previewable
            ? "binary"
            : overleafBytes === null || localBytes === null
              ? "delete_modify"
              : "content",
          path: relative,
          baseSize: baseBytes?.size ?? null,
          overleafSize: overleafBytes?.size ?? null,
          localSize: localBytes?.size ?? null,
          baseHash: byStage.get(1)?.hash ?? null,
          overleafHash: byStage.get(2)?.hash ?? null,
          localHash: byStage.get(3)?.hash ?? null,
          previewable,
          resolved: false,
        };
        results.push({
          conflict,
          base: textPreview(baseBytes?.bytes ?? null),
          overleaf: textPreview(overleafBytes?.bytes ?? null),
          local: textPreview(localBytes?.bytes ?? null),
        });
      }
      return results;
    });

  const materializeBlob: OverleafMirror["Service"]["materializeBlob"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(input.destination), { recursive: true });
          await NodeFSP.rm(input.destination, { force: true });
        },
        catch: () =>
          operationError("filesystem_failed", "Unable to prepare conflict material.", true),
      });
      yield* run(input, ["cat-file", "blob", input.hash], {
        stdoutFile: input.destination,
        maxOutputBytes: input.maxBytes,
      }).pipe(Effect.asVoid, Effect.mapError(mapGitError("Unable to preserve conflict material.")));
    });

  const resolveConflict: OverleafMirror["Service"]["resolveConflict"] = (input) =>
    Effect.gen(function* () {
      const relative = input.conflict.conflict.path;
      if (input.resolution === "delete") {
        yield* run(input, ["rm", "--", relative]).pipe(
          Effect.mapError(mapGitError("Unable to stage the conflict deletion.")),
        );
        return;
      }
      const stage = input.resolution === "overleaf" ? "2" : "3";
      const hash =
        stage === "2" ? input.conflict.conflict.overleafHash : input.conflict.conflict.localHash;
      if (hash === null)
        return yield* operationError(
          "conflict",
          "That conflict side does not contain a file.",
          false,
        );
      yield* run(input, ["checkout", stage === "2" ? "--ours" : "--theirs", "--", relative]).pipe(
        Effect.mapError(mapGitError("Unable to write the selected conflict side.")),
      );
      yield* run(input, ["add", "--", relative]).pipe(
        Effect.mapError(mapGitError("Unable to stage the conflict resolution.")),
      );
    });

  const rebaseRangeOnto: OverleafMirror["Service"]["rebaseRangeOnto"] = (input) =>
    Effect.gen(function* () {
      const rebased = yield* run(input, ["rebase", "--onto", input.upstream, input.fromExclusive], {
        allowNonZeroExit: true,
      });
      if (rebased.exitCode !== 0) {
        const unmerged = yield* run(input, ["ls-files", "-u", "-z"], { allowNonZeroExit: true });
        if (unmerged.stdout.length > 0) return { candidateCommit: "", conflicted: true };
        return yield* operationError(
          "conflict",
          "The later local edits could not be reconciled safely.",
          true,
        );
      }
      return {
        candidateCommit: (yield* run(input, ["rev-parse", "HEAD"])).stdout.trim(),
        conflicted: false,
      };
    });

  const continueRebase: OverleafMirror["Service"]["continueRebase"] = (input) =>
    Effect.gen(function* () {
      const remaining = yield* run(input, ["ls-files", "-u", "-z"]);
      if (remaining.stdout.length > 0) return { candidateCommit: "", conflicted: true };
      const continued = yield* run(input, ["rebase", "--continue"], { allowNonZeroExit: true });
      if (continued.exitCode !== 0) {
        const again = yield* run(input, ["ls-files", "-u", "-z"], { allowNonZeroExit: true });
        if (again.stdout.length > 0) return { candidateCommit: "", conflicted: true };
        return yield* operationError(
          "conflict",
          "The resolved Overleaf snapshot could not continue rebasing.",
          true,
        );
      }
      return {
        candidateCommit: (yield* run(input, ["rev-parse", "HEAD"])).stdout.trim(),
        conflicted: false,
      };
    });

  const abortRebase: OverleafMirror["Service"]["abortRebase"] = (input) =>
    run(input, ["rebase", "--abort"], { allowNonZeroExit: true }).pipe(
      Effect.asVoid,
      Effect.mapError(mapGitError("Unable to abort the private mirror rebase.")),
    );

  const review: OverleafMirror["Service"]["review"] = (input) =>
    Effect.gen(function* () {
      const changes = parseNameStatus(
        (yield* run(input, [
          "diff",
          "--find-renames=50%",
          "--name-status",
          "-z",
          remoteTrackingRef(input),
          input.candidateCommit,
        ])).stdout,
      );
      const warnings: ScientOverleafWarning[] = [...advisoryWarnings(input.candidateManifest)];
      const deletions = changes
        .filter((change) => change.kind === "deleted")
        .map((change) => change.path);
      if (deletions.length > 0)
        warnings.push({
          kind: "deletion",
          message: "This Sync deletes files currently managed by Overleaf.",
          paths: deletions,
          blocking: true,
          suppressible: false,
        });
      const renames = changes
        .filter((change) => change.kind === "renamed")
        .map((change) => change.path);
      if (renames.length > 0 && !input.connection.suppressRenameWarning)
        warnings.push({
          kind: "rename",
          message: "Renames may displace Overleaf comments or Track Changes metadata.",
          paths: renames,
          blocking: true,
          suppressible: true,
        });

      const headTree = (yield* run(input, [
        "rev-parse",
        `${remoteTrackingRef(input)}^{tree}`,
      ])).stdout.trim();
      const candidateTree = (yield* run(input, [
        "rev-parse",
        `${input.candidateCommit}^{tree}`,
      ])).stdout.trim();
      const historicalTrees = (yield* run(input, [
        "log",
        "--first-parent",
        "--format=%T",
        remoteTrackingRef(input),
      ])).stdout
        .split("\n")
        .filter(Boolean)
        .slice(1);
      for (const treeHash of historicalTrees) {
        if (treeHash === candidateTree && treeHash !== headTree) {
          warnings.push({
            kind: "whole_tree_revert",
            message: "This candidate restores the whole project to an older Overleaf revision.",
            paths: [],
            blocking: true,
            suppressible: false,
          });
          break;
        }
      }
      const modified = changes.filter(
        (change) => change.kind === "modified" || change.kind === "renamed",
      );
      for (const change of modified) {
        const historyPath = change.kind === "renamed" ? change.oldPath! : change.path;
        const candidateBlob = (yield* run(
          input,
          ["rev-parse", `${input.candidateCommit}:${change.path}`],
          { allowNonZeroExit: true },
        )).stdout.trim();
        const headBlob = (yield* run(
          input,
          ["rev-parse", `${remoteTrackingRef(input)}:${historyPath}`],
          { allowNonZeroExit: true },
        )).stdout.trim();
        if (!candidateBlob || candidateBlob === headBlob) continue;
        const remoteHead = (yield* run(input, [
          "rev-parse",
          remoteTrackingRef(input),
        ])).stdout.trim();
        const history = (yield* run(input, [
          "rev-list",
          "--first-parent",
          remoteTrackingRef(input),
          "--",
          historyPath,
        ])).stdout
          .split("\n")
          .filter((commit) => Boolean(commit) && commit !== remoteHead);
        let reverted = false;
        for (const ancestor of history) {
          const blob = (yield* run(input, ["rev-parse", `${ancestor}:${historyPath}`], {
            allowNonZeroExit: true,
          })).stdout.trim();
          if (blob === candidateBlob) {
            reverted = true;
            break;
          }
        }
        if (reverted)
          warnings.push({
            kind: "historical_revert",
            message:
              "This file matches an older Overleaf revision and differs from the current remote file.",
            paths: [change.path],
            blocking: true,
            suppressible: false,
          });
      }
      return {
        candidateCommit: input.candidateCommit,
        changes,
        warnings,
        requiresConfirmation: warnings.some((warning) => warning.blocking),
      };
    });

  const push: OverleafMirror["Service"]["push"] = (input) =>
    Effect.gen(function* () {
      const result: OverleafGitExecuteResult = yield* run(
        input,
        ["push", "--porcelain", "origin", `HEAD:${remoteBranch(input)}`],
        { allowNonZeroExit: true, timeoutMs: 180_000, credentialed: true, unknownOnTimeout: true },
      ).pipe(
        Effect.catch(() =>
          Effect.succeed({
            exitCode: -1,
            stdout: "",
            stdoutBytes: new Uint8Array(0),
            stderr: "",
          }),
        ),
      );
      if (result.exitCode === -1) return "unknown";
      if (result.exitCode === 0) return "confirmed";
      const failureOutput = `${result.stdout}\n${result.stderr}`;
      if (/non-fast-forward|fetch first|rejected/iu.test(failureOutput)) return "race";
      if (/authentication|access denied|forbidden|403|401/iu.test(failureOutput))
        return yield* classifyRemoteFailure(failureOutput);
      if (
        /could not resolve host|certificate|ssl|tls|schannel|\b429\b|rate.?limit/iu.test(
          failureOutput,
        )
      )
        return yield* classifyRemoteFailure(failureOutput);
      return "unknown";
    });

  const treeHash: OverleafMirror["Service"]["treeHash"] = (input) =>
    run(input, ["rev-parse", `${input.commit}^{tree}`]).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.mapError(mapGitError("Unable to identify an Overleaf tree.")),
    );

  const candidateAccepted: OverleafMirror["Service"]["candidateAccepted"] = (input) =>
    Effect.gen(function* () {
      const head = yield* fetch(input);
      const headTree = yield* treeHash({ ...input, commit: head });
      if (
        uncertainPushWasAccepted({
          candidateTree: input.candidateTree,
          headTree,
          firstParentTrees: [],
          candidateCommitReachable: false,
        })
      )
        return { accepted: true, head };
      const history = (yield* run(input, [
        "rev-list",
        "--first-parent",
        `${input.prePushBase}..${head}`,
      ])).stdout
        .split("\n")
        .filter(Boolean);
      for (const commit of history) {
        const historyTree = yield* treeHash({ ...input, commit });
        if (
          uncertainPushWasAccepted({
            candidateTree: input.candidateTree,
            headTree,
            firstParentTrees: [historyTree],
            candidateCommitReachable: false,
          })
        )
          return { accepted: true, head };
      }
      const reachable = yield* run(
        input,
        ["merge-base", "--is-ancestor", input.candidateCommit, head],
        { allowNonZeroExit: true },
      );
      return {
        accepted: uncertainPushWasAccepted({
          candidateTree: input.candidateTree,
          headTree,
          firstParentTrees: [],
          candidateCommitReachable: reachable.exitCode === 0,
        }),
        head,
      };
    });

  return OverleafMirror.of({
    mirrorRoot,
    initialize,
    discoverBranch,
    fetch,
    checkout,
    manifest,
    applyWorkspace,
    stageAll,
    hasChanges,
    commitSnapshot,
    retainWorkspaceBase,
    releaseOperationRef,
    rebaseSnapshot,
    rebaseRangeOnto,
    conflicts,
    materializeBlob,
    resolveConflict,
    continueRebase,
    abortRebase,
    review,
    push,
    treeHash,
    candidateAccepted,
  });
});

export const layer = Layer.effect(OverleafMirror, make());
