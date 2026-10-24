// @effect-diagnostics nodeBuiltinImport:off -- Real paths of thread checkouts.
/**
 * The Overleaf service that routes and agent tools call (step 5). It puts the
 * coordinator behind the workspace authority and the stored token, and adds the
 * product's sync rule (pr-c-design.md section 4): only a conflict stops a sync.
 * A sync prepares a review with the default selections and, when it has no
 * conflict without a choice, confirms it at once with its acknowledgements. A
 * review rebuilt because the folder changed is confirmed the same way, and an
 * out-of-date push starts one new sync. The engine's own rules are unchanged:
 * everything still goes through the exact review that was built.
 *
 * Authority (contract rules 2 and 3, pr-c-design.md section 6): a request names
 * the caller's workspace or thread, which the server resolves. A connection is
 * used only while its own checkout is still the binding it recorded, and only by
 * callers in the same host project; a caller in another worktree acts on the
 * linked copy, and the result says so.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import type {
  ResolvedThreadWorkspaceBinding,
  WorkspaceBindingId,
} from "../projectScope/WorkspaceBinding.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceBindingStore from "../projectScope/WorkspaceBindingStore.ts";
import {
  gitRefusal,
  makeOverleafConnections,
  type OverleafConnectionStatus,
  type OverleafConnectionSummary,
  parseOverleafProject,
} from "./OverleafConnections.ts";
import type { OverleafConnectionDocument } from "./OverleafConnectionState.ts";
import * as OverleafCoordinator from "./OverleafCoordinator.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import { newOverleafId } from "./OverleafGitExecutor.ts";
import * as OverleafRepositoryModule from "./OverleafRepository.ts";
import { OverleafRepository } from "./OverleafRepository.ts";
import { macVolumeUuid, type OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import type { OverleafReview } from "./OverleafReview.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";
import * as OverleafStateStoreModule from "./OverleafStateStore.ts";
import type { ConflictChoice } from "./syncRules.ts";
import * as WorkspaceApplierModule from "./WorkspaceApplier.ts";

/** Per-file decisions on what a sync sends (pr-c-design section 5). */
export interface OverleafFileDecisions {
  /** New files to keep only on this computer (remembered until sent). */
  readonly keepOnlyHere?: ReadonlyArray<string> | undefined;
  /** Files to send anyway: ones the rule skips, or ones kept only on this computer. */
  readonly send?: ReadonlyArray<string> | undefined;
}

/** Who is asking: a window naming its workspace, or an agent's thread. Resolved on the server. */
export type OverleafCaller =
  | { readonly _tag: "workspace"; readonly workspaceRoot: string }
  | { readonly _tag: "thread"; readonly threadId: string };

