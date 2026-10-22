// @effect-diagnostics nodeBuiltinImport:off -- Folder identities and private scratch folders.
/**
 * The local half of a manual Overleaf sync (coordinator contract sections 3, 4,
 * 6 and 9; step 3b). It prepares reviews, applies a confirmed one to the
 * folder, recovers an interrupted apply and adopts the applier's result into
 * the connection. It never publishes: step 4 continues from an adopted result.
 *
 * Lock order: the connection's operation reservation (in memory, refused rather
 * than queued), then the checkout barrier's application section, then the
 * store's compare-and-set, then the file layer's own locks. Fetching Overleaf
 * happens before the section is taken.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CheckoutBarrier,
  type CheckoutLookupError,
  CheckoutRecoveryRequiredError,
  type CheckoutSection,
  type CheckoutSuspendedError,
} from "../workspace/CheckoutBarrier.ts";
import { bytesRevision, fileRevision } from "../workspace/RetainedFileMutation.ts";
import {
  overleafRequiredPins,
  type OverleafConnectionDocument,
  type OverleafOperationReceipt,
} from "./OverleafConnectionState.ts";
import { newOverleafId, type OverleafGitError } from "./OverleafGitExecutor.ts";
import { captureOverleafInventory, type OverleafInventoryRefusal } from "./OverleafInventory.ts";
import { OverleafRepository, type OverleafRepositoryError } from "./OverleafRepository.ts";
import { macVolumeUuid, type OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import {
  buildOverleafReview,
  type OverleafReview,
  type OverleafReviewRefusal,
} from "./OverleafReview.ts";
import {
  makeOverleafReviewRegistry,
  overleafReviewStaleness,
  type OverleafReviewRegistry,
  type OverleafReviewStaleReason,
  type OverleafReviewTakeRefusal,
} from "./OverleafReviewRegistry.ts";
import {
  OverleafStateStore,
  type OverleafConnectionStaleError,
  type OverleafConnectionUnavailableError,
  type OverleafRecordInvalidError,
  type OverleafRequestReusedError,
  type OverleafRetentionUnavailableError,
  type OverleafStateIoError,
  type OverleafStateLockedError,
  type OverleafTransitionRejectedError,
} from "./OverleafStateStore.ts";
import type { ConflictChoice } from "./syncRules.ts";
import {
  WorkspaceApplier,
  type WorkspaceApplyError,
  type WorkspaceApplyResult,
} from "./WorkspaceApplier.ts";

/** Another operation holds this connection. Admission never queues. */
export class OverleafOperationActiveError extends Schema.TaggedError<OverleafOperationActiveError>()(
  "OverleafOperationActiveError",
  { connectionId: Schema.String },
) {
  override get message(): string {
    return "Another Overleaf operation is running for this project.";
  }
}