/** Why the service did nothing. A fixed category, safe to show; never Git's text or a token. */
export class OverleafSyncRefusedError extends Schema.TaggedError<OverleafSyncRefusedError>()(
  "OverleafSyncRefusedError",
  {
    reason: Schema.Literals([
      /** The caller's workspace could not be resolved, or is not this connection's project. */
      "workspace-not-authorized",
      /** The connection's checkout is no longer the binding it recorded: relink it. */
      "relink-needed",
      /** No Overleaf token is saved. */
      "token-missing",
      "project-invalid",
      /** Overleaf refused the token or this account's access to the project. */
      "access-denied",
      "project-not-found",
      /** Overleaf could not be reached. */
      "unreachable",
      /** Git is missing or older than 2.39. */
      "git-unavailable",
      "git-failed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "workspace-not-authorized":
        return "This Overleaf link does not belong to this project.";
      case "relink-needed":
        return "This project's folder changed since it was linked to Overleaf. Relink it.";
      case "token-missing":
        return "No Overleaf Git token is saved. Save one first.";
      case "project-invalid":
        return "That is not an Overleaf project link or ID.";
      case "access-denied":
        return "Overleaf refused the token, or this account has no Git access to the project.";
      case "project-not-found":
        return "Overleaf has no such project.";
      case "unreachable":
        return "Overleaf could not be reached.";
      case "git-unavailable":
        return "Overleaf sync needs Git 2.39 or newer on this computer.";
      case "git-failed":
        return "Git failed while talking to Overleaf.";
    }
  }
}

/** Another agent's thread working in the connection's checkout. */
export interface OverleafOtherAgent {
  readonly threadId: string;
  readonly title: string;
}
/** Null when activity could not be read: unknown, never "no agents". */
export type OverleafActivity = ReadonlyArray<OverleafOtherAgent> | null;

/** One review, as clients see it: no bytes, no plan internals. */
export interface OverleafReviewView {
  readonly reviewId: string;
  readonly digest: string;
  /** Overleaf's tree this review was built against; conflict choices answer it. */
  readonly remoteTree: string;
  readonly upToDate: boolean;
  /** True only when a conflict has no choice yet: the one thing that stops a sync. */
  readonly needsDecision: boolean;
  readonly incoming: OverleafReview["incoming"];
  readonly outgoing: OverleafReview["outgoing"];
  readonly conflicts: ReadonlyArray<{
    readonly key: string;
    readonly paths: ReadonlyArray<string>;
    readonly allowed: ReadonlyArray<ConflictChoice>;
    readonly chosen: ConflictChoice | null;
  }>;
  readonly warnings: OverleafReview["warnings"];
  readonly unresolvedMarkers: ReadonlyArray<string>;
  readonly collisions: ReadonlyArray<string>;
  readonly selectedAdditions: ReadonlyArray<string>;
  /** Every new file: whether this sync sends it, and why it is left out by default. */
  readonly additions: ReadonlyArray<{
    readonly path: string;
    readonly size: number;
    readonly selected: boolean;
    readonly skippedBecause: string | null;
  }>;
  /** Files kept only on this computer; `send` can send them. */
  readonly localOnly: ReadonlyArray<string>;
}

const viewOverleafReview = (review: OverleafReview): OverleafReviewView => ({
  reviewId: review.id,
  digest: review.digest,
  remoteTree: review.binding.remoteTree,
  upToDate: review.upToDate,
  needsDecision: review.conflicts.some((conflict) => conflict.chosen === null),
  incoming: review.incoming,
  outgoing: review.outgoing,
  conflicts: review.conflicts.map((conflict) => ({
    key: conflict.key,
    paths: conflict.paths,
    allowed: conflict.allowed,
    chosen: conflict.chosen,
  })),
  warnings: review.warnings,
  unresolvedMarkers: review.unresolvedMarkers,
  collisions: review.collisions,
  selectedAdditions: review.binding.selectedAdditions,
  additions: review.additions.map((addition) => ({
    path: addition.path,
    size: addition.size,
    selected: addition.selected,
    skippedBecause: addition.uncheckedReason,
  })),
  localOnly: review.localOnly,
});

/** What one sync did, in the order a person or agent reads it. */
export type OverleafSyncOutcome =
  | {
      readonly _tag: "synced";
      readonly review: OverleafReviewView;
      readonly adopted: OverleafCoordinator.OverleafAdopted;
      readonly publication: OverleafCoordinator.OverleafPublication;
      /** Overleaf moved while sending, so one new sync ran. */
      readonly retried: boolean;
      readonly activity: OverleafActivity;
      /** The caller works in another checkout; this synced the linked one. */
      readonly linkedElsewhere: boolean;
    }
  /** A conflict has no choice yet. Nothing was applied or sent. */
  | {
      readonly _tag: "needs-decision";
      readonly review: OverleafReviewView;
      readonly activity: OverleafActivity;
      readonly linkedElsewhere: boolean;
    }
  | {
      readonly _tag: "refused";
      readonly refusal: Extract<
        OverleafCoordinator.OverleafPrepareResult,
        { _tag: "refused" }
      >["refusal"];
    }
  /** A repeated request: its receipt, never a second sync. */
  | {
      readonly _tag: "duplicate";
      readonly receipt: Extract<
        OverleafCoordinator.OverleafConfirmResult,
        { _tag: "duplicate" }
      >["receipt"];
    }
  /** The review kept changing under the sync, or was refused by the registry; sync again. */
  | { readonly _tag: "unsettled"; readonly reason: string }
  /** Stopped on request at a stage boundary; nothing more was applied or sent. */
  | { readonly _tag: "cancelled"; readonly stage: "before-prepare" | "before-apply" };

/** The stored token's name: one token per Overleaf site (contract section 3). */
const TOKEN_SECRET = `overleaf-git-token-${Buffer.from("www.overleaf.com", "utf8").toString("base64url")}`;
/** Reviews rebuilt in one sync before it reports the folder as unsettled. */
const STALE_ROUNDS = 3;
/** Token use takes one permit; renewal and removal take them all, so they wait for use to end. */
const CREDENTIAL_PERMITS = 64;
/** Fetch or push found no token, or another one than the review was built with. */
const CREDENTIAL_UNAVAILABLE = "credential unavailable";
type GitFailure =
  | OverleafGitExecutor.OverleafGitError
  | OverleafRepositoryModule.OverleafRepositoryError;
const isGitFailure = <E>(error: E): error is Extract<E, GitFailure> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "OverleafGitError" || error._tag === "OverleafRepositoryError");
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

export interface OverleafSyncOptions {
  readonly stateRoot: string;
  readonly environmentId: string;
  readonly exchangeHelper: string | null;
  /** Running threads with their checkout path and lineage; null when they could not be read. */
  readonly activeThreads: Effect.Effect<ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly checkoutPath: string;
    readonly parentThreadId: string | null;
    readonly subagent: boolean;
  }> | null>;
  /** Test seams. */
  readonly gitUrl?: (projectId: string) => string;
  readonly hooks?: OverleafCoordinator.OverleafCoordinatorOptions["hooks"];
  readonly volumeUuid?: OverleafVolumeIdentityResolver;
}

const make = Effect.fn("OverleafSync.make")(function* (options: OverleafSyncOptions) {
  const secrets = yield* ServerSecretStore;
  const resolver = yield* WorkspaceBindingResolver;
  const bindings = yield* WorkspaceBindingStore.WorkspaceBindingStore;
  const store = yield* OverleafStateStore;
  const repos = yield* OverleafRepository;
  const volumeUuid = options.volumeUuid ?? macVolumeUuid;
  const reservations = OverleafCoordinator.makeOverleafReservations();
  /** Advances on every token change; reviews built before it are stale. */
  let credentialEpoch = 0;
  /** The sync running for each connection here, so it can be asked to stop. */
  const syncs = new Map<string, { readonly operationId: string; cancelled: boolean }>();
  /** Contract section 3: renewal is serialized against token use. */
  const credentialLock = yield* Semaphore.make(CREDENTIAL_PERMITS);
  const credentialUnavailable = new OverleafGitExecutor.OverleafGitError({
    reason: "runtime-failed",
    exitCode: null,
    detail: CREDENTIAL_UNAVAILABLE,
  });

  const readToken = secrets.get(TOKEN_SECRET).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  const requireToken = Effect.gen(function* () {
    const token = yield* readToken;
    if (token === null || token.length === 0)
      return yield* new OverleafSyncRefusedError({ reason: "token-missing" });
    return token;
  });

  const gitUrl = options.gitUrl ?? ((projectId: string) => `https://git.overleaf.com/${projectId}`);
  const coordinator = yield* OverleafCoordinator.make({
    stateRoot: options.stateRoot,
    exchangeHelper: options.exchangeHelper,
    reservations,
    volumeUuid,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    credentialEpoch: () => credentialEpoch,
    gitUrl: (connection) => gitUrl(connection.remote.projectId),
    fetchRemote: (input) =>
      credentialLock.withPermits(1)(
        Effect.gen(function* () {
          const token = yield* readToken;
          if (token === null || token.length === 0) return yield* credentialUnavailable;
          return yield* repos.fetch({
            repo: input.repo,
            branch: input.connection.remote.branch,
            token,
          });
        }),
      ),
    // Never under another token than the review's: a renewal between send admission and
    // here fails the push before Git runs, and the attempt stays unknown, never resent.
    pushRemote: (input) =>
      credentialLock.withPermits(1)(
        Effect.gen(function* () {
          const token = yield* readToken;
          if (token === null || token.length === 0 || credentialEpoch !== input.credentialEpoch)
            return yield* credentialUnavailable;
          return yield* repos.push({
            repo: input.repo,
            commit: input.commit,
            branch: input.connection.remote.branch,
            token,
          });
        }),
      ),
  });
  const connections = yield* makeOverleafConnections({
    stateRoot: options.stateRoot,
    environmentId: options.environmentId,
    exchangeHelper: options.exchangeHelper,
    reservations,
    volumeUuid,
    gitUrl,
  });

  const resolveCaller = (caller: OverleafCaller) =>
    (caller._tag === "workspace"
      ? resolver.resolveWorkspaceRoot(caller.workspaceRoot)
      : resolver.resolveThread(ThreadId.make(caller.threadId))
    ).pipe(
      Effect.mapError(() => new OverleafSyncRefusedError({ reason: "workspace-not-authorized" })),
    );
  const authorityOf = (resolved: ResolvedThreadWorkspaceBinding) => ({
    bindingId: resolved.binding.bindingId,
    authorityGeneration: resolved.binding.authorityGeneration,
    scopeRevision: resolved.scopeRevision,
  });

  /** A Git failure as the service's fixed category; Git's own text never leaves. */
  const gitFailure = (
    error: OverleafGitExecutor.OverleafGitError | OverleafRepositoryModule.OverleafRepositoryError,
  ) =>
    new OverleafSyncRefusedError({
      reason:
        error._tag === "OverleafGitError" && error.detail === CREDENTIAL_UNAVAILABLE
          ? "token-missing"
          : (() => {
              const category = gitRefusal(error);
              return category === "no-branch" || category === "local-work-pending"
                ? "git-failed"
                : category === "access-denied" ||
                    category === "project-not-found" ||
                    category === "unreachable" ||
                    category === "git-unavailable"
                  ? category
                  : "git-failed";
            })(),
    });
  /** Runs a coordinator operation under the caller's authority, with Git failures as categories. */
  const engine = <A, E, R>(
    guard: (connection: OverleafConnectionDocument) => Effect.Effect<boolean>,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.provideService(OverleafCoordinator.OverleafAuthorityGuard, guard),
      Effect.catchIf(isGitFailure<E>, (error) => Effect.fail(gitFailure(error))),
    );

  /** The caller's authority, as resolved for this request, still holds. */
  const callerCurrent = (caller: OverleafCaller, resolved: ResolvedThreadWorkspaceBinding) =>
    (caller._tag === "workspace"
      ? resolver.assertCurrentWorkspaceScope({
          workspaceRoot: resolved.binding.canonicalRoot,
          bindingId: resolved.binding.bindingId,
          authorityGeneration: resolved.binding.authorityGeneration,
          scopeRevision: resolved.scopeRevision,
        })
      : resolver.assertCurrentThreadScope({
          threadId: ThreadId.make(caller.threadId),
          bindingId: resolved.binding.bindingId,
          authorityGeneration: resolved.binding.authorityGeneration,
          scopeRevision: resolved.scopeRevision,
        })
    ).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  /** Whether a recorded binding belongs to the caller's environment and host project. */
  const ownedBy = (resolved: ResolvedThreadWorkspaceBinding) => (bindingId: string) =>
    bindings.getById(bindingId as WorkspaceBindingId).pipe(
      Effect.map(
        (owner) =>
          owner !== null &&
          owner.environmentId === resolved.binding.environmentId &&
          owner.hostProjectId === resolved.binding.hostProjectId,
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * The connection, if the caller may use it: its checkout is still the binding it
   * recorded, and the caller is in the same host project (another worktree acts on it).
   * `guard` re-checks both authorities, as resolved now, before every change to the
   * folder and inside send admission (contract rule 2).
   */
  const authorize = Effect.fn("OverleafSync.authorize")(function* (
    caller: OverleafCaller,
    connectionId: string,
  ) {
    const resolved = yield* resolveCaller(caller);
    const read = yield* store.readConnection(connectionId);
    if (read._tag !== "ready" || read.document.environmentId !== options.environmentId)
      return yield* new OverleafSyncRefusedError({ reason: "workspace-not-authorized" });
    const document = read.document;
    const linked = yield* resolver
      .resolveWorkspaceRoot(document.checkout.canonicalRoot)
      .pipe(Effect.mapError(() => new OverleafSyncRefusedError({ reason: "relink-needed" })));
    if (linked.binding.hostProjectId !== resolved.binding.hostProjectId)
      return yield* new OverleafSyncRefusedError({ reason: "workspace-not-authorized" });
    if (
      linked.binding.bindingId !== document.binding.bindingId ||
      linked.binding.authorityGeneration !== document.binding.authorityGeneration
    )
      return yield* new OverleafSyncRefusedError({ reason: "relink-needed" });
    const guard = (connection: OverleafConnectionDocument) =>
      checkAuthority(connection).pipe(Effect.orElseSucceed(() => false));
    const checkAuthority = Effect.fn("OverleafSync.checkAuthority")(function* (
      connection: OverleafConnectionDocument,
    ) {
      if (!(yield* callerCurrent(caller, resolved))) return false;
      yield* resolver.assertCurrentWorkspaceScope({
        workspaceRoot: connection.checkout.canonicalRoot,
        bindingId: linked.binding.bindingId,
        authorityGeneration: linked.binding.authorityGeneration,
        scopeRevision: linked.scopeRevision,
      });
      return (
        connection.binding.bindingId === linked.binding.bindingId &&
        connection.binding.authorityGeneration === linked.binding.authorityGeneration
      );
    });
    return {
      document,
      guard,
      callerBindingId: resolved.binding.bindingId,
      linkedElsewhere: linked.binding.bindingId !== resolved.binding.bindingId,
    };
  });

  /** Two readings of activity: anyone seen in either; unknown if either is unknown. */
  const mergeActivity = (left: OverleafActivity, right: OverleafActivity): OverleafActivity =>
    left === null || right === null
      ? null
      : [
          ...left,
          ...right.filter((agent) => !left.some((seen) => seen.threadId === agent.threadId)),
        ];

  /** Other agents running in the connection's checkout; the caller and its subagents don't count. */
  const activityFor = Effect.fn("OverleafSync.activityFor")(function* (
    document: OverleafConnectionDocument,
    caller: OverleafCaller,
  ) {
    const threads = yield* options.activeThreads;
    if (threads === null) return null;
    const self = caller._tag === "thread" ? caller.threadId : null;
    const others: OverleafOtherAgent[] = [];
    for (const thread of threads) {
      if (
        self !== null &&
        (thread.threadId === self || (thread.subagent && thread.parentThreadId === self))
      )
        continue;
      const real = yield* Effect.promise(() =>
        NodeFSP.realpath(thread.checkoutPath).catch(() => null),
      );
      if (real === document.checkout.canonicalRoot)
        others.push({ threadId: thread.threadId, title: thread.title });
    }
    return others as OverleafActivity;
  });

  const tokenStatus = Effect.map(readToken, (token) => ({
    saved: token !== null && token.length > 0,
  }));
  const saveToken = Effect.fn("OverleafSync.saveToken")(function* (token: string) {
    const trimmed = token.trim();
    if (trimmed.length === 0 || /\s/u.test(trimmed) || trimmed.length > 512)
      return yield* new OverleafSyncRefusedError({ reason: "token-missing" });
    yield* credentialLock.withPermits(CREDENTIAL_PERMITS)(
      Effect.gen(function* () {
        yield* secrets.set(TOKEN_SECRET, new TextEncoder().encode(trimmed));
        credentialEpoch++;
      }),
    );
  });
  const removeToken = credentialLock.withPermits(CREDENTIAL_PERMITS)(
    Effect.gen(function* () {
      yield* secrets.remove(TOKEN_SECRET);
      credentialEpoch++;
    }),
  );

  const list = Effect.fn("OverleafSync.list")(function* (caller: OverleafCaller) {
    const resolved = yield* resolveCaller(caller);
    const owns = ownedBy(resolved);
    const result: Array<OverleafConnectionSummary & { readonly linkedHere: boolean }> = [];
    for (const document of yield* connections.documents) {
      if (document.state !== "active") continue;
      // Ownership is the recorded binding's project, whatever the folder's path resolves to now.
      if (!(yield* owns(document.binding.bindingId))) continue;
      const summary = (yield* connections.list({
        checkoutRoot: document.checkout.canonicalRoot,
      })).find((entry) => entry.connectionId === document.connectionId);
      if (summary !== undefined)
        result.push({
          ...summary,
          linkedHere: document.binding.bindingId === resolved.binding.bindingId,
        });
    }
    return result;
  });

  const connect = Effect.fn("OverleafSync.connect")(function* (input: {
    readonly caller: OverleafCaller;
    readonly folder: string;
    readonly create: boolean;
    readonly project: string;
    readonly requestId: string;
  }) {
    // An invalid project is refused inside connect, so the refusal has its receipt.
    const projectId = parseOverleafProject(input.project) ?? input.project.slice(0, 2_048);
    const resolved = yield* resolveCaller(input.caller);
    // The token is read and used under one credential permit: renewal waits for it.
    return yield* credentialLock.withPermits(1)(
      Effect.gen(function* () {
        const token = yield* requireToken;
        return yield* connections.connect({
          authority: authorityOf(resolved),
          checkoutRoot: resolved.binding.canonicalRoot,
          folder: input.folder,
          create: input.create,
          projectId,
          token,
          requestId: input.requestId,
          stillAuthorized: callerCurrent(input.caller, resolved),
          owns: ownedBy(resolved),
        });
      }),
    );
  });

  const status = Effect.fn("OverleafSync.status")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
  }) {
    const { linkedElsewhere } = yield* authorize(input.caller, input.connectionId);
    const found: OverleafConnectionStatus = yield* connections.status({
      connectionId: input.connectionId,
    });
    return { ...found, linkedElsewhere };
  });

  const preview = Effect.fn("OverleafSync.preview")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
    readonly choices?: ReadonlyMap<string, ConflictChoice>;
    readonly files?: OverleafFileDecisions;
  }) {
    const { guard } = yield* authorize(input.caller, input.connectionId);
    yield* requireToken;
    const prepared = yield* engine(
      guard,
      Effect.gen(function* () {
        const selections = yield* selectionsFor(input, input.choices ?? new Map());
        return yield* coordinator.prepare({ connectionId: input.connectionId, selections });
      }),
    );
    if (prepared._tag === "review")
      return { _tag: "review" as const, review: viewOverleafReview(prepared.review) };
    return prepared;
  });

  /**
   * The engine's selections for a request: the default new-file selection, the
   * conflict choices, and any per-file decisions. "Keep only here" leaves a new
   * file out (remembered); "send" sends a file the rule skips or one kept only
   * here. Per-file decisions need to know which paths are new files, so a first
   * review with the defaults is read; collisions are found by the review itself.
   */
  const selectionsFor = Effect.fn("OverleafSync.selectionsFor")(function* (
    input: { readonly connectionId: string; readonly files?: OverleafFileDecisions },
    choices: ReadonlyMap<string, ConflictChoice>,
  ) {
    const keep = new Set(input.files?.keepOnlyHere ?? []);
    const send = new Set(input.files?.send ?? []);
    if (keep.size === 0 && send.size === 0)
      return { collisionPaths: [], choices } satisfies OverleafCoordinator.OverleafSelections;
    const first = yield* coordinator.prepare({
      connectionId: input.connectionId,
      selections: { collisionPaths: [], choices },
    });
    if (first._tag !== "review")
      return { collisionPaths: [], choices } satisfies OverleafCoordinator.OverleafSelections;
    const additions = new Set(first.review.additions.map((addition) => addition.path));
    return {
      selectedAdditions: first.review.additions
        .filter(
          (addition) => (addition.selected || send.has(addition.path)) && !keep.has(addition.path),
        )
        .map((addition) => addition.path),
      sendLocalOnly: [...send].filter((path) => !additions.has(path)),
      collisionPaths: [],
      choices,
    } satisfies OverleafCoordinator.OverleafSelections;
  });

  const sync = Effect.fn("OverleafSync.sync")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
    readonly requestId: string;
    /** Conflict choices by conflict key: how a person or agent settles a conflict. */
    readonly choices?: ReadonlyMap<string, ConflictChoice>;
    /**
     * Overleaf's tree of the review whose conflicts the choices answer (its
     * `remoteTree`). If Overleaf has moved since, the choices are not applied to its
     * new content: the sync asks again.
     */
    readonly reviewedRemote?: string;
    /** Per-file decisions: keep a new file only here, or send a skipped or kept file. */
    readonly files?: OverleafFileDecisions;
  }) {
    const { document, guard, linkedElsewhere } = yield* authorize(input.caller, input.connectionId);
    yield* requireToken;
    // One sync per connection here: claimed before anything else, and never replaced
    // by a competitor, so cancel always reaches the running one.
    if (syncs.has(input.connectionId))
      return yield* new OverleafCoordinator.OverleafOperationActiveError({
        connectionId: input.connectionId,
      });
    const running = { operationId: newOverleafId(), cancelled: false };
    syncs.set(input.connectionId, running);
    // The connection is held for the whole sync, gaps included: a disconnect or relink
    // can't slip in between its steps. Its own coordinator calls run under this hold.
    return yield* OverleafCoordinator.reserveOverleafConnection(
      reservations,
      input.connectionId,
      (owner) =>
        syncClaimed(input, document, guard, linkedElsewhere, running).pipe(
          Effect.provideService(OverleafCoordinator.OverleafReservationOwner, owner),
        ),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (syncs.get(input.connectionId) === running) syncs.delete(input.connectionId);
        }),
      ),
    );
  });

  const syncClaimed = Effect.fn("OverleafSync.syncClaimed")(function* (
    input: {
      readonly caller: OverleafCaller;
      readonly connectionId: string;
      readonly requestId: string;
      readonly choices?: ReadonlyMap<string, ConflictChoice>;
      readonly reviewedRemote?: string;
      readonly files?: OverleafFileDecisions;
    },
    document: OverleafConnectionDocument,
    guard: (connection: OverleafConnectionDocument) => Effect.Effect<boolean>,
    linkedElsewhere: boolean,
    running: { readonly operationId: string; cancelled: boolean },
  ) {
    // The sync's own receipt: a repeated request returns it instead of syncing again.
    yield* store.admitWritable;
    const started = DateTime.formatIso(yield* DateTime.now);
    const begun = yield* store.beginReceipt({
      schemaVersion: 1,
      connectionId: input.connectionId,
      requestId: input.requestId,
      kind: "confirm",
      payloadDigest: sha256(
        [
          "sync",
          input.reviewedRemote ?? "",
          ...(input.files?.keepOnlyHere ?? []).map((path) => `keep=${path}`).sort(),
          ...(input.files?.send ?? []).map((path) => `send=${path}`).sort(),
          ...[...(input.choices ?? new Map())].map(([key, choice]) => `${key}=${choice}`).sort(),
        ].join("\0"),
      ),
      operationId: running.operationId,
      status: "running",
      resultCategory: null,
      createdAt: started,
      updatedAt: started,
    });
    if (begun._tag === "existing")
      return { _tag: "duplicate", receipt: begun.receipt } satisfies OverleafSyncOutcome;
    const outcome = yield* engine(guard, syncOnce(input, document, linkedElsewhere, running)).pipe(
      Effect.tapError(() =>
        store
          .finishReceipt({
            connectionId: input.connectionId,
            requestId: input.requestId,
            status: "failed",
            resultCategory: "error",
          })
          .pipe(Effect.ignore),
      ),
    );
    yield* store
      .finishReceipt({
        connectionId: input.connectionId,
        requestId: input.requestId,
        status: "completed",
        resultCategory:
          outcome._tag === "synced" ? `synced-${outcome.publication._tag}` : outcome._tag,
      })
      .pipe(Effect.ignore);
    return outcome;
  });

  const syncOnce = Effect.fn("OverleafSync.syncOnce")(function* (
    input: {
      readonly caller: OverleafCaller;
      readonly connectionId: string;
      readonly requestId: string;
      readonly choices?: ReadonlyMap<string, ConflictChoice>;
      readonly reviewedRemote?: string;
      readonly files?: OverleafFileDecisions;
    },
    document: OverleafConnectionDocument,
    linkedElsewhere: boolean,
    running: { readonly operationId: string; readonly cancelled: boolean },
  ) {
    const before = yield* activityFor(document, input.caller);
    // Read again at the end, so an agent that started meanwhile is reported too.
    const activityNow = Effect.map(activityFor(document, input.caller), (after) =>
      mergeActivity(before, after),
    );
    let retried = false;
    // Choices answer conflicts as they stood against one Overleaf tree. When Overleaf
    // has moved since (a new sync after out-of-date, a rebuilt review), the conflicts
    // are shown again without them rather than settled on content nobody saw.
    let decidedAgainst = input.reviewedRemote ?? null;
    const askAgain = (review: OverleafReview) =>
      input.choices !== undefined &&
      input.choices.size > 0 &&
      review.conflicts.length > 0 &&
      decidedAgainst !== null &&
      review.binding.remoteTree !== decidedAgainst;
    for (let attempt = 0; ; attempt++) {
      // Per attempt, so a file that appears meanwhile gets the default rule.
      const prepareInput = {
        connectionId: input.connectionId,
        selections: yield* selectionsFor(input, input.choices ?? new Map()),
      };
      // Cancellation stops at stage boundaries only: never inside an apply or a send.
      if (running.cancelled)
        return { _tag: "cancelled", stage: "before-prepare" } satisfies OverleafSyncOutcome;
      // An interrupted apply is finished first; the review is then built on its result.
      let prepared = yield* coordinator.prepare(prepareInput);
      if (prepared._tag === "recovered") prepared = yield* coordinator.prepare(prepareInput);
      if (prepared._tag === "refused")
        return { _tag: "refused", refusal: prepared.refusal } satisfies OverleafSyncOutcome;
      if (prepared._tag === "recovered")
        return { _tag: "unsettled", reason: "recovery-repeated" } satisfies OverleafSyncOutcome;
      let review = prepared.review;
      for (let round = 0; ; round++) {
        if (decidedAgainst === null && input.choices !== undefined && review.conflicts.length > 0)
          decidedAgainst = review.binding.remoteTree;
        if (askAgain(review)) {
          // The decided choices no longer apply: build the review without them. Only a
          // conflict still needing a choice stops; otherwise it is confirmed as usual.
          const fresh = yield* coordinator.prepare({
            connectionId: input.connectionId,
            selections: yield* selectionsFor(input, new Map()),
          });
          if (fresh._tag !== "review")
            return { _tag: "unsettled", reason: "overleaf-moved" } satisfies OverleafSyncOutcome;
          if (fresh.review.conflicts.length > 0)
            return {
              _tag: "needs-decision",
              review: viewOverleafReview(fresh.review),
              activity: yield* activityNow,
              linkedElsewhere,
            } satisfies OverleafSyncOutcome;
          review = fresh.review;
          decidedAgainst = null;
        }
        const view = viewOverleafReview(review);
        if (view.needsDecision)
          return {
            _tag: "needs-decision",
            review: view,
            activity: yield* activityNow,
            linkedElsewhere,
          } satisfies OverleafSyncOutcome;
        if (running.cancelled)
          return { _tag: "cancelled", stage: "before-apply" } satisfies OverleafSyncOutcome;
        // Server-only request IDs: 64 characters, longer than any a client may send.
        const confirmed = yield* coordinator.confirm({
          connectionId: input.connectionId,
          requestId: sha256(`${running.operationId}\0${attempt}\0${round}`),
          reviewId: review.id,
          digest: review.digest,
          acknowledgements: review.binding.acknowledgements,
        });
        switch (confirmed._tag) {
          case "applied":
            if (confirmed.publication._tag === "out-of-date" && attempt === 0) {
              retried = true;
              break;
            }
            return {
              _tag: "synced",
              review: view,
              adopted: confirmed.adopted,
              publication: confirmed.publication,
              retried,
              activity: yield* activityNow,
              linkedElsewhere,
            } satisfies OverleafSyncOutcome;
          case "stale":
            if (round + 1 >= STALE_ROUNDS)
              return {
                _tag: "unsettled",
                reason: "folder-kept-changing",
              } satisfies OverleafSyncOutcome;
            review = confirmed.review;
            continue;
          case "review-refused":
            return { _tag: "unsettled", reason: confirmed.reason } satisfies OverleafSyncOutcome;
          case "refused":
            return { _tag: "refused", refusal: confirmed.refusal } satisfies OverleafSyncOutcome;
          case "duplicate":
            return { _tag: "duplicate", receipt: confirmed.receipt } satisfies OverleafSyncOutcome;
        }
        break;
      }
    }
  });

  const recover = Effect.fn("OverleafSync.recover")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
  }) {
    const { guard } = yield* authorize(input.caller, input.connectionId);
    return yield* engine(guard, coordinator.recover({ connectionId: input.connectionId }));
  });

  const keptCopies = Effect.fn("OverleafSync.keptCopies")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
  }) {
    const { guard } = yield* authorize(input.caller, input.connectionId);
    return yield* engine(guard, coordinator.keptCopies({ connectionId: input.connectionId }));
  });

  const restoreKept = Effect.fn("OverleafSync.restoreKept")(function* (
    input: { readonly caller: OverleafCaller } & Parameters<
      OverleafCoordinator.OverleafCoordinator["Service"]["restoreKept"]
    >[0],
  ) {
    const { guard } = yield* authorize(input.caller, input.connectionId);
    const { caller: _caller, ...request } = input;
    return yield* engine(guard, coordinator.restoreKept(request));
  });

  const disconnect = Effect.fn("OverleafSync.disconnect")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
    readonly requestId: string;
  }) {
    const { guard, callerBindingId } = yield* authorize(input.caller, input.connectionId);
    return yield* connections.disconnect({
      connectionId: input.connectionId,
      requestId: input.requestId,
      callerBindingId,
      stillAuthorized: guard,
    });
  });

  /**
   * Asks the connection's running sync to stop at its next stage boundary: before it
   * prepares again or applies. An apply or a send in progress always finishes, and
   * its outcome stands; a stop after a possible send leaves that send unknown.
   */
  const cancel = Effect.fn("OverleafSync.cancel")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
  }) {
    yield* authorize(input.caller, input.connectionId);
    const running = syncs.get(input.connectionId);
    if (running === undefined) return { _tag: "nothing-running" as const };
    running.cancelled = true;
    return { _tag: "requested" as const, operationId: running.operationId };
  });

  /** Records the connection's folder in the caller's checkout as it is now. History survives. */
  const relink = Effect.fn("OverleafSync.relink")(function* (input: {
    readonly caller: OverleafCaller;
    readonly connectionId: string;
    readonly folder: string;
    readonly requestId: string;
  }) {
    const resolved = yield* resolveCaller(input.caller);
    const read = yield* store.readConnection(input.connectionId);
    if (read._tag !== "ready" || read.document.environmentId !== options.environmentId)
      return yield* new OverleafSyncRefusedError({ reason: "workspace-not-authorized" });
    // The connection's owner is the host project of the binding it recorded, found by
    // that binding's ID even when its checkout is gone. Unknown ownership fails closed.
    const owner = yield* bindings
      .getById(read.document.binding.bindingId as WorkspaceBindingId)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      owner === null ||
      owner.environmentId !== resolved.binding.environmentId ||
      owner.hostProjectId !== resolved.binding.hostProjectId
    )
      return yield* new OverleafSyncRefusedError({ reason: "workspace-not-authorized" });
    return yield* connections.relink({
      connectionId: input.connectionId,
      requestId: input.requestId,
      authority: authorityOf(resolved),
      checkoutRoot: resolved.binding.canonicalRoot,
      folder: input.folder,
      stillAuthorized: callerCurrent(input.caller, resolved),
    });
  });

  return {
    tokenStatus,
    saveToken,
    removeToken,
    list,
    connect,
    status,
    preview,
    sync,
    recover,
    keptCopies,
    restoreKept,
    disconnect,
    cancel,
    relink,
  };
});