/** The connection cannot run local work now; `reason` says why. */
export class OverleafConnectionNotReadyError extends Schema.TaggedError<OverleafConnectionNotReadyError>()(
  "OverleafConnectionNotReadyError",
  {
    connectionId: Schema.String,
    reason: Schema.Literals([
      "missing",
      "corrupt",
      "unsupported",
      "archived",
      "folder-changed",
      "recovery-required",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "This Overleaf connection does not exist.";
      case "corrupt":
      case "unsupported":
        return "This Overleaf connection's record cannot be read.";
      case "archived":
        return "This Overleaf connection was disconnected.";
      case "folder-changed":
        return "The project folder is not the one this connection recorded.";
      case "recovery-required":
        return "An earlier Overleaf sync in this project did not finish. Recover it first.";
    }
  }
}

/** Adoption would keep more replaced files than a connection can record. */
export class OverleafRetainedLimitError extends Schema.TaggedError<OverleafRetainedLimitError>()(
  "OverleafRetainedLimitError",
  { connectionId: Schema.String },
) {
  override get message(): string {
    return "This sync would keep more replaced files than Scient can track. Release kept copies first.";
  }
}

/** The connection's selections: what a review was built from, and is rebuilt from. */
export interface OverleafSelections {
  readonly selectedAdditions: ReadonlyArray<string>;
  /** Local paths read in full because Overleaf has content at their place. */
  readonly collisionPaths: ReadonlyArray<string>;
  readonly choices: ReadonlyMap<string, ConflictChoice>;
}

export type OverleafPrepareResult =
  | { readonly _tag: "review"; readonly review: OverleafReview }
  | {
      readonly _tag: "refused";
      readonly refusal: OverleafReviewRefusal | OverleafInventoryRefusal;
    }
  /** A pending apply was recovered but needs review before anything else. */
  | { readonly _tag: "recovered"; readonly recovery: OverleafAdopted };

/** What one apply did to the folder and the connection. */
export interface OverleafAdopted {
  readonly applyId: string;
  readonly outcome: WorkspaceApplyResult["outcome"];
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  readonly markerPaths: ReadonlyArray<string>;
  readonly baseGeneration: number;
}

export type OverleafConfirmResult =
  | { readonly _tag: "applied"; readonly adopted: OverleafAdopted }
  /** The review no longer describes the folder or Overleaf; `review` replaces it. */
  | {
      readonly _tag: "stale";
      readonly reason: OverleafReviewStaleReason;
      readonly review: OverleafReview;
    }
  | { readonly _tag: "review-refused"; readonly reason: OverleafReviewTakeRefusal }
  | {
      readonly _tag: "refused";
      readonly refusal: OverleafReviewRefusal | OverleafInventoryRefusal;
    }
  /** The same request was confirmed before; its receipt, never a second apply. */
  | { readonly _tag: "duplicate"; readonly receipt: OverleafOperationReceipt };

/** One kept copy compared with what stands now. */
export interface OverleafKeptCopy {
  readonly applyId: string;
  /** Identifies the copy: a step may keep more than one version of one path. */
  readonly kept: string;
  readonly relativePath: string;
  readonly state: OverleafConnectionDocument["retention"]["copies"][number]["state"];
  readonly retainedAt: string;
  /** The copy's bytes when kept. */
  readonly revision: string;
  /** The copy's bytes now; different from `revision` means a late writer, null means gone. */
  readonly keptRevision: string | null;
  /** The folder's file now; null when absent. */
  readonly currentRevision: string | null;
}

export type OverleafRestoreResult =
  | { readonly _tag: "restored"; readonly adopted: OverleafAdopted }
  /** The copy or the folder's file is no longer what the request saw; nothing was written. */
  | { readonly _tag: "stale" }
  | { readonly _tag: "unknown-copy" }
  | { readonly _tag: "duplicate"; readonly receipt: OverleafOperationReceipt };

export type OverleafRecoverResult =
  | { readonly _tag: "none" }
  | { readonly _tag: "recovered"; readonly adopted: OverleafAdopted };

type FetchError = OverleafRepositoryError | OverleafGitError;
/** Everything a coordinator operation can fail with; business outcomes are results instead. */
export type OverleafCoordinatorError =
  | OverleafOperationActiveError
  | OverleafConnectionNotReadyError
  | OverleafRetainedLimitError
  | CheckoutSuspendedError
  | CheckoutLookupError
  | FetchError
  | WorkspaceApplyError
  | OverleafStateIoError
  | OverleafStateLockedError
  | OverleafConnectionStaleError
  | OverleafConnectionUnavailableError
  | OverleafTransitionRejectedError
  | OverleafRecordInvalidError
  | OverleafRequestReusedError
  | OverleafRetentionUnavailableError;

export interface OverleafCoordinatorOptions {
  /** `stateDir/overleaf`: repositories and scratch folders live here. */
  readonly stateRoot: string;
  /** The host's exchange helper; null only for the declared development fallback. */
  readonly exchangeHelper: string | null;
  /** Fetches Overleaf's branch into `repo`. Step 4 supplies the authenticated fetch. */
  readonly fetchRemote: (input: {
    readonly repo: string;
    readonly connection: OverleafConnectionDocument;
  }) => Effect.Effect<{ readonly commit: string; readonly tree: string }, FetchError>;
  /** The host credential epoch; renewing the token advances it. */
  readonly credentialEpoch?: () => number;
  /** Test seam: the disk's volume UUID for a path. Defaults to `diskutil`. */
  readonly volumeUuid?: OverleafVolumeIdentityResolver;
  readonly registry?: OverleafReviewRegistry;
  /** Fault points for tests: a throw stops the operation there, as a crash would. */
  readonly hooks?: {
    readonly at?: (point: "linked" | "applied" | "adopted") => Effect.Effect<void>;
  };
}

const RETAINED_COPY_LIMIT = 4_096;
/** A kept copy's place in the retention folder, as `OverleafConnectionState` records it. */
const KEPT_PATH =
  /^[a-z0-9][a-z0-9-]{0,63}\/files\/step-\d{1,5}(?:-\d{1,5})?\/(?:retained|slot|provisional)$/u;
/** Versions one changed path can keep: the displaced file, a staged copy, a provisional capture. */
const KEPT_PER_PATH = 3;
/** The largest kept file a restore reads back. */
const RESTORE_MAX_BYTES = 50 * 1024 * 1024;
const PRIOR_BASE_LIMIT = 20;
const LOCAL_SNAPSHOT_LIMIT = 10;

const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const unique = (paths: Iterable<string>) => [...new Set(paths)].sort(byPath);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const hook = (
  options: OverleafCoordinatorOptions,
  point: "linked" | "applied" | "adopted",
): Effect.Effect<void> => options.hooks?.at?.(point) ?? Effect.void;

/** @public Context tag; step 5 mounts it behind authenticated routes. */
export class OverleafCoordinator extends Context.Service<
  OverleafCoordinator,
  {
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly selections?: OverleafSelections;
    }) => Effect.Effect<OverleafPrepareResult, OverleafCoordinatorError>;
    readonly confirm: (input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly reviewId: string;
      readonly digest: string;
      readonly acknowledgements: ReadonlyArray<string>;
    }) => Effect.Effect<OverleafConfirmResult, OverleafCoordinatorError>;
    readonly recover: (input: {
      readonly connectionId: string;
    }) => Effect.Effect<OverleafRecoverResult, OverleafCoordinatorError>;
    /** Kept copies with their current state (contract section 8); reads only. */
    readonly keptCopies: (input: {
      readonly connectionId: string;
    }) => Effect.Effect<ReadonlyArray<OverleafKeptCopy>, OverleafCoordinatorError>;
    /**
     * Puts a kept copy back in the folder, keeping the file it replaces. Both
     * revisions must still be what the request saw. Never publishes and never
     * moves the sync base: the restored file is a local change for the next review.
     */
    readonly restoreKept: (input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly applyId: string;
      /** The copy's place in the retention folder, as `keptCopies` lists it. */
      readonly kept: string;
      readonly keptRevision: string;
      readonly currentRevision: string | null;
    }) => Effect.Effect<OverleafRestoreResult, OverleafCoordinatorError>;
  }
>()("t3/scient/overleaf/OverleafCoordinator") {}

export const make = (options: OverleafCoordinatorOptions) =>
  Effect.gen(function* () {
    const store = yield* OverleafStateStore;
    const repos = yield* OverleafRepository;
    const applier = yield* WorkspaceApplier;
    const barrier = yield* CheckoutBarrier;
    const registry = options.registry ?? makeOverleafReviewRegistry();
    const volumeUuid = options.volumeUuid ?? macVolumeUuid;
    const credentialEpoch = options.credentialEpoch ?? (() => 0);
    /** Connection → the operation holding it. */
    const reservations = new Map<string, string>();

    const now = Clock.currentTimeMillis;

    const reserve = <A, E, R>(
      connectionId: string,
      body: (operationId: string) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (reservations.has(connectionId))
            return Effect.fail(new OverleafOperationActiveError({ connectionId }));
          const operationId = newOverleafId();
          reservations.set(connectionId, operationId);
          return Effect.succeed(operationId);
        }),
        body,
        () => Effect.sync(() => reservations.delete(connectionId)),
      );

    const readActive = Effect.fn("OverleafCoordinator.readActive")(function* (
      connectionId: string,
    ) {
      const read = yield* store.readConnection(connectionId);
      if (read._tag !== "ready")
        return yield* new OverleafConnectionNotReadyError({ connectionId, reason: read._tag });
      if (read.document.state !== "active")
        return yield* new OverleafConnectionNotReadyError({ connectionId, reason: "archived" });
      return read.document;
    });

    const folderOf = (connection: OverleafConnectionDocument) =>
      connection.folder.relativePath === ""
        ? connection.checkout.canonicalRoot
        : NodePath.join(connection.checkout.canonicalRoot, connection.folder.relativePath);

    /** The checkout and folder are still the physical folders the connection recorded. */
    const verifyFolders = Effect.fn("OverleafCoordinator.verifyFolders")(function* (
      connection: OverleafConnectionDocument,
    ) {
      const matches = yield* Effect.promise(async () => {
        for (const [path, recorded] of [
          [connection.checkout.canonicalRoot, connection.checkout.identity],
          [folderOf(connection), connection.folder.identity],
        ] as const) {
          const stat = await NodeFSP.lstat(path, { bigint: true }).catch(() => null);
          if (stat === null || !stat.isDirectory() || String(stat.ino) !== recorded.fileId)
            return false;
          if ((await volumeUuid(path)) !== recorded.volume) return false;
        }
        return true;
      });
      if (!matches)
        return yield* new OverleafConnectionNotReadyError({
          connectionId: connection.connectionId,
          reason: "folder-changed",
        });
    });

    const repositoryFor = Effect.fn("OverleafCoordinator.repositoryFor")(function* (
      connection: OverleafConnectionDocument,
    ) {
      const repo = NodePath.join(
        options.stateRoot,
        "repositories",
        `${connection.connectionId}.git`,
      );
      yield* repos.initialize({
        repo,
        gitUrl: `https://git.overleaf.com/${connection.remote.projectId}`,
      });
      return repo;
    });

    /** Captures the folder and builds the review, reading requested collisions in full. */
    const buildReview = Effect.fn("OverleafCoordinator.buildReview")(function* (input: {
      readonly connection: OverleafConnectionDocument;
      readonly repo: string;
      readonly selections: OverleafSelections;
      readonly remote: { readonly commit: string; readonly tree: string };
      readonly checkoutEpoch: number;
    }) {
      const { connection, repo } = input;
      const baseTree =
        connection.base.tree === null
          ? []
          : yield* repos.readTree({ repo, tree: connection.base.tree });
      const managedPaths = unique([
        ...baseTree.map((entry) => entry.path),
        ...connection.managedPaths,
      ]);
      const scratch = NodePath.join(options.stateRoot, "scratch", newOverleafId());
      let requested = input.selections.collisionPaths;
      // A review may ask once for the local files Overleaf has content at; a second
      // request means the folder changed meanwhile, which the next prepare sees.
      for (let round = 0; ; round++) {
        const captured = yield* Effect.promise(() =>
          captureOverleafInventory({
            folder: folderOf(connection),
            managedPaths,
            localOnlyPaths: connection.localOnlyPaths,
            selectedAdditions: input.selections.selectedAdditions,
            requestedPaths: requested,
            stagingPaths: connection.stagingPaths,
          }),
        );
        if (captured._tag === "refused")
          return { _tag: "refused" as const, refusal: captured.refusal };
        yield* Effect.promise(() => NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 }));
        const result = yield* buildOverleafReview({
          repo,
          connection,
          inventory: captured.inventory,
          remote: input.remote,
          selectedAdditions: input.selections.selectedAdditions,
          collisionPaths: requested,
          choices: input.selections.choices,
          interrupted: connection.forcedConflicts,
          markerPaths: connection.markerPaths,
          epochs: { checkout: input.checkoutEpoch, credential: credentialEpoch() },
          scratch,
        }).pipe(
          Effect.provideService(OverleafRepository, repos),
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true })),
          ),
        );
        if (result._tag !== "needs-capture" || round > 0) {
          if (result._tag === "needs-capture")
            return {
              _tag: "refused" as const,
              refusal: { reason: "unstable" as const, path: result.paths[0] ?? "" },
            };
          return result;
        }
        requested = result.paths;
      }
    });

    /** Writes the refs `next` needs, then replaces the document; refs it no longer needs go after. */
    const replaceWithPins = Effect.fn("OverleafCoordinator.replaceWithPins")(function* (
      repo: string,
      previous: OverleafConnectionDocument,
      next: OverleafConnectionDocument,
    ) {
      const before = new Map(overleafRequiredPins(previous).map((pin) => [pin.name, pin.oid]));
      const after = overleafRequiredPins(next);
      for (const pin of after)
        if (before.get(pin.name) !== pin.oid) yield* repos.setRef({ repo, ...pin });
      yield* store.replaceConnection({ expectedRevision: previous.revision, next });
      const kept = new Set(after.map((pin) => pin.name));
      for (const name of before.keys())
        if (!kept.has(name)) yield* repos.deleteRef({ repo, name }).pipe(Effect.ignore);
    });

    /** The connection after the applier's result: one replacement, so it is adopted once. */
    const adoption = Effect.fn("OverleafCoordinator.adoption")(function* (
      repo: string,
      connection: OverleafConnectionDocument,
      result: WorkspaceApplyResult,
      vault: string,
    ) {
      const link = connection.activeApply!;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      if (result.outcome === "replan")
        return {
          ...connection,
          revision: connection.revision + 1,
          activeApply: null,
          updatedAt,
        } satisfies OverleafConnectionDocument;
      const keptAt = (path: string | null) => {
        const kept =
          path === null ? null : NodePath.relative(vault, path).split(NodePath.sep).join("/");
        return kept !== null && KEPT_PATH.test(kept) ? kept : null;
      };
      if (link.kind === "retained-restore") {
        // A restore keeps the bytes it displaced, never moves the base, and sends nothing.
        const copies = [...connection.retention.copies];
        for (const kept of result.retained) {
          const where = keptAt(kept.retainedPath);
          if (kept.retainedRevision === null || where === null) continue;
          if (copies.some((copy) => copy.applyId === link.applyId && copy.kept === where)) continue;
          copies.push({
            applyId: link.applyId,
            relativePath: kept.relativePath,
            revision: kept.retainedRevision,
            state: kept.changed ? "changed" : "kept",
            retainedAt: updatedAt,
            retainedAtSyncCount: connection.completedSyncCount,
            kept: where,
          });
        }
        // The restored file takes part in the sync again, so the next review sends it.
        const restored = (yield* repos.readTree({ repo, tree: link.intentTree })).map(
          (entry) => entry.path,
        );
        return {
          ...connection,
          revision: connection.revision + 1,
          managedPaths: unique([...connection.managedPaths, ...restored]),
          localOnlyPaths: connection.localOnlyPaths.filter((path) => !restored.includes(path)),
          stagingPaths: unique([...connection.stagingPaths, ...result.stagingPaths]),
          retention: { ...connection.retention, copies },
          activeApply: null,
          updatedAt,
        } satisfies OverleafConnectionDocument;
      }
      const baseTree = yield* repos.writeTree({
        repo,
        entries: [...result.base]
          .sort(([left], [right]) => byPath(left, right))
          .map(([path, oid]) => ({ path, oid })),
      });
      const candidate = yield* repos.readTree({ repo, tree: link.intentTree });
      const completedSyncCount =
        connection.completedSyncCount + (result.outcome === "complete" ? 1 : 0);
      // One record per kept file: a step may keep more than one version of a path.
      const copies = new Map(
        connection.retention.copies.map((copy) => [`${copy.applyId}\0${copy.kept}`, copy]),
      );
      for (const kept of result.retained) {
        const where = keptAt(kept.retainedPath);
        if (kept.retainedRevision === null || where === null) continue;
        const key = `${link.applyId}\0${where}`;
        const state = kept.changed
          ? ("changed" as const)
          : result.interrupted.some((group) => group.includes(kept.relativePath))
            ? ("interrupted" as const)
            : ("releasable" as const);
        if (copies.has(key)) continue;
        copies.set(key, {
          applyId: link.applyId,
          relativePath: kept.relativePath,
          revision: kept.retainedRevision,
          state,
          retainedAt: updatedAt,
          retainedAtSyncCount: completedSyncCount,
          kept: where,
        });
      }
      return {
        ...connection,
        revision: connection.revision + 1,
        base: {
          commit: link.remoteCommit,
          tree: baseTree,
          generation: connection.base.generation + 1,
        },
        priorBases:
          connection.base.tree === null
            ? connection.priorBases
            : [
                {
                  commit: connection.base.commit,
                  tree: connection.base.tree,
                  generation: connection.base.generation,
                },
                ...connection.priorBases,
              ].slice(0, PRIOR_BASE_LIMIT),
        completedSyncCount,
        managedPaths: unique([
          ...candidate.map((entry) => entry.path),
          ...result.interrupted.flat(),
        ]),
        localOnlyPaths: unique(link.localOnly),
        forcedConflicts: result.interrupted.map((group) => unique(group)),
        markerPaths: unique([...result.markerPaths, ...link.priorMarkers]),
        stagingPaths: unique([...connection.stagingPaths, ...result.stagingPaths]),
        retention: { ...connection.retention, copies: [...copies.values()] },
        // The base moved, so a publication still unknown is overtaken (contract section 6).
        attempts: connection.attempts.map((attempt) =>
          attempt.outcome === "unknown"
            ? {
                ...attempt,
                outcome: "superseded-unresolved" as const,
                evidence: "superseded" as const,
              }
            : attempt,
        ),
        activeApply: null,
        updatedAt,
      } satisfies OverleafConnectionDocument;
    });

    /**
     * Runs or resumes the linked apply inside an application section and adopts
     * its result. Without `plan` the applier resumes from its own durable intent.
     */
    const runLinked = Effect.fn("OverleafCoordinator.runLinked")(function* (
      repo: string,
      connection: OverleafConnectionDocument,
      plan?: OverleafReview["applyPlan"],
    ) {
      const link = connection.activeApply!;
      const retention = yield* store.prepareRetention({
        environmentId: connection.environmentId,
        connectionId: connection.connectionId,
        checkoutRoot: connection.checkout.canonicalRoot,
        exchangeHelper: options.exchangeHelper,
        expected: connection.retention.vaultIdentity,
      });
      const result = yield* applier.apply({
        cwd: folderOf(connection),
        applicationDirectory: retention.directory,
        id: link.applyId,
        ...(plan ? { plan } : {}),
      });
      yield* hook(options, "applied");
      yield* replaceWithPins(
        repo,
        connection,
        yield* adoption(repo, connection, result, retention.directory),
      );
      yield* hook(options, "adopted");
      return {
        applyId: link.applyId,
        outcome: result.outcome,
        interrupted: result.interrupted,
        markerPaths: result.markerPaths,
        baseGeneration:
          connection.base.generation +
          (result.outcome === "replan" || link.kind === "retained-restore" ? 0 : 1),
      } satisfies OverleafAdopted;
    });

    /** Recovers a linked apply, under a section of its own or one a bulk change holds. */
    const recoverHeld = Effect.fn("OverleafCoordinator.recoverHeld")(function* (
      connectionId: string,
      within?: CheckoutSection,
    ) {
      const pending = yield* readActive(connectionId);
      if (pending.activeApply === null) return { _tag: "none" as const };
      const repo = yield* repositoryFor(pending);
      return yield* barrier.application(
        folderOf(pending),
        () =>
          Effect.gen(function* () {
            const connection = yield* readActive(connectionId);
            if (connection.activeApply === null) return { _tag: "none" as const };
            yield* verifyFolders(connection);
            return {
              _tag: "recovered" as const,
              adopted: yield* runLinked(repo, connection),
            };
          }),
        within ? { within } : undefined,
      );
    });

    const prepare: OverleafCoordinator["Service"]["prepare"] = (input) =>
      reserve(input.connectionId, () =>
        Effect.gen(function* () {
          let connection = yield* readActive(input.connectionId);
          if (connection.activeApply !== null) {
            const recovered = yield* recoverHeld(input.connectionId);
            if (recovered._tag === "recovered" && recovered.adopted.outcome !== "complete")
              return { _tag: "recovered" as const, recovery: recovered.adopted };
            connection = yield* readActive(input.connectionId);
          }
          const repo = yield* repositoryFor(connection);
          const remote = yield* options.fetchRemote({ repo, connection });
          const section = yield* barrier.current(folderOf(connection));
          const built = yield* buildReview({
            connection,
            repo,
            selections: input.selections ?? {
              selectedAdditions: [],
              collisionPaths: [],
              choices: new Map(),
            },
            remote,
            checkoutEpoch: section.epoch,
          });
          if (built._tag === "review") registry.offer(built.review, yield* now);
          return built;
        }),
      );

    const confirm: OverleafCoordinator["Service"]["confirm"] = (input) =>
      reserve(input.connectionId, (operationId) =>
        Effect.gen(function* () {
          const started = DateTime.formatIso(yield* DateTime.now);
          const begun = yield* store.beginReceipt({
            schemaVersion: 1,
            connectionId: input.connectionId,
            requestId: input.requestId,
            kind: "confirm",
            payloadDigest: sha256(
              [input.reviewId, input.digest, ...[...input.acknowledgements].sort(byPath)].join(
                "\0",
              ),
            ),
            operationId,
            status: "running",
            resultCategory: null,
            createdAt: started,
            updatedAt: started,
          });
          if (begun._tag === "existing")
            return { _tag: "duplicate" as const, receipt: begun.receipt };
          let linked = false;
          const finish = (status: "completed" | "failed" | "unknown", resultCategory: string) =>
            store
              .finishReceipt({
                connectionId: input.connectionId,
                requestId: input.requestId,
                status,
                resultCategory,
              })
              .pipe(Effect.ignore);
          const result = yield* Effect.gen(function* () {
            const taken = registry.take({
              connectionId: input.connectionId,
              id: input.reviewId,
              digest: input.digest,
              acknowledgements: input.acknowledgements,
              now: yield* now,
            });
            if (taken._tag === "refused")
              return { _tag: "review-refused" as const, reason: taken.reason };
            const review = taken.review;
            const first = yield* readActive(input.connectionId);
            if (first.activeApply !== null)
              return yield* new OverleafConnectionNotReadyError({
                connectionId: input.connectionId,
                reason: "recovery-required",
              });
            const repo = yield* repositoryFor(first);
            const remote = yield* options.fetchRemote({ repo, connection: first });
            return yield* barrier.application(folderOf(first), (section) =>
              Effect.gen(function* () {
                const connection = yield* readActive(input.connectionId);
                if (connection.activeApply !== null)
                  return yield* new OverleafConnectionNotReadyError({
                    connectionId: input.connectionId,
                    reason: "recovery-required",
                  });
                yield* verifyFolders(connection);
                // The same review, built again from what stands now (contract section 5).
                const fresh = yield* buildReview({
                  connection,
                  repo,
                  selections: {
                    selectedAdditions: review.binding.selectedAdditions,
                    collisionPaths: review.binding.collisionPaths,
                    choices: new Map(review.binding.choices),
                  },
                  remote,
                  checkoutEpoch: section.epoch,
                });
                if (fresh._tag === "refused") return fresh;
                const stale = overleafReviewStaleness(review.binding, fresh.review.binding);
                if (stale !== null) {
                  registry.offer(fresh.review, yield* now);
                  return { _tag: "stale" as const, reason: stale, review: fresh.review };
                }
                // Every path the plan changes may keep up to three versions (the displaced
                // file, a staged copy, a provisional capture): room is checked before writing.
                const plan = review.applyPlan;
                const changed = new Set(
                  [...plan.captured.keys(), ...plan.target.keys()].filter((path) => {
                    const target = plan.target.get(path);
                    return (
                      (target === undefined ? undefined : bytesRevision(target.bytes)) !==
                      plan.captured.get(path)
                    );
                  }),
                ).size;
                if (
                  connection.retention.copies.length + KEPT_PER_PATH * changed >
                  RETAINED_COPY_LIMIT
                )
                  return yield* new OverleafRetainedLimitError({
                    connectionId: input.connectionId,
                  });
                const sequence =
                  Math.max(0, ...connection.localSnapshots.map((snapshot) => snapshot.sequence)) +
                  1;
                const withLink: OverleafConnectionDocument = {
                  ...connection,
                  revision: connection.revision + 1,
                  localSnapshots: [
                    ...connection.localSnapshots,
                    { sequence, commit: null, tree: review.binding.localTree },
                  ].slice(-LOCAL_SNAPSHOT_LIMIT),
                  activeApply: {
                    applyId: newOverleafId(),
                    kind: "sync-apply",
                    operationId,
                    planDigest: review.digest,
                    baseGeneration: connection.base.generation,
                    intentTree: review.binding.candidateTree,
                    remoteCommit: review.binding.remoteCommit,
                    // What the review counted: kept entries less promoted collisions, plus new ones.
                    localOnly: unique([
                      ...connection.localOnlyPaths.filter(
                        (path) => !review.binding.collisionPaths.includes(path),
                      ),
                      ...review.binding.newLocalOnly,
                    ]),
                    priorMarkers: review.binding.unresolvedMarkers,
                  },
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* replaceWithPins(repo, connection, withLink);
                linked = true;
                yield* hook(options, "linked");
                return {
                  _tag: "applied" as const,
                  adopted: yield* runLinked(repo, withLink, review.applyPlan),
                };
              }),
            );
          }).pipe(
            Effect.tapError(() => finish(linked ? "unknown" : "failed", "error")),
            Effect.tap((done) =>
              finish(
                done._tag === "applied" ? "completed" : "failed",
                done._tag === "applied" ? `applied-${done.adopted.outcome}` : done._tag,
              ),
            ),
          );
          return result;
        }),
      );

    const recover: OverleafCoordinator["Service"]["recover"] = (input) =>
      reserve(input.connectionId, () => recoverHeld(input.connectionId));

    const vaultOf = (connection: OverleafConnectionDocument) =>
      store
        .prepareRetention({
          environmentId: connection.environmentId,
          connectionId: connection.connectionId,
          checkoutRoot: connection.checkout.canonicalRoot,
          exchangeHelper: options.exchangeHelper,
          expected: connection.retention.vaultIdentity,
        })
        .pipe(Effect.map((retention) => retention.directory));
    const revisionAt = (path: string) => Effect.promise(() => fileRevision(path));

    const keptCopies: OverleafCoordinator["Service"]["keptCopies"] = (input) =>
      Effect.gen(function* () {
        const connection = yield* readActive(input.connectionId);
        const vault = yield* vaultOf(connection);
        return yield* Effect.forEach(connection.retention.copies, (copy) =>
          Effect.gen(function* () {
            return {
              applyId: copy.applyId,
              kept: copy.kept,
              relativePath: copy.relativePath,
              state: copy.state,
              retainedAt: copy.retainedAt,
              revision: copy.revision,
              keptRevision: yield* revisionAt(NodePath.join(vault, copy.kept)),
              currentRevision: yield* revisionAt(
                NodePath.join(folderOf(connection), copy.relativePath),
              ),
            } satisfies OverleafKeptCopy;
          }),
        );
      });

    const restoreKept: OverleafCoordinator["Service"]["restoreKept"] = (input) =>
      reserve(input.connectionId, (operationId) =>
        Effect.gen(function* () {
          const started = DateTime.formatIso(yield* DateTime.now);
          const begun = yield* store.beginReceipt({
            schemaVersion: 1,
            connectionId: input.connectionId,
            requestId: input.requestId,
            kind: "restore",
            payloadDigest: sha256(
              [
                input.applyId,
                input.kept,
                input.keptRevision,
                input.currentRevision ?? "absent",
              ].join("\0"),
            ),
            operationId,
            status: "running",
            resultCategory: null,
            createdAt: started,
            updatedAt: started,
          });
          if (begun._tag === "existing")
            return { _tag: "duplicate" as const, receipt: begun.receipt };
          let linked = false;
          const finish = (status: "completed" | "failed" | "unknown", resultCategory: string) =>
            store
              .finishReceipt({
                connectionId: input.connectionId,
                requestId: input.requestId,
                status,
                resultCategory,
              })
              .pipe(Effect.ignore);
          return yield* Effect.gen(function* () {
            const first = yield* readActive(input.connectionId);
            if (first.activeApply !== null)
              return yield* new OverleafConnectionNotReadyError({
                connectionId: input.connectionId,
                reason: "recovery-required",
              });
            const repo = yield* repositoryFor(first);
            return yield* barrier.application(folderOf(first), () =>
              Effect.gen(function* () {
                const connection = yield* readActive(input.connectionId);
                if (connection.activeApply !== null)
                  return yield* new OverleafConnectionNotReadyError({
                    connectionId: input.connectionId,
                    reason: "recovery-required",
                  });
                yield* verifyFolders(connection);
                const copy = connection.retention.copies.find(
                  (entry) => entry.applyId === input.applyId && entry.kept === input.kept,
                );
                if (copy === undefined || connection.base.commit === null)
                  return { _tag: "unknown-copy" as const };
                if (connection.retention.copies.length + KEPT_PER_PATH > RETAINED_COPY_LIMIT)
                  return yield* new OverleafRetainedLimitError({
                    connectionId: input.connectionId,
                  });
                const vault = yield* vaultOf(connection);
                const keptPath = NodePath.join(vault, copy.kept);
                const target = NodePath.join(folderOf(connection), copy.relativePath);
                if (
                  (yield* revisionAt(keptPath)) !== input.keptRevision ||
                  (yield* revisionAt(target)) !== input.currentRevision
                )
                  return { _tag: "stale" as const };
                const bytes = yield* Effect.promise(async () => {
                  const read = await NodeFSP.readFile(keptPath);
                  return read.byteLength <= RESTORE_MAX_BYTES ? new Uint8Array(read) : null;
                });
                if (bytes === null || bytesRevision(bytes) !== input.keptRevision)
                  return { _tag: "stale" as const };
                const oid = yield* repos.writeBlob({ repo, bytes });
                const intentTree = yield* repos.writeTree({
                  repo,
                  entries: [{ path: copy.relativePath, oid }],
                });
                const withLink: OverleafConnectionDocument = {
                  ...connection,
                  revision: connection.revision + 1,
                  activeApply: {
                    applyId: newOverleafId(),
                    kind: "retained-restore",
                    operationId,
                    planDigest: sha256(
                      [copy.applyId, copy.relativePath, input.keptRevision].join("\0"),
                    ),
                    baseGeneration: connection.base.generation,
                    intentTree,
                    remoteCommit: connection.base.commit,
                    localOnly: connection.localOnlyPaths,
                    priorMarkers: [],
                  },
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                };
                yield* replaceWithPins(repo, connection, withLink);
                linked = true;
                yield* hook(options, "linked");
                // Outstanding reviews were built against the file this replaces.
                registry.invalidate(input.connectionId);
                const captured = new Map(
                  input.currentRevision === null
                    ? []
                    : [[copy.relativePath, input.currentRevision]],
                );
                return {
                  _tag: "restored" as const,
                  adopted: yield* runLinked(repo, withLink, {
                    base: captured,
                    remote: new Map([[copy.relativePath, input.keptRevision]]),
                    captured,
                    target: new Map([[copy.relativePath, { bytes }]]),
                    renames: [],
                    conflicts: [],
                    markerPaths: [],
                  }),
                };
              }),
            );
          }).pipe(
            Effect.tapError(() => finish(linked ? "unknown" : "failed", "error")),
            Effect.tap((done) =>
              finish(
                done._tag === "restored" ? "completed" : "failed",
                done._tag === "restored" ? `restored-${done.adopted.outcome}` : done._tag,
              ),
            ),
          );
        }),
      );

    // A bulk change of a checkout first settles an apply left pending in it, when
    // nothing else holds that connection (owner decision 3); otherwise it refuses.
    // It fails closed: a connection it cannot read could be one with work pending
    // here, so an unreadable record refuses every bulk change until it is
    // quarantined or repaired.
    yield* barrier.settleBeforeBulk((section) =>
      Effect.gen(function* () {
        const refuse = new CheckoutRecoveryRequiredError({ checkout: section.root });
        const connectionIds = yield* store.listConnections.pipe(Effect.mapError(() => refuse));
        for (const connectionId of connectionIds) {
          const read = yield* store
            .readConnection(connectionId)
            .pipe(Effect.mapError(() => refuse));
          // Removed between listing and reading: nothing pending there.
          if (read._tag === "missing") continue;
          if (read._tag !== "ready") return yield* refuse;
          if (read.document.state !== "active") continue;
          const connection = read.document;
          // The connection's checkout, or one enclosing it, is the one changing.
          const held = yield* barrier
            .current(folderOf(connection))
            .pipe(Effect.mapError(() => refuse));
          if (!held.keys.includes(section.key)) continue;
          // Structural source copies sit in the folder; a bulk change could erase them.
          if (connection.stagingPaths.length > 0) return yield* refuse;
          if (connection.activeApply === null) continue;
          yield* reserve(connectionId, () => recoverHeld(connectionId, section)).pipe(
            Effect.mapError(() => refuse),
          );
        }
      }),
    );

    return OverleafCoordinator.of({ prepare, confirm, recover, keptCopies, restoreKept });
  });