export type OverleafSyncShape = Effect.Success<ReturnType<typeof make>>;

/** @public Context tag; routes and agent tools call it. */
export class OverleafSync extends Context.Service<OverleafSync, OverleafSyncShape>()(
  "t3/scient/overleaf/OverleafSync",
) {}

export const makeOverleafSync = make;

/**
 * The server's Overleaf service: its own state store, private repositories,
 * applier and Git, under `stateDir/overleaf`. Running threads come from the
 * thread shell, each in its worktree or else its project's folder.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const stateRoot = NodePath.join(config.stateDir, "overleaf");
    const engine = Layer.mergeAll(
      OverleafStateStoreModule.layer,
      WorkspaceApplierModule.layer,
      OverleafRepositoryModule.layer.pipe(
        Layer.provide(
          OverleafGitExecutor.layer({ runtimeRoot: NodePath.join(stateRoot, "runtime") }),
        ),
      ),
    );
    return Layer.effect(
      OverleafSync,
      Effect.gen(function* () {
        const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
        const threads = yield* ThreadManagementService;
        const projects = yield* ProjectService;
        const activeThreads = Effect.gen(function* () {
          const [shell, snapshot] = yield* Effect.all([
            threads.getShellSnapshot(),
            projects.snapshot,
          ]);
          const roots = new Map(
            snapshot.projects.map((project) => [project.id, project.workspaceRoot]),
          );
          return shell.threads.flatMap((thread) => {
            const checkoutPath = thread.worktreePath ?? roots.get(thread.projectId);
            const working =
              thread.activeRunId !== null ||
              (thread.activityRunStatus ?? null) !== null ||
              (thread.pendingBackgroundTasks?.length ?? 0) > 0;
            return !working || checkoutPath === undefined
              ? []
              : [
                  {
                    threadId: thread.id,
                    title: thread.title,
                    checkoutPath,
                    parentThreadId: thread.lineage.parentThreadId,
                    subagent: thread.lineage.relationshipToParent === "subagent",
                  },
                ];
          });
        }).pipe(Effect.orElseSucceed(() => null));
        return yield* make({
          stateRoot,
          environmentId,
          exchangeHelper: config.fileExchangePath ?? null,
          activeThreads,
        });
      }),
    ).pipe(Layer.provide(engine));
  }),
);
