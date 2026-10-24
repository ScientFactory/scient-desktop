// @effect-diagnostics nodeBuiltinImport:off -- Folder identities and private scratch folders.
/**
 * A manual Overleaf sync (coordinator contract sections 3 to 6, 8 and 9; steps
 * 3b and 4). It prepares reviews, applies a confirmed one to the folder, adopts
 * the applier's result into the connection, then sends it to Overleaf once:
 * verified, recorded first, never resent. Recovery finishes an interrupted
 * apply and settles earlier sends by positive evidence only; it never sends.
 *
 * Lock order: the connection's operation reservation (in memory, refused rather
 * than queued), then the checkout barrier's application section, then the
 * store's compare-and-set, then the file layer's own locks. Fetching Overleaf
 * happens before the section is taken.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckoutBarrier from "../workspace/CheckoutBarrier.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import {
  ATTEMPT_LIMIT,
  FORCED_CONFLICT_LIMIT,
  isOverleafAttemptUnresolved,
  KEPT_VERSION_LIMIT,
  KeptPath,
  LOCAL_SNAPSHOT_LIMIT,
  MANAGED_PATH_LIMIT,
  overleafRequiredPins,
  PRIOR_BASE_LIMIT,
  RETAINED_COPY_LIMIT,
  UNRESOLVED_ATTEMPT_LIMIT,
  type OverleafConnectionDocument,
  type OverleafMarkerRecord,
  type OverleafOperationReceipt,
  type OverleafPublicationAttempt,
} from "./OverleafConnectionState.ts";
import { newOverleafId, type OverleafGitError } from "./OverleafGitExecutor.ts";
import { manuscriptTreeProblem } from "./manuscriptPaths.ts";
import {
  captureOverleafInventory,
  OVERLEAF_LIMITS,
  type OverleafInventoryRefusal,
} from "./OverleafInventory.ts";
import { probeAcceptance } from "./OverleafProtocolProbe.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { macVolumeUuid, type OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import {
  buildOverleafReview,
  type OverleafReview,
  type OverleafReviewBinding,
  type OverleafReviewRefusal,
  writeCapturedTree,
} from "./OverleafReview.ts";
import {
  makeOverleafReviewRegistry,
  overleafReviewStaleness,
  type OverleafReviewRegistry,
  type OverleafReviewStaleReason,
  type OverleafReviewTakeRefusal,
} from "./OverleafReviewRegistry.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import type { ConflictChoice, Rename } from "./syncRules.ts";
import { manuscriptCollisionKey } from "./unicodeCaseFold.ts";
import * as WorkspaceApplier from "./WorkspaceApplier.ts";

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
      "authority-changed",
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
      case "authority-changed":
        return "This project's workspace changed during the Overleaf operation. Try again.";
    }
  }
}

/** The operation would exceed what one connection can record; nothing was written. */
export class OverleafRetainedLimitError extends Schema.TaggedError<OverleafRetainedLimitError>()(
  "OverleafRetainedLimitError",
  {
    connectionId: Schema.String,
    limit: Schema.Literals([
      "kept-copies",
      "managed-paths",
      "conflict-group",
      "marker-paths",
      "attempts",
    ]),
  },
) {
  override get message(): string {
    switch (this.limit) {
      case "kept-copies":
        return "This would keep more replaced files than Scient can track. Release kept copies first.";
      case "managed-paths":
        return "This would bring back a file beyond the number Scient can sync for one project.";
      case "conflict-group":
        return "This sync changes more files together than Scient can track at once.";
      case "marker-paths":
        return "This would track more files with conflict material than Scient can. Resolve some first.";
      case "attempts":
        return "Earlier sends to Overleaf are still unresolved, and Scient can't record another until some are.";
    }
  }
}

/** The connection's selections: what a review was built from, and is rebuilt from. */
export interface OverleafSelections {
  /**
   * Exactly the additions to send; a default one left out is kept only on this
   * computer. Absent: the review's default selection, every addition no rule
   * skips (pr-c-design section 5).
   */
  readonly selectedAdditions?: ReadonlyArray<string>;
  /** Files kept only on this computer to send now; they become managed once applied. */
  readonly sendLocalOnly?: ReadonlyArray<string>;
  /**
   * Files to send whatever the default rule says, judged on the review's own
   * capture: a skipped new file is selected (one too large is refused), a file
   * kept only here is sent, and one already synced needs nothing more, so a
   * retry after it was applied succeeds. Every other file follows the defaults.
   */
  readonly send?: ReadonlyArray<string>;
  /**
   * New files to keep only on this computer, whatever the rule says of them,
   * judged on the review's own capture and remembered once applied. Wins over
   * every request to send. A path that is not a new file is ignored, and one
   * already kept here stays kept. Every other file follows the defaults.
   */
  readonly keepOnlyHere?: ReadonlyArray<string>;
  /** Local paths read in full because Overleaf has content at their place. */
  readonly collisionPaths: ReadonlyArray<string>;
  readonly choices: ReadonlyMap<string, ConflictChoice>;
  /**
   * Files with conflict marks to send as they are, marks included, instead of
   * holding them back: a deliberate choice for a file whose marks are its content
   * (a guide quoting them, say). Marks the review writes are never released; the
   * review lists those sent as they are (`released`).
   */
  readonly releaseMarked?: ReadonlyArray<string>;
}

export type OverleafPrepareResult =
  | {
      readonly _tag: "review";
      readonly review: OverleafReview;
      /** An interrupted apply this prepare finished first, completely, writing the folder. */
      readonly settled?: OverleafAdopted;
    }
  | {
      readonly _tag: "refused";
      readonly refusal: OverleafReviewRefusal | OverleafInventoryRefusal;
      /** An interrupted apply this prepare finished first, before the review was refused. */
      readonly settled?: OverleafAdopted;
    }
  /** A pending apply was recovered but needs review before anything else. */
  | { readonly _tag: "recovered"; readonly recovery: OverleafAdopted };

/** What one apply did to the folder and the connection. */
export interface OverleafAdopted {
  readonly applyId: string;
  readonly outcome: WorkspaceApplier.WorkspaceApplyResult["outcome"];
  readonly interrupted: ReadonlyArray<ReadonlyArray<string>>;
  readonly markerPaths: ReadonlyArray<string>;
  readonly baseGeneration: number;
}

/** What became of an applied review's changes for Overleaf (contract section 6). */
export type OverleafPublication =
  /** Nothing to send: the result equals Overleaf's tree. */
  | { readonly _tag: "none" }
  /** Not sent: the apply left something to review first. */
  | {
      readonly _tag: "blocked";
      readonly reason: "attention" | "markers" | "staging" | "kept-copy-changed";
    }
  /** Not sent: the folder changed after the apply. The change is for the next review. */
  | { readonly _tag: "not-verified" }
  /** Recorded, then refused before sending: the credential changed since the review. */
  | { readonly _tag: "not-sent"; readonly attemptNumber: number }
  | { readonly _tag: "accepted"; readonly attemptNumber: number }
  /** Overleaf had moved on, so nothing was applied there. A new review is needed. */
  | { readonly _tag: "out-of-date"; readonly attemptNumber: number }
  /** Perhaps sent. Overleaf's history settles it later; it is never sent again. */
  | { readonly _tag: "unknown"; readonly attemptNumber: number };

/** What a check of earlier sends against Overleaf found. */
export interface OverleafAttemptsChecked {
  readonly accepted: ReadonlyArray<number>;
  /** Still unestablished; the next review warns about each. */
  readonly unresolved: ReadonlyArray<number>;
}

export type OverleafConfirmResult =
  | {
      readonly _tag: "applied";
      readonly adopted: OverleafAdopted;
      readonly publication: OverleafPublication;
    }
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
  /** The bytes when kept, for the record's main version; null for another version beside it. */
  readonly revision: string | null;
  /** The copy's bytes now; different from `revision` means a late writer. Null when gone or unread. */
  readonly keptRevision: string | null;
  /** The folder's file now; null when absent or unread. */
  readonly currentRevision: string | null;
  /**
   * A file was left unread: larger than a restore reads back, past one listing's
   * read budget, or changing while read. Its null revision does not mean gone, and
   * this version cannot be restored from this listing.
   */
  readonly unread: boolean;
}

export type OverleafRestoreResult =
  | { readonly _tag: "restored"; readonly adopted: OverleafAdopted }
  /** The copy or the folder's file is no longer what the request saw; nothing was written. */
  | { readonly _tag: "stale" }
  | { readonly _tag: "unknown-copy" }
  | { readonly _tag: "duplicate"; readonly receipt: OverleafOperationReceipt };

/** Why a path that send changed was left as it is. */
export type OverleafUndoSkip =
  /** The folder's file is no longer exactly what the send left there. */
  | "changed"
  /** The folder already holds what Overleaf had before the send. */
  | "already-undone"
  /** Putting it back would collide with another file or folder now in the folder. */
  | "name-clash"
  /** Overleaf's earlier version is larger than Scient puts back. */
  | "too-large";

export type OverleafUndoResult =
  | {
      readonly _tag: "undone";
      /** Files the send changed, back to Overleaf's earlier version. */
      readonly restored: ReadonlyArray<string>;
      /** Files the send added (a rename's new name too), removed. */
      readonly removed: ReadonlyArray<string>;
      /** Files the send deleted (a rename's old name too), written again. */
      readonly recreated: ReadonlyArray<string>;
      readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: OverleafUndoSkip }>;
      /**
       * The apply; null when every path was skipped and nothing was written. The lists
       * above are what it set out to do: `complete` means all of it is in the folder,
       * `replan` that the folder changed first and nothing was written.
       */
      readonly adopted: OverleafAdopted | null;
    }
  /** Only a send Overleaf accepted, still recorded, has something known to undo. */
  | {
      readonly _tag: "not-eligible";
      readonly reason:
        | "not-recorded"
        | "unresolved"
        | "not-sent"
        | "out-of-date"
        /** Scient no longer holds what Overleaf had before that send, or what it sent. */
        | "history-unavailable";
    }
  /** The folder could not be captured as a sync captures it; nothing was written. */
  | { readonly _tag: "refused"; readonly refusal: OverleafInventoryRefusal }
  | { readonly _tag: "duplicate"; readonly receipt: OverleafOperationReceipt };

/** `attempts` is null when Overleaf could not be reached to check earlier sends. */
export type OverleafRecoverResult =
  | { readonly _tag: "none"; readonly attempts: OverleafAttemptsChecked | null }
  | {
      readonly _tag: "recovered";
      readonly adopted: OverleafAdopted;
      readonly attempts: OverleafAttemptsChecked | null;
    };

type FetchError = OverleafRepository.OverleafRepositoryError | OverleafGitError;
/** Everything a coordinator operation can fail with; business outcomes are results instead. */
export type OverleafCoordinatorError =
  | OverleafOperationActiveError
  | OverleafConnectionNotReadyError
  | OverleafRetainedLimitError
  | CheckoutBarrier.CheckoutSuspendedError
  | CheckoutBarrier.CheckoutLookupError
  | FetchError
  | WorkspaceApplier.WorkspaceApplyError
  | OverleafStateStore.OverleafStateIoError
  | OverleafStateStore.OverleafStateLockedError
  | OverleafStateStore.OverleafConnectionStaleError
  | OverleafStateStore.OverleafConnectionUnavailableError
  | OverleafStateStore.OverleafTransitionRejectedError
  | OverleafStateStore.OverleafRecordInvalidError
  | OverleafStateStore.OverleafRequestReusedError
  | OverleafStateStore.OverleafRetentionUnavailableError;

export interface OverleafCoordinatorOptions {
  /** `stateDir/overleaf`: repositories and scratch folders live here. */
  readonly stateRoot: string;
  /** The host's exchange helper; null only for the declared development fallback. */
  readonly exchangeHelper: string | null;
  /** Fetches Overleaf's branch into `repo`. Step 5 supplies the authenticated fetch. */
  readonly fetchRemote: (input: {
    readonly repo: string;
    readonly connection: OverleafConnectionDocument;
  }) => Effect.Effect<{ readonly commit: string; readonly tree: string }, FetchError>;
  /**
   * Sends one commit to Overleaf's branch, never forced. Step 5 supplies the
   * authenticated push, which must not send under another credential than the
   * review was built with (`credentialEpoch`).
   */
  readonly pushRemote: (input: {
    readonly repo: string;
    readonly connection: OverleafConnectionDocument;
    readonly commit: string;
    readonly credentialEpoch: number;
  }) => Effect.Effect<OverleafRepository.PushOutcome, FetchError>;
  /** Test seam: the Git address of the connection's project. Defaults to Overleaf's. */
  readonly gitUrl?: (connection: OverleafConnectionDocument) => string;
  /** The host credential epoch; renewing the token advances it. */
  readonly credentialEpoch?: () => number;
  /** Test seam: the disk's volume UUID for a path. Defaults to `diskutil`. */
  readonly volumeUuid?: OverleafVolumeIdentityResolver;
  readonly registry?: OverleafReviewRegistry;
  /**
   * Which operation holds each connection. Connection management (connect,
   * disconnect, relink) shares it, so no two operations ever hold one connection.
   */
  readonly reservations?: OverleafReservations;
  /**
   * Test seam: the largest file read (`RESTORE_MAX_BYTES`), one listing's read budget
   * (`LISTING_MAX_BYTES`), the paths one forced conflict holds (`MANAGED_PATH_LIMIT`)
   * and the earlier bases kept (`PRIOR_BASE_LIMIT`).
   */
  readonly limits?: {
    readonly fileBytes?: number;
    readonly listingBytes?: number;
    readonly conflictPaths?: number;
    readonly priorBases?: number;
  };
  /** Fault points for tests: a throw stops the operation there, as a crash would. */
  readonly hooks?: {
    readonly at?: (point: HookPoint) => Effect.Effect<void>;
  };
}

/**
 * The requesting workspace's authority, checked with the folders before every
 * change to them and inside send admission (contract rule 2). The service
 * provides it for each request; without one (tests, a checkout settler's
 * recovery, which never sends) the folders alone are checked.
 */
export class OverleafAuthorityGuard extends Context.Reference<
  (connection: OverleafConnectionDocument) => Effect.Effect<boolean>
>("t3/scient/overleaf/OverleafAuthorityGuard", {
  defaultValue: () => () => Effect.succeed(true),
}) {}

/** Connection ID → the operation holding it. Admission never queues. */
export type OverleafReservations = Map<string, string>;
export const makeOverleafReservations = (): OverleafReservations => new Map();

/**
 * The operation this fiber already holds, if any: a service operation that holds a
 * connection for its whole run (a sync) lets its own coordinator calls go through.
 */
export class OverleafReservationOwner extends Context.Reference<string | null>(
  "t3/scient/overleaf/OverleafReservationOwner",
  { defaultValue: () => null },
) {}

/**
 * Runs `body` holding `connectionId`, or fails at once when another operation holds it.
 * Status reads and refused requests never take or release it. A fiber that already
 * holds the connection (`OverleafReservationOwner`) runs `body` under that hold.
 */
// Untraced: it wraps every coordinator operation, whose own span already covers it,
// and an extra span would change the failures operations report.
export const reserveOverleafConnection = Effect.fnUntraced(function* <A, E, R>(
  reservations: OverleafReservations,
  connectionId: string,
  body: (operationId: string) => Effect.Effect<A, E, R>,
) {
  const owner = yield* OverleafReservationOwner;
  return yield* owner !== null && reservations.get(connectionId) === owner
    ? body(owner)
    : holdOverleafConnection(reservations, connectionId, body);
});

const holdOverleafConnection = <A, E, R>(
  reservations: OverleafReservations,
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

/** A kept copy's place in the retention folder, as `OverleafConnectionState` records it. */
const KEPT_PATH =
  /^[a-z0-9][a-z0-9-]{0,63}\/files\/step-\d{1,5}(?:-\d{1,5})?\/(?:retained|slot|provisional)$/u;
/** The largest file a restore or listing reads: a kept copy or the folder's file. */
const RESTORE_MAX_BYTES = 50 * 1024 * 1024;
/** What one listing of kept copies reads at most: as much as one inventory may hold. */
const LISTING_MAX_BYTES = OVERLEAF_LIMITS.totalBytes;

const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const unique = (paths: Iterable<string>) => [...new Set(paths)].sort(byPath);
/** Conflict-material records, one per folder path, each keeping every path recorded for it. */
const mergeMarkers = (
  ...lists: ReadonlyArray<ReadonlyArray<OverleafMarkerRecord>>
): ReadonlyArray<OverleafMarkerRecord> => {
  const merged = new Map<string, { folder: string[]; overleaf: string[] }>();
  for (const list of lists)
    for (const record of list) {
      const entry = merged.get(record.path) ?? { folder: [], overleaf: [] };
      merged.set(record.path, {
        folder: [...entry.folder, ...record.folderPaths],
        overleaf: [...entry.overleaf, ...record.overleafPaths],
      });
    }
  return unique(merged.keys()).map((path) => ({
    path,
    folderPaths: unique(merged.get(path)!.folder).filter((other) => other !== path),
    overleafPaths: unique(merged.get(path)!.overleaf),
  }));
};
/** A file given new marks: one path, which no rename touches (`OverleafReview`). */
const freshMarker = (path: string): OverleafMarkerRecord => ({
  path,
  folderPaths: [],
  overleafPaths: [path],
});
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
type FileRead =
  | {
      readonly _tag: "read";
      readonly revision: string;
      /** Size and change time, the same before and after the read. */
      readonly stamp: string;
      readonly size: number;
      readonly bytes: Uint8Array | null;
    }
  | { readonly _tag: "absent" }
  /** Larger than the limit, or changing while read; `size` is what was read. */
  | { readonly _tag: "unread"; readonly size: number };

/**
 * Reads a regular file without following a link and never past `limit` bytes:
 * its revision, with the stamp it kept throughout the read. `keep` returns the bytes.
 */
const readWithin = async (path: string, limit: number, keep = false): Promise<FileRead> => {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { _tag: "absent" };
    if (before.size > BigInt(limit)) return { _tag: "unread", size: 0 };
    const hash = NodeCrypto.createHash("sha256");
    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(256 * 1024);
    let size = 0;
    for (;;) {
      // One byte past the limit reveals a file that grew while being read.
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limit + 1 - size),
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > limit) return { _tag: "unread", size };
      hash.update(buffer.subarray(0, bytesRead));
      if (keep) chunks.push(buffer.slice(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    // The descriptor's file, unchanged throughout, must still be the one the path names.
    const named = await NodeFSP.lstat(path, { bigint: true });
    if (
      BigInt(size) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.dev !== after.dev ||
      named.ino !== after.ino
    )
      return { _tag: "unread", size };
    return {
      _tag: "read",
      revision: `sha256:${hash.digest("hex")}`,
      stamp: `${before.size}:${before.ctimeNs}`,
      size,
      bytes: keep ? new Uint8Array(Buffer.concat(chunks, size)) : null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return { _tag: "absent" };
    throw error;
  } finally {
    await handle?.close();
  }
};

/**
 * The coordinator's durable steps: `recorded` is an attempt written, `admitting` its
 * send about to be admitted (the application section released), `sent` its push returned.
 */
type HookPoint = "linked" | "applied" | "adopted" | "recorded" | "admitting" | "sent";

/** Publication inside the application section: an outcome, or an attempt recorded to send. */
type Staged =
  | { readonly _tag: "outcome"; readonly publication: OverleafPublication }
  | {
      readonly _tag: "recorded";
      readonly attemptNumber: number;
      readonly candidateCommit: string;
      readonly recorded: OverleafConnectionDocument;
    };
const hook = (options: OverleafCoordinatorOptions, point: HookPoint): Effect.Effect<void> =>
  options.hooks?.at?.(point) ?? Effect.void;

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
    /**
     * Puts back in the folder what Overleaf had before one accepted send (design
     * section 4.3): for every path the send changed (its parent tree against the
     * tree it sent), the parent's bytes, or absence. A path whose file is no longer
     * what the send left there is skipped and reported. Displaced bytes are kept.
     * Like a restore it never publishes and never moves the base: the caller syncs
     * next, and the restored files go out as ordinary local changes.
     *
     * The caller saves the folder's open editors, in every window, before calling,
     * and does not call if a save fails; this operation reads only the disk.
     */
    readonly undo: (input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly attemptNumber: number;
    }) => Effect.Effect<OverleafUndoResult, OverleafCoordinatorError>;
  }
>()("t3/scient/overleaf/OverleafCoordinator") {}

export const make = Effect.fn("OverleafCoordinator.make")(function* (
  options: OverleafCoordinatorOptions,
) {
  const store = yield* OverleafStateStore.OverleafStateStore;
  const repos = yield* OverleafRepository.OverleafRepository;
  const applier = yield* WorkspaceApplier.WorkspaceApplier;
  const barrier = yield* CheckoutBarrier.CheckoutBarrier;
  const registry = options.registry ?? makeOverleafReviewRegistry();
  const volumeUuid = options.volumeUuid ?? macVolumeUuid;
  const credentialEpoch = options.credentialEpoch ?? (() => 0);
  const fileBytes = options.limits?.fileBytes ?? RESTORE_MAX_BYTES;
  const listingBytes = options.limits?.listingBytes ?? LISTING_MAX_BYTES;
  const conflictPaths = options.limits?.conflictPaths ?? MANAGED_PATH_LIMIT;
  const priorBaseLimit = options.limits?.priorBases ?? PRIOR_BASE_LIMIT;
  const reservations = options.reservations ?? makeOverleafReservations();

  const now = Clock.currentTimeMillis;
  /** Size and change time of a kept file, or null when it is gone or not a file. */
  const stampAt = (path: string) =>
    Effect.promise(() =>
      NodeFSP.lstat(path, { bigint: true }).then(
        (stat) => (stat.isFile() ? `${stat.size}:${stat.ctimeNs}` : null),
        () => null,
      ),
    );

  const reserve = <A, E, R>(
    connectionId: string,
    body: (operationId: string) => Effect.Effect<A, E, R>,
  ) => reserveOverleafConnection(reservations, connectionId, body);

  const readActive = Effect.fn("OverleafCoordinator.readActive")(function* (connectionId: string) {
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
    const authorityCurrent = yield* OverleafAuthorityGuard;
    if (!(yield* authorityCurrent(connection)))
      return yield* new OverleafConnectionNotReadyError({
        connectionId: connection.connectionId,
        reason: "authority-changed",
      });
  });

  const repositoryFor = Effect.fn("OverleafCoordinator.repositoryFor")(function* (
    connection: OverleafConnectionDocument,
  ) {
    const repo = NodePath.join(options.stateRoot, "repositories", `${connection.connectionId}.git`);
    yield* repos.initialize({
      repo,
      gitUrl:
        options.gitUrl?.(connection) ?? `https://git.overleaf.com/${connection.remote.projectId}`,
    });
    return repo;
  });

  /**
   * What this connection syncs: the base, the last reviewed result, and every path an
   * interrupted apply left in a forced conflict, which may be in neither (the new name
   * of a rename it undid, say).
   */
  const captureScope = (
    connection: OverleafConnectionDocument,
    baseTree: ReadonlyArray<{ readonly path: string }>,
  ) =>
    unique([
      ...baseTree.map((entry) => entry.path),
      ...connection.managedPaths,
      ...connection.forcedConflicts.flat(),
    ]);

  /** Captures the folder and builds the review, reading requested collisions in full. */
  const buildReview = Effect.fn("OverleafCoordinator.buildReview")(function* (input: {
    readonly connection: OverleafConnectionDocument;
    readonly repo: string;
    readonly selections: OverleafSelections;
    /**
     * The review this one replaces. Its additions and sent files are selected
     * again, and new files follow the default rule, so a file that appeared
     * meanwhile is never taken for a deliberate "keep only here".
     */
    readonly replacing?: OverleafReviewBinding;
    readonly remote: { readonly commit: string; readonly tree: string };
    readonly checkoutEpoch: number;
  }) {
    const { connection, repo, replacing } = input;
    const requests =
      replacing !== undefined
        ? { keepOnlyHere: replacing.keepOnlyHere, send: replacing.send }
        : {
            keepOnlyHere: input.selections.keepOnlyHere ?? [],
            // A request to send local-only files is recorded as a send request too,
            // so a replacement review sends them even when a collision that
            // decided them in this review is gone by then.
            send: unique([
              ...(input.selections.send ?? []),
              ...(input.selections.sendLocalOnly ?? []),
            ]),
          };
    const selection =
      replacing !== undefined
        ? {
            selectedAdditions: replacing.selectedAdditions,
            sendLocalOnly: replacing.sentLocalOnly,
            ...requests,
            defaultSelection: { except: replacing.newLocalOnly, lenient: true },
          }
        : {
            selectedAdditions: input.selections.selectedAdditions ?? [],
            sendLocalOnly: input.selections.sendLocalOnly ?? [],
            ...requests,
            ...(input.selections.selectedAdditions === undefined
              ? { defaultSelection: { except: [], lenient: false } }
              : {}),
          };
    const baseTree =
      connection.base.tree === null
        ? []
        : yield* repos.readTree({ repo, tree: connection.base.tree });
    const managedPaths = captureScope(connection, baseTree);
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
          ...selection,
          requestedPaths: requested,
          stagingPaths: connection.stagingPaths,
          atCheckoutTop: connection.folder.relativePath === "",
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
        collisionPaths: requested,
        requests,
        choices: input.selections.choices,
        interrupted: connection.forcedConflicts,
        markers: connection.markers,
        releaseMarked: input.selections.releaseMarked ?? [],
        epochs: { checkout: input.checkoutEpoch, credential: credentialEpoch() },
        scratch,
      }).pipe(
        Effect.provideService(OverleafRepository.OverleafRepository, repos),
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

  /**
   * Writes the refs `next` needs, then replaces the document; refs it no longer needs
   * go after. What the repository holds decides, not the previous document's list: a
   * required ref found missing (one a record from before it was required never got)
   * is written again, and a failure to write it fails the replacement. The one
   * exception is an accepted attempt's ref, kept only so Undo stays possible, whose
   * object Git confirms is gone: nothing can pin it again, so it never blocks.
   */
  const replaceWithPins = Effect.fn("OverleafCoordinator.replaceWithPins")(function* (
    repo: string,
    previous: OverleafConnectionDocument,
    next: OverleafConnectionDocument,
  ) {
    const before = new Map(overleafRequiredPins(previous).map((pin) => [pin.name, pin.oid]));
    const after = overleafRequiredPins(next);
    const held = yield* repos.listRefs({ repo });
    const forUndo = new Set(
      next.attempts
        .filter((attempt) => attempt.outcome === "accepted")
        .flatMap((attempt) => [
          `attempt/${attempt.attemptNumber}/parent`,
          `attempt/${attempt.attemptNumber}/candidate`,
        ]),
    );
    for (const pin of after) {
      if (held.get(pin.name) === pin.oid) continue;
      if (
        before.get(pin.name) === pin.oid &&
        forUndo.has(pin.name) &&
        !(yield* repos.hasObject({ repo, oid: pin.oid }))
      )
        continue;
      yield* repos.setRef({ repo, ...pin });
    }
    yield* store.replaceConnection({ expectedRevision: previous.revision, next });
    const kept = new Set(after.map((pin) => pin.name));
    for (const name of before.keys())
      if (!kept.has(name)) yield* repos.deleteRef({ repo, name }).pipe(Effect.ignore);
  });

  /** The connection after the applier's result: one replacement, so it is adopted once. */
  const adoption = Effect.fn("OverleafCoordinator.adoption")(function* (
    repo: string,
    connection: OverleafConnectionDocument,
    result: WorkspaceApplier.WorkspaceApplyResult,
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
      return kept !== null && Schema.is(KeptPath)(kept) ? kept : null;
    };
    /**
     * One record per path this apply kept, naming every version the applier
     * reported for it: the main one (the displaced file) and any others (a
     * staged, provisional or retried step's copy). Others appear only when
     * something went wrong, so their record is never released automatically.
     */
    const keptByThisApply = (
      settle: (path: string) => OverleafConnectionDocument["retention"]["copies"][number]["state"],
      syncCount: number,
      /** Held files at their paths before this apply, with their other paths. */
      held: ReadonlyArray<{
        readonly path: string;
        readonly links: ReadonlyArray<string> | null;
      }>,
    ) => {
      const versionsOf = new Map<string, typeof result.retained>();
      for (const kept of result.retained)
        if (kept.retainedRevision !== null && keptAt(kept.retainedPath) !== null)
          versionsOf.set(kept.relativePath, [...(versionsOf.get(kept.relativePath) ?? []), kept]);
      return Effect.forEach([...versionsOf], ([relativePath, versions]) =>
        Effect.gen(function* () {
          const main =
            versions.find((kept) => kept.retainedPath?.endsWith("/retained")) ?? versions[0]!;
          const others = unique(
            versions.filter((kept) => kept !== main).map((kept) => keptAt(kept.retainedPath)!),
          );
          // The stamp is taken around a fresh read of the kept bytes: a late writer
          // may have changed them since the applier hashed them. Only a file that
          // still holds what was kept, unchanged throughout the read, gets one.
          const now = yield* Effect.promise(() => readWithin(main.retainedPath!, fileBytes));
          const verified = now._tag === "read" && now.revision === main.retainedRevision;
          const state =
            versions.some((kept) => kept.changed) || (!verified && now._tag !== "absent")
              ? ("changed" as const)
              : !verified || others.length > 0
                ? ("ambiguous" as const)
                : settle(relativePath);
          const marked = held.find((file) => file.path === relativePath);
          return {
            applyId: link.applyId,
            relativePath,
            revision: main.retainedRevision!,
            state,
            retainedAt: updatedAt,
            retainedAtSyncCount: syncCount,
            kept: keptAt(main.retainedPath)!,
            markers: marked !== undefined,
            markerLinks:
              marked === undefined ? [] : marked.links === null ? null : unique(marked.links),
            // Beyond the limit, the rest stay in the apply's folder; the record is ambiguous.
            versions: others.slice(0, KEPT_VERSION_LIMIT),
            // No stamp matches "0:0": an unverified copy is read again whenever listed.
            stamp: verified ? now.stamp : "0:0",
          };
        }),
      );
    };
    // Every explicit sync or restore checks the copies kept before (contract section
    // 8), by size and change time: a releasable copy that changed or is gone is
    // never released.
    const rechecked = yield* Effect.forEach(connection.retention.copies, (copy) =>
      copy.state !== "releasable"
        ? Effect.succeed(copy)
        : Effect.map(stampAt(NodePath.join(vault, copy.kept)), (now) =>
            now === copy.stamp
              ? copy
              : { ...copy, state: now === null ? ("ambiguous" as const) : ("changed" as const) },
          ),
    );
    if (link.kind !== "sync-apply") {
      // A restore or an undo keeps the bytes it displaced (never released
      // automatically), never moves the base, and sends nothing. What it wrote takes
      // part in the sync again unless it stays local-only on purpose (the link's
      // set); restored conflict material is tracked again. One the applier could
      // not finish leaves its groups for review beside those already recorded.
      const intent = yield* repos.readTree({ repo, tree: link.intentTree });
      // An undo's plan keys the applier's base by blob ID, so a path its write reached
      // has the intent's blob there: durable evidence, the same in recovery. A write
      // the applier skipped keeps the path's earlier part in the sync (local-only
      // stays local-only); a restore's write always counts, as before.
      const reached = intent.filter(
        (entry) => link.kind !== "sync-undo" || result.base.get(entry.path) === entry.oid,
      );
      const unreached = new Set(
        intent.filter((entry) => !reached.includes(entry)).map((entry) => entry.path),
      );
      const synced = reached
        .map((entry) => entry.path)
        .filter((path) => !link.localOnly.includes(path));
      // An undo's removal leaves the managed set once done (its path is gone from the
      // applier's base), or where every capture reads it anyway: the base or a forced
      // conflict. A removal skipped elsewhere stays managed, so its file is not lost
      // from the sync.
      const baseOf = new Set(
        link.retired === undefined || connection.base.tree === null
          ? []
          : (yield* repos.readTree({ repo, tree: connection.base.tree })).map(
              (entry) => entry.path,
            ),
      );
      const conflicted = new Set([...connection.forcedConflicts, ...result.interrupted].flat());
      const retired = new Set(
        (link.retired ?? []).filter(
          (path) => !result.base.has(path) || baseOf.has(path) || conflicted.has(path),
        ),
      );
      return {
        ...connection,
        revision: connection.revision + 1,
        managedPaths: unique([
          ...connection.managedPaths.filter((path) => !retired.has(path)),
          ...synced,
        ]),
        localOnlyPaths: unique([
          ...link.localOnly,
          ...connection.localOnlyPaths.filter((path) => unreached.has(path)),
        ]),
        forcedConflicts: [
          ...new Map(
            [...connection.forcedConflicts, ...result.interrupted].map((group) => {
              const paths = unique(group);
              return [paths.join("\0"), paths] as const;
            }),
          ).values(),
        ],
        markers: mergeMarkers(
          connection.markers,
          link.markers,
          result.markerPaths.map(freshMarker),
        ),
        stagingPaths: unique([...connection.stagingPaths, ...result.stagingPaths]),
        retention: {
          ...connection.retention,
          copies: [
            ...rechecked,
            ...(yield* keptByThisApply(
              () => "kept",
              connection.completedSyncCount,
              connection.markers.map((record) => ({
                path: record.path,
                links: [...record.folderPaths, ...record.overleafPaths].filter(
                  (path) => path !== record.path,
                ),
              })),
            )),
          ],
        },
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
    // Where the apply actually put each held file. A record not at a path of the
    // result comes from a version 1 link, which named files where they were before
    // the apply: the result's renames from the base say where they went. An apply
    // that did not finish every unit may have left a file where it was, so its
    // record keeps that path too until a review finds the file.
    const resultPaths = new Set(candidate.map((entry) => entry.path));
    let applied: ReadonlyArray<{ readonly from: string; readonly to: string }> | null = null;
    const placed: OverleafMarkerRecord[] = [];
    for (const record of link.markers) {
      let where = record;
      if (!resultPaths.has(record.path)) {
        applied ??=
          connection.base.tree === null
            ? []
            : (yield* repos.diff({
                repo,
                from: connection.base.tree,
                to: link.intentTree,
              })).flatMap((change) =>
                change.kind === "renamed" ? [{ from: change.from, to: change.to }] : [],
              );
        const known = new Set([record.path, ...record.folderPaths, ...record.overleafPaths]);
        const to = applied.find(
          (rename) => known.has(rename.from) && resultPaths.has(rename.to),
        )?.to;
        if (to !== undefined)
          where = {
            path: to,
            folderPaths: [record.path, ...record.folderPaths],
            overleafPaths: [...record.overleafPaths, to],
          };
      }
      placed.push(result.unitsDone ? { ...where, folderPaths: [] } : where);
    }
    const completedSyncCount =
      connection.completedSyncCount + (result.outcome === "complete" ? 1 : 0);
    const copies = [
      ...rechecked,
      ...(yield* keptByThisApply(
        (path) =>
          result.interrupted.some((group) => group.includes(path)) ? "interrupted" : "releasable",
        completedSyncCount,
        link.priorMarkers,
      )),
    ];
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
            ].slice(0, priorBaseLimit),
      completedSyncCount,
      // The reviewed result's paths (bounded by the review's file limit). Paths an
      // interrupted unit left as they were stay in the base or its forced conflicts,
      // both of which inventory reads too.
      managedPaths: unique(candidate.map((entry) => entry.path)),
      localOnlyPaths: unique(link.localOnly),
      forcedConflicts: result.interrupted.map((group) => unique(group)),
      // Files still held, where the apply put them, and those given new marks that
      // still have them. A record stays until its file's marks are gone.
      markers: mergeMarkers(placed, result.markerPaths.map(freshMarker)),
      stagingPaths: unique([...connection.stagingPaths, ...result.stagingPaths]),
      retention: { ...connection.retention, copies },
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
      adopted: {
        applyId: link.applyId,
        outcome: result.outcome,
        interrupted: result.interrupted,
        markerPaths: result.markerPaths,
        baseGeneration:
          connection.base.generation +
          (result.outcome === "replan" || link.kind !== "sync-apply" ? 0 : 1),
      } satisfies OverleafAdopted,
      applied: result,
    };
  });

  /** Recovers a linked apply, under a section of its own or one a bulk change holds. */
  const recoverHeld = Effect.fn("OverleafCoordinator.recoverHeld")(function* (
    connectionId: string,
    within?: CheckoutBarrier.CheckoutSection,
  ) {
    const pending = yield* readActive(connectionId);
    if (pending.activeApply === null) return { _tag: "none" as const };
    yield* store.admitWritable;
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
            adopted: (yield* runLinked(repo, connection)).adopted,
          };
        }),
      within ? { within } : undefined,
    );
  });

  /**
   * The tree of what the folder holds now, captured as a review captures it, with
   * `domain` read too; null if the capture was refused.
   */
  const capturedTree = Effect.fn("OverleafCoordinator.capturedTree")(function* (
    repo: string,
    connection: OverleafConnectionDocument,
    domain: ReadonlyArray<string>,
  ) {
    const baseTree =
      connection.base.tree === null
        ? []
        : yield* repos.readTree({ repo, tree: connection.base.tree });
    const captured = yield* Effect.promise(() =>
      captureOverleafInventory({
        folder: folderOf(connection),
        managedPaths: unique([...captureScope(connection, baseTree), ...domain]),
        localOnlyPaths: connection.localOnlyPaths,
        selectedAdditions: [],
        sendLocalOnly: [],
        requestedPaths: [],
        stagingPaths: connection.stagingPaths,
        atCheckoutTop: connection.folder.relativePath === "",
      }),
    );
    if (captured._tag === "refused") return null;
    const scratch = NodePath.join(options.stateRoot, "scratch", newOverleafId());
    yield* Effect.promise(() => NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 }));
    const written = yield* writeCapturedTree({
      repo,
      captured: captured.inventory.captured,
      scratch,
    }).pipe(
      Effect.provideService(OverleafRepository.OverleafRepository, repos),
      Effect.ensuring(Effect.promise(() => NodeFSP.rm(scratch, { recursive: true, force: true }))),
    );
    return written.tree;
  });

  /**
   * Records definite outcomes in one replacement. An acceptance of the attempt built on
   * the current base makes its candidate the base, overtaking any other unknown one.
   */
  const resolveAttempts = Effect.fn("OverleafCoordinator.resolveAttempts")(function* (
    repo: string,
    previous: OverleafConnectionDocument,
    found: ReadonlyMap<number, Pick<OverleafPublicationAttempt, "outcome" | "evidence">>,
  ) {
    const adopting = previous.attempts.find(
      (attempt) =>
        attempt.outcome === "unknown" &&
        attempt.baseGeneration === previous.base.generation &&
        found.get(attempt.attemptNumber)?.outcome === "accepted",
    );
    const next: OverleafConnectionDocument = {
      ...previous,
      revision: previous.revision + 1,
      attempts: previous.attempts.map((attempt) => {
        const settled = found.get(attempt.attemptNumber);
        if (settled !== undefined) return { ...attempt, ...settled };
        return adopting !== undefined && attempt.outcome === "unknown"
          ? {
              ...attempt,
              outcome: "superseded-unresolved" as const,
              evidence: "superseded" as const,
            }
          : attempt;
      }),
      ...(adopting === undefined
        ? {}
        : {
            base: {
              commit: adopting.candidateCommit,
              tree: adopting.candidateTree,
              generation: previous.base.generation + 1,
            },
            priorBases:
              previous.base.tree === null
                ? previous.priorBases
                : [
                    {
                      commit: previous.base.commit,
                      tree: previous.base.tree,
                      generation: previous.base.generation,
                    },
                    ...previous.priorBases,
                  ].slice(0, priorBaseLimit),
          }),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* replaceWithPins(repo, previous, next);
  });

  /**
   * Settles earlier sends against Overleaf's `head` by positive evidence only
   * (contract section 6): its tree, its bounded history, or the candidate's
   * reachability. Absent evidence leaves an attempt as it is. Never sends.
   */
  const checkAttempts = Effect.fn("OverleafCoordinator.checkAttempts")(function* (
    repo: string,
    connectionId: string,
    head: { readonly commit: string; readonly tree: string },
  ) {
    let connection = yield* readActive(connectionId);
    const open = connection.attempts.filter((attempt) =>
      isOverleafAttemptUnresolved(attempt.outcome),
    );
    const evidence = new Map<number, "remote-head-tree" | "remote-history">();
    for (const attempt of open) {
      const found = yield* probeAcceptance({
        repository: repos,
        repo,
        before: attempt.parentCommit,
        head,
        candidate: { commit: attempt.candidateCommit, tree: attempt.candidateTree },
      });
      // An unknown attempt is always on the current base; one that is not is left alone.
      if (
        found !== "unknown" &&
        (attempt.outcome !== "unknown" || attempt.baseGeneration === connection.base.generation)
      )
        evidence.set(
          attempt.attemptNumber,
          found === "current-tree" ? "remote-head-tree" : "remote-history",
        );
    }
    // Late evidence for an overtaken attempt never moves the base, so it is recorded
    // on its own first; then the current attempt's acceptance moves it.
    for (const overtaken of [true, false]) {
      const found = new Map(
        open
          .filter(
            (attempt) =>
              (attempt.outcome === "superseded-unresolved") === overtaken &&
              evidence.has(attempt.attemptNumber),
          )
          .map((attempt) => [
            attempt.attemptNumber,
            { outcome: "accepted" as const, evidence: evidence.get(attempt.attemptNumber)! },
          ]),
      );
      if (found.size === 0) continue;
      yield* resolveAttempts(repo, connection, found);
      connection = yield* readActive(connectionId);
    }
    return {
      accepted: [...evidence.keys()].sort((left, right) => left - right),
      unresolved: open
        .map((attempt) => attempt.attemptNumber)
        .filter((number) => !evidence.has(number)),
    } satisfies OverleafAttemptsChecked;
  });

  /**
   * The part of publication that needs the folder, inside the confirm's application
   * section (contract sections 5 and 6): gate, verify the folder, record the attempt.
   */
  const stagePublication = Effect.fn("OverleafCoordinator.stagePublication")(function* (input: {
    readonly repo: string;
    readonly connectionId: string;
    readonly operationId: string;
    readonly requestId: string;
    readonly review: OverleafReview;
    readonly adopted: OverleafAdopted;
    readonly applied: WorkspaceApplier.WorkspaceApplyResult;
  }) {
    const { repo, review, applied } = input;
    const connection = yield* readActive(input.connectionId);
    const held = new Set(review.binding.heldPaths);
    // Conflict marks in held files are the one reason for attention that still lets
    // the rest go out (design 4.2): every unit done, the folder holding exactly the
    // local target, and nothing else to review.
    const marksOnly =
      applied.outcome === "attention" &&
      applied.unitsDone &&
      applied.matchesTarget &&
      applied.retained.every((kept) => !kept.changed) &&
      applied.markerPaths.every((path) => held.has(path));
    // Otherwise only a whole apply with nothing left to review is sent. A late writer's
    // bytes in a copy this apply kept may be newer work than the candidate.
    const blocked =
      (applied.outcome !== "complete" && !marksOnly) || connection.forcedConflicts.length > 0
        ? ("attention" as const)
        : // Every file recorded with conflict material is one this review holds back.
          connection.markers.some((record) =>
              [record.path, ...record.folderPaths, ...record.overleafPaths].some(
                (path) => !held.has(path),
              ),
            )
          ? ("markers" as const)
          : connection.stagingPaths.length > 0
            ? ("staging" as const)
            : connection.retention.copies.some(
                  (copy) =>
                    copy.applyId === input.adopted.applyId &&
                    (copy.state === "changed" || copy.state === "ambiguous"),
                )
              ? ("kept-copy-changed" as const)
              : null;
    const outcome = (publication: OverleafPublication): Staged => ({
      _tag: "outcome",
      publication,
    });
    if (blocked !== null) return outcome({ _tag: "blocked", reason: blocked });
    const { publicationTree, remoteCommit, remoteTree } = review.binding;
    if (publicationTree === remoteTree) return outcome({ _tag: "none" });
    // Outside the held files, the folder must hold exactly what is sent, over the whole
    // publication domain (contract section 5): every path the plan read or wrote, so an
    // explicit deletion must still be absent. Held files are work in progress and are
    // not compared. What is sent is built from the repository's objects, never read
    // from the folder after this.
    const plan = review.applyPlan;
    const domain = [
      ...new Set([
        ...plan.base.keys(),
        ...plan.remote.keys(),
        ...plan.captured.keys(),
        ...plan.target.keys(),
      ]),
    ];
    const now = yield* capturedTree(repo, connection, domain);
    const outsideHeld = (tree: string) =>
      Effect.map(
        repos.readTree({ repo, tree }),
        (entries) =>
          new Map(
            entries
              .filter((entry) => !held.has(entry.path))
              .map((entry) => [entry.path, entry.oid]),
          ),
      );
    if (now === null) return outcome({ _tag: "not-verified" });
    if (now !== publicationTree) {
      const folder = yield* outsideHeld(now);
      const sent = yield* outsideHeld(publicationTree);
      if (
        held.size === 0 ||
        folder.size !== sent.size ||
        [...folder].some(([path, oid]) => sent.get(path) !== oid)
      )
        return outcome({ _tag: "not-verified" });
    }
    // A program still holding a file this apply replaced may have written into its kept
    // copy since adoption: newer work than the candidate. Each copy is checked again; a
    // change is recorded and stops the send.
    const vault = yield* vaultOf(connection);
    const rechecked = yield* Effect.forEach(connection.retention.copies, (copy) =>
      copy.applyId !== input.adopted.applyId || copy.state !== "releasable"
        ? Effect.succeed(copy)
        : Effect.map(stampAt(NodePath.join(vault, copy.kept)), (now) =>
            now === copy.stamp
              ? copy
              : { ...copy, state: now === null ? ("ambiguous" as const) : ("changed" as const) },
          ),
    );
    if (rechecked.some((copy, index) => copy !== connection.retention.copies[index])) {
      yield* replaceWithPins(repo, connection, {
        ...connection,
        revision: connection.revision + 1,
        retention: { ...connection.retention, copies: rechecked },
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return outcome({ _tag: "blocked", reason: "kept-copy-changed" });
    }
    // The attempt records the publication tree; acceptance makes it the base, where a
    // held file keeps Overleaf's version at Overleaf's paths, as the apply set it.
    const candidateCommit = yield* repos.commit({
      repo,
      tree: publicationTree,
      parents: [remoteCommit],
      message: "Sync from Scient",
    });
    const attemptNumber = connection.lastAttemptNumber + 1;
    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    // Resolved history makes room for the new attempt; unresolved evidence never does.
    const kept = [...connection.attempts];
    while (kept.length >= ATTEMPT_LIMIT) {
      const oldest = kept.findIndex((attempt) => !isOverleafAttemptUnresolved(attempt.outcome));
      if (oldest === -1) break;
      kept.splice(oldest, 1);
    }
    const recorded: OverleafConnectionDocument = {
      ...connection,
      revision: connection.revision + 1,
      lastAttemptNumber: attemptNumber,
      attempts: [
        ...kept,
        {
          attemptNumber,
          operationId: input.operationId,
          requestId: input.requestId,
          planDigest: review.digest,
          authority: connection.binding,
          branch: connection.remote.branch,
          parentCommit: remoteCommit,
          candidateCommit,
          candidateTree: publicationTree,
          baseGeneration: connection.base.generation,
          outcome: "unknown",
          evidence: null,
          recordedAt,
        },
      ],
      updatedAt: recordedAt,
    };
    // Pins first, then the record: no send unless both are durable.
    yield* replaceWithPins(repo, connection, recorded);
    yield* hook(options, "recorded");
    return { _tag: "recorded", attemptNumber, candidateCommit, recorded } satisfies Staged;
  });

  /**
   * Admits a recorded attempt and sends it once, outside the application section: the
   * network is never awaited while holding the checkout (contract section 9). Admission
   * is a short section of its own, deciding from what it finds there: the same checkout
   * (every key of its chain) at the same epoch as at verification, the same physical
   * folders, and the reviewed credential. Anything else (a pull, switch or restore that
   * ran or is running, a checkout replaced or removed, a renewed credential) records
   * `not-sent`. Changes after admission are later local changes; they never alter what
   * is sent.
   */
  const send = Effect.fn("OverleafCoordinator.publish")(function* (input: {
    readonly repo: string;
    readonly review: OverleafReview;
    readonly folder: string;
    /** The checkout the folder was verified in: its key chain and epoch. */
    readonly verified: Pick<CheckoutBarrier.CheckoutSection, "keys" | "epoch">;
    readonly attemptNumber: number;
    readonly candidateCommit: string;
    readonly recorded: OverleafConnectionDocument;
  }) {
    const { repo, attemptNumber, recorded } = input;
    yield* hook(options, "admitting");
    const admitted = yield* barrier
      .application(input.folder, (section) =>
        Effect.gen(function* () {
          if (
            section.epoch !== input.verified.epoch ||
            section.keys.join("\0") !== input.verified.keys.join("\0")
          )
            return false;
          yield* verifyFolders(recorded);
          // Decided here, after the section's own lookup, so a renewal meanwhile is seen.
          return credentialEpoch() === input.review.binding.credentialEpoch;
        }),
      )
      .pipe(Effect.orElseSucceed(() => false));
    if (!admitted) {
      yield* resolveAttempts(
        repo,
        recorded,
        new Map([
          [attemptNumber, { outcome: "not-sent" as const, evidence: "send-refused" as const }],
        ]),
      );
      return { _tag: "not-sent", attemptNumber } satisfies OverleafPublication;
    }
    const pushed = yield* options
      .pushRemote({
        repo,
        connection: recorded,
        commit: input.candidateCommit,
        credentialEpoch: input.review.binding.credentialEpoch,
      })
      // A push that failed partway may still have reached Overleaf.
      .pipe(
        Effect.orElseSucceed((): OverleafRepository.PushOutcome => ({
          _tag: "unknown",
          detail: "push failed",
        })),
      );
    yield* hook(options, "sent");
    if (pushed._tag === "unknown")
      return { _tag: "unknown", attemptNumber } satisfies OverleafPublication;
    // If this write fails, the attempt stays unknown for recovery to settle; never resent.
    yield* resolveAttempts(
      repo,
      recorded,
      new Map([
        [
          attemptNumber,
          pushed._tag === "accepted"
            ? { outcome: "accepted" as const, evidence: "push-accepted" as const }
            : { outcome: "out-of-date" as const, evidence: "push-out-of-date" as const },
        ],
      ]),
    );
    return { _tag: pushed._tag, attemptNumber } satisfies OverleafPublication;
  });

  const prepare: OverleafCoordinator["Service"]["prepare"] = Effect.fn(
    "OverleafCoordinator.prepare",
  )((input) =>
    reserve(input.connectionId, () =>
      Effect.gen(function* () {
        // Writable admission before anything touches the private repository.
        yield* store.admitWritable;
        let connection = yield* readActive(input.connectionId);
        let settled: OverleafAdopted | undefined;
        if (connection.activeApply !== null) {
          const recovered = yield* recoverHeld(input.connectionId);
          if (recovered._tag === "recovered" && recovered.adopted.outcome !== "complete")
            return { _tag: "recovered" as const, recovery: recovered.adopted };
          if (recovered._tag === "recovered") settled = recovered.adopted;
          connection = yield* readActive(input.connectionId);
        }
        const repo = yield* repositoryFor(connection);
        const remote = yield* options.fetchRemote({ repo, connection });
        // Earlier sends are settled against this head first: an acceptance moves the
        // base the review is built on.
        if (connection.attempts.some((attempt) => isOverleafAttemptUnresolved(attempt.outcome))) {
          yield* checkAttempts(repo, input.connectionId, remote);
          connection = yield* readActive(input.connectionId);
        }
        const section = yield* barrier.current(folderOf(connection));
        const built = yield* buildReview({
          connection,
          repo,
          // No selections: the review's default selection.
          selections: input.selections ?? { collisionPaths: [], choices: new Map() },
          remote,
          checkoutEpoch: section.epoch,
        });
        if (built._tag === "review") registry.offer(built.review, yield* now);
        return settled === undefined ? built : { ...built, settled };
      }),
    ),
  );

  const confirm: OverleafCoordinator["Service"]["confirm"] = Effect.fn(
    "OverleafCoordinator.confirm",
  )((input) =>
    reserve(input.connectionId, (operationId) =>
      Effect.gen(function* () {
        yield* store.admitWritable;
        const started = DateTime.formatIso(yield* DateTime.now);
        const begun = yield* store.beginReceipt({
          schemaVersion: 1,
          connectionId: input.connectionId,
          requestId: input.requestId,
          kind: "confirm",
          payloadDigest: sha256(
            [input.reviewId, input.digest, ...[...input.acknowledgements].sort(byPath)].join("\0"),
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
          const inSection = yield* barrier.application(folderOf(first), (section) =>
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
                  collisionPaths: review.binding.collisionPaths,
                  choices: new Map(review.binding.choices),
                  releaseMarked: review.binding.releaseMarked,
                },
                replacing: review.binding,
                remote,
                checkoutEpoch: section.epoch,
              });
              if (fresh._tag === "refused") return fresh;
              const stale = overleafReviewStaleness(review.binding, fresh.review.binding);
              if (stale !== null) {
                registry.offer(fresh.review, yield* now);
                return { _tag: "stale" as const, reason: stale, review: fresh.review };
              }
              // One kept record per path the plan changes, however many versions a step
              // keeps on disk: room is checked before anything is written.
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
              if (connection.retention.copies.length + changed > RETAINED_COPY_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "kept-copies",
                });
              // An interrupted unit leaves every path it guards as one forced conflict.
              // Each group must fit the record, or no adoption could ever be written.
              const groups = WorkspaceApplier.interruptibleGroups(plan);
              if (
                groups.length > FORCED_CONFLICT_LIMIT ||
                groups.some((group) => group.length > conflictPaths)
              )
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "conflict-group",
                });
              // A sync with changes to send records one more attempt, which must fit beside
              // every send still unresolved.
              if (
                review.binding.publicationTree !== review.binding.remoteTree &&
                connection.attempts.filter((attempt) =>
                  isOverleafAttemptUnresolved(attempt.outcome),
                ).length +
                  1 >
                  UNRESOLVED_ATTEMPT_LIMIT
              )
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "attempts",
                });
              const sequence =
                Math.max(0, ...connection.localSnapshots.map((snapshot) => snapshot.sequence)) + 1;
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
                  // What the review counted: kept entries less promoted collisions and
                  // files sent, plus ones deliberately kept here.
                  localOnly: unique([
                    ...connection.localOnlyPaths.filter(
                      (path) =>
                        !review.binding.collisionPaths.includes(path) &&
                        !review.binding.sentLocalOnly.includes(path),
                    ),
                    ...review.binding.newLocalOnly,
                  ]),
                  priorMarkers: review.binding.heldMarkers,
                  markers: review.binding.carriedMarkers,
                },
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              yield* replaceWithPins(repo, connection, withLink);
              linked = true;
              yield* hook(options, "linked");
              const { adopted, applied } = yield* runLinked(repo, withLink, review.applyPlan);
              return {
                _tag: "applied" as const,
                adopted,
                staged: yield* stagePublication({
                  repo,
                  connectionId: input.connectionId,
                  operationId,
                  requestId: input.requestId,
                  review,
                  adopted,
                  applied,
                }),
                verified: { keys: section.keys, epoch: section.epoch },
              };
            }),
          );
          if (inSection._tag !== "applied") return inSection;
          const { adopted, staged, verified } = inSection;
          return {
            _tag: "applied" as const,
            adopted,
            publication:
              staged._tag === "outcome"
                ? staged.publication
                : yield* send({ repo, review, folder: folderOf(first), verified, ...staged }),
          };
        }).pipe(
          Effect.tapError(() => finish(linked ? "unknown" : "failed", "error")),
          Effect.tap((done) =>
            finish(
              done._tag === "applied" ? "completed" : "failed",
              done._tag === "applied"
                ? `applied-${done.adopted.outcome}-${done.publication._tag}`
                : done._tag,
            ),
          ),
        );
        return result;
      }),
    ),
  );

  const recover: OverleafCoordinator["Service"]["recover"] = Effect.fn(
    "OverleafCoordinator.recover",
  )((input) =>
    reserve(input.connectionId, () =>
      Effect.gen(function* () {
        const recovered = yield* recoverHeld(input.connectionId);
        const connection = yield* readActive(input.connectionId);
        if (!connection.attempts.some((attempt) => isOverleafAttemptUnresolved(attempt.outcome)))
          return { ...recovered, attempts: { accepted: [], unresolved: [] } };
        // Checking earlier sends is the one network read recovery makes; offline, they wait.
        yield* store.admitWritable;
        const repo = yield* repositoryFor(connection);
        const head = yield* options.fetchRemote({ repo, connection }).pipe(Effect.option);
        if (Option.isNone(head)) return { ...recovered, attempts: null };
        return {
          ...recovered,
          attempts: yield* checkAttempts(repo, input.connectionId, head.value),
        };
      }),
    ),
  );

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
  const revisionOf = (read: FileRead) => (read._tag === "read" ? read.revision : null);

  const keptCopies: OverleafCoordinator["Service"]["keptCopies"] = Effect.fn(
    "OverleafCoordinator.keptCopies",
  )(function* (input) {
    const connection = yield* readActive(input.connectionId);
    const vault = yield* vaultOf(connection);
    const folder = folderOf(connection);
    // A late writer can grow kept files, so one listing reads within a budget; a
    // file past it, or larger than a restore reads back, is listed unread.
    let budget = listingBytes;
    const readOnce = (path: string, limit: number) =>
      Effect.promise(async () => {
        const read = await readWithin(path, Math.max(0, Math.min(limit, budget)));
        if (read._tag !== "absent") budget -= read.size;
        return read;
      });
    const current = new Map<string, FileRead>();
    const listed: OverleafKeptCopy[] = [];
    for (const copy of connection.retention.copies) {
      const now =
        current.get(copy.relativePath) ??
        (yield* readOnce(NodePath.join(folder, copy.relativePath), fileBytes));
      current.set(copy.relativePath, now);
      for (const kept of [copy.kept, ...copy.versions]) {
        const path = NodePath.join(vault, kept);
        // An unchanged main version holds what was recorded; only others are read again.
        const read: FileRead =
          kept === copy.kept && (yield* stampAt(path)) === copy.stamp
            ? { _tag: "read", revision: copy.revision, stamp: copy.stamp, size: 0, bytes: null }
            : yield* readOnce(path, fileBytes);
        listed.push({
          applyId: copy.applyId,
          kept,
          relativePath: copy.relativePath,
          state: copy.state,
          retainedAt: copy.retainedAt,
          revision: kept === copy.kept ? copy.revision : null,
          keptRevision: revisionOf(read),
          currentRevision: revisionOf(now),
          unread: read._tag === "unread" || now._tag === "unread",
        });
      }
    }
    return listed;
  });

  const restoreKept: OverleafCoordinator["Service"]["restoreKept"] = Effect.fn(
    "OverleafCoordinator.restoreKept",
  )((input) =>
    reserve(input.connectionId, (operationId) =>
      Effect.gen(function* () {
        yield* store.admitWritable;
        const started = DateTime.formatIso(yield* DateTime.now);
        const begun = yield* store.beginReceipt({
          schemaVersion: 1,
          connectionId: input.connectionId,
          requestId: input.requestId,
          kind: "restore",
          payloadDigest: sha256(
            [input.applyId, input.kept, input.keptRevision, input.currentRevision ?? "absent"].join(
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
              const vault = yield* vaultOf(connection);
              // The record that kept this version: its main one, or another it names.
              const copy = connection.retention.copies.find(
                (entry) =>
                  entry.applyId === input.applyId &&
                  (entry.kept === input.kept || entry.versions.includes(input.kept)),
              );
              if (copy === undefined || connection.base.commit === null)
                return { _tag: "unknown-copy" as const };
              // Conflict material kept as the main version is tracked again once back,
              // held at the path it returns to and at every other path its file had when
              // kept. For a copy kept before those were recorded, any path Overleaf has
              // may have been its file's: it is held at all of them.
              const restoresMarks = copy.markers && input.kept === copy.kept;
              const links =
                !restoresMarks || copy.markerLinks !== null
                  ? (copy.markerLinks ?? [])
                  : connection.base.tree === null
                    ? []
                    : (yield* repos.readTree({ repo, tree: connection.base.tree })).map(
                        (entry) => entry.path,
                      );
              const priorMarkers = restoresMarks
                ? [{ path: copy.relativePath, links: copy.markerLinks }]
                : [];
              const markers = restoresMarks
                ? [
                    {
                      path: copy.relativePath,
                      folderPaths: [],
                      overleafPaths: unique([copy.relativePath, ...links]),
                    },
                  ]
                : [];
              // Room for what the restore keeps, for the path it may bring back into the
              // sync, for the group it may leave and for the conflict material it tracks
              // again, before anything is written.
              const returning =
                !connection.managedPaths.includes(copy.relativePath) &&
                !connection.localOnlyPaths.includes(copy.relativePath);
              if (connection.retention.copies.length + 1 > RETAINED_COPY_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "kept-copies",
                });
              if (returning && connection.managedPaths.length + 1 > MANAGED_PATH_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "managed-paths",
                });
              // The restore's one file is one group if the applier cannot finish it.
              if (connection.forcedConflicts.length + 1 > FORCED_CONFLICT_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "conflict-group",
                });
              if (
                mergeMarkers(connection.markers, markers).length > MANAGED_PATH_LIMIT ||
                markers.some((record) => record.overleafPaths.length > MANAGED_PATH_LIMIT)
              )
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "marker-paths",
                });
              // Each read once and never past what a restore reads: the bytes checked
              // are the bytes restored. A file left unread is not an absent one.
              const keptNow = yield* Effect.promise(() =>
                readWithin(NodePath.join(vault, input.kept), fileBytes, true),
              );
              const currentNow = yield* Effect.promise(() =>
                readWithin(NodePath.join(folderOf(connection), copy.relativePath), fileBytes),
              );
              if (
                keptNow._tag !== "read" ||
                keptNow.revision !== input.keptRevision ||
                currentNow._tag === "unread" ||
                revisionOf(currentNow) !== input.currentRevision
              )
                return { _tag: "stale" as const };
              const bytes = keptNow.bytes!;
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
                  planDigest: sha256([copy.applyId, input.kept, input.keptRevision].join("\0")),
                  baseGeneration: connection.base.generation,
                  intentTree,
                  remoteCommit: connection.base.commit,
                  localOnly: connection.localOnlyPaths,
                  priorMarkers,
                  markers,
                },
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              yield* replaceWithPins(repo, connection, withLink);
              linked = true;
              yield* hook(options, "linked");
              // Outstanding reviews were built against the file this replaces.
              registry.invalidate(input.connectionId);
              const captured = new Map(
                input.currentRevision === null ? [] : [[copy.relativePath, input.currentRevision]],
              );
              return {
                _tag: "restored" as const,
                adopted: (yield* runLinked(repo, withLink, {
                  base: captured,
                  remote: new Map([[copy.relativePath, input.keptRevision]]),
                  captured,
                  target: new Map([[copy.relativePath, { bytes }]]),
                  renames: [],
                  conflicts: [],
                  markerPaths: [],
                })).adopted,
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
    ),
  );

  /**
   * What undoing an accepted send would do to the folder now (design section 4.3).
   * Every path the send changed is judged against the folder captured as a sync
   * captures it: a path is put back only while it holds exactly what the send left
   * there (its bytes, or absence) and its earlier version fits beside what stands.
   */
  const undoPlan = Effect.fn("OverleafCoordinator.undoPlan")(function* (
    repo: string,
    connection: OverleafConnectionDocument,
    attempt: OverleafPublicationAttempt,
  ) {
    // Both commits must still be held; a record from before accepted sends were pinned
    // may name ones that are gone.
    const parentTree = yield* repos.findTree({ repo, commit: attempt.parentCommit });
    if (
      parentTree === null ||
      (yield* repos.findTree({ repo, commit: attempt.candidateCommit })) !== attempt.candidateTree
    )
      return { _tag: "history-unavailable" as const };
    const entries = Effect.fnUntraced(function* (tree: string) {
      return new Map(
        (yield* repos.readTree({ repo, tree })).map((entry) => [entry.path, entry.oid]),
      );
    });
    const before = yield* entries(parentTree);
    const sent = yield* entries(attempt.candidateTree);
    const sizes = yield* repos.treeSizes({ repo, tree: parentTree });
    const changed = unique([...before.keys(), ...sent.keys()]).filter(
      (path) => before.get(path) !== sent.get(path),
    );
    const baseTree =
      connection.base.tree === null
        ? []
        : yield* repos.readTree({ repo, tree: connection.base.tree });
    const capture = (requestedPaths: ReadonlyArray<string>) =>
      Effect.promise(() =>
        captureOverleafInventory({
          folder: folderOf(connection),
          managedPaths: captureScope(connection, baseTree),
          localOnlyPaths: connection.localOnlyPaths,
          selectedAdditions: [],
          sendLocalOnly: [],
          requestedPaths,
          stagingPaths: connection.stagingPaths,
          atCheckoutTop: connection.folder.relativePath === "",
        }),
      );
    const first = yield* capture([]);
    if (first._tag === "refused") return first;
    // A path the send changed may lie outside what the sync reads now (a later sync
    // deleted it, say) while a file stands there again: it is read in full too, so
    // its bytes decide. A second request means the folder changed meanwhile.
    const unread = new Set([
      ...first.inventory.additions.map((addition) => addition.path),
      ...first.inventory.localOnly,
    ]);
    const requested = changed.filter((path) => unread.has(path));
    const captured = requested.length === 0 ? first : yield* capture(requested);
    if (captured._tag === "refused")
      return captured.refusal.reason === "not-selectable"
        ? {
            _tag: "refused" as const,
            refusal: { reason: "unstable" as const, path: captured.refusal.path },
          }
        : captured;
    const { inventory } = captured;
    // Everything the walk saw: files read or not, folders, and entries it skipped.
    const files = new Set([
      ...inventory.captured.keys(),
      ...inventory.additions.map((addition) => addition.path),
      ...inventory.localOnly,
    ]);
    const folders = new Set(inventory.folders);
    const excluded = new Set(inventory.excluded.map((entry) => entry.path));
    const foldersAbove = (path: string) => {
      const segments = path.split("/");
      return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
    };
    const onDisk = (path: string) =>
      files.has(path) ||
      folders.has(path) ||
      excluded.has(path) ||
      foldersAbove(path).some((folder) => excluded.has(folder));
    const skipped = new Map<string, OverleafUndoSkip>();
    /** Revisions of the files the undo replaces or removes, as captured. */
    const current = new Map<string, string>();
    const creations: string[] = [];
    for (const path of changed) {
      const left = sent.get(path);
      const now = inventory.captured.get(path);
      const nowOid =
        now === undefined ? undefined : yield* repos.writeBlob({ repo, bytes: now.bytes });
      if (left !== undefined && nowOid === left) current.set(path, now!.revision);
      else if (
        nowOid !== undefined ? nowOid === before.get(path) : !before.has(path) && !onDisk(path)
      )
        skipped.set(path, "already-undone");
      else if (left === undefined && (!onDisk(path) || folders.has(path))) creations.push(path);
      else skipped.set(path, "changed");
    }
    const removing = new Set([...current.keys()].filter((path) => !before.has(path)));
    // A folder the send made where a file stood may go only if the undo empties it.
    const occupied = [...files, ...excluded].filter((path) => !removing.has(path));
    const spellings = new Map<string, Set<string>>();
    for (const path of [...files, ...folders, ...excluded]) {
      const key = manuscriptCollisionKey(path);
      spellings.set(key, (spellings.get(key) ?? new Set()).add(path));
    }
    for (const path of creations) {
      if (
        folders.has(path) &&
        ([...sent.keys()].every((other) => !other.startsWith(`${path}/`)) ||
          occupied.some((other) => other.startsWith(`${path}/`)))
      )
        skipped.set(path, "changed");
      else if (
        foldersAbove(path).some(
          (folder) => (files.has(folder) && !removing.has(folder)) || excluded.has(folder),
        ) ||
        // Another spelling of it, or of a folder above it, would be written over on a
        // disk that ignores case or Unicode form.
        [path, ...foldersAbove(path)].some((name) =>
          [...(spellings.get(manuscriptCollisionKey(name)) ?? [])].some((other) => other !== name),
        )
      )
        skipped.set(path, "name-clash");
    }
    const writing = () =>
      [...before.keys()].filter(
        (path) => current.has(path) || (creations.includes(path) && !skipped.has(path)),
      );
    // Within what a restore reads back, and what one apply may hold in total.
    let budget = OVERLEAF_LIMITS.totalBytes;
    for (const path of writing()) {
      const size = sizes.get(path) ?? Number.POSITIVE_INFINITY;
      if (size > fileBytes || size > budget) {
        skipped.set(path, "too-large");
        current.delete(path);
      } else budget -= size;
    }
    // The folder afterwards must still be a tree: a write the checks above missed is
    // left out rather than forced.
    for (;;) {
      const created = new Set(creations.filter((path) => !skipped.has(path)));
      const problem = manuscriptTreeProblem([
        ...[...files].filter((path) => !removing.has(path)),
        ...created,
      ]);
      const involved =
        problem === null
          ? []
          : [
              "path" in problem ? problem.path : null,
              "file" in problem ? problem.file : null,
              "inside" in problem ? problem.inside : null,
              "first" in problem ? problem.first : null,
              "second" in problem ? problem.second : null,
            ].filter((path): path is string => path !== null && created.has(path));
      if (involved.length === 0) break;
      for (const path of involved) skipped.set(path, "name-clash");
    }
    const recreated = creations.filter((path) => !skipped.has(path));
    const restored = [...current.keys()].filter((path) => before.has(path));
    // A rename the send made is undone as one unit only when both its names are.
    const renames: Rename[] = (yield* repos.diff({
      repo,
      from: parentTree,
      to: attempt.candidateTree,
    })).flatMap((change) =>
      change.kind === "renamed" &&
      recreated.includes(change.from) &&
      removing.has(change.to) &&
      manuscriptCollisionKey(change.from) !== manuscriptCollisionKey(change.to)
        ? [{ from: change.to, to: change.from }]
        : [],
    );
    return {
      _tag: "plan" as const,
      restored,
      removed: [...removing],
      recreated,
      skipped: [...skipped]
        .map(([path, reason]) => ({ path, reason }))
        .sort((left, right) => byPath(left.path, right.path)),
      current,
      /** What the send left at each path it replaces or removes, as blob IDs. */
      left: new Map([...current.keys()].map((path) => [path, sent.get(path)!])),
      targets: new Map(writing().map((path) => [path, before.get(path)!])),
      renames,
      /** Paths every capture reads whether managed or not: the base's and forced conflicts'. */
      covered: new Set([
        ...baseTree.map((entry) => entry.path),
        ...connection.forcedConflicts.flat(),
      ]),
    };
  });

  const undo: OverleafCoordinator["Service"]["undo"] = (input) =>
    reserve(input.connectionId, (operationId) =>
      Effect.gen(function* () {
        yield* store.admitWritable;
        const started = DateTime.formatIso(yield* DateTime.now);
        const begun = yield* store.beginReceipt({
          schemaVersion: 1,
          connectionId: input.connectionId,
          requestId: input.requestId,
          kind: "undo",
          payloadDigest: sha256(`attempt\0${input.attemptNumber}`),
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
              const attempt = connection.attempts.find(
                (recorded) => recorded.attemptNumber === input.attemptNumber,
              );
              if (attempt === undefined || attempt.outcome !== "accepted")
                return {
                  _tag: "not-eligible" as const,
                  reason:
                    attempt === undefined
                      ? ("not-recorded" as const)
                      : isOverleafAttemptUnresolved(attempt.outcome)
                        ? ("unresolved" as const)
                        : attempt.outcome === "not-sent"
                          ? ("not-sent" as const)
                          : ("out-of-date" as const),
                };
              const plan = yield* undoPlan(repo, connection, attempt);
              if (plan._tag === "refused") return plan;
              if (plan._tag === "history-unavailable")
                return { _tag: "not-eligible" as const, reason: "history-unavailable" as const };
              const summary = {
                _tag: "undone" as const,
                restored: plan.restored,
                removed: plan.removed,
                recreated: plan.recreated,
                skipped: plan.skipped,
              };
              if (plan.targets.size === 0 && plan.removed.length === 0)
                return { ...summary, adopted: null };
              const target = new Map<string, { readonly bytes: Uint8Array }>();
              for (const [path, oid] of plan.targets)
                target.set(path, {
                  bytes: yield* repos.readBlob({ repo, oid, maxBytes: fileBytes }),
                });
              // The applier's base and remote are kept by blob ID, as a sync's are: the
              // base it records afterwards then shows, path by path, which writes it
              // made (adoption reads it, recovery too).
              const applyPlan = {
                base: plan.left,
                remote: plan.targets,
                captured: plan.current,
                target,
                renames: plan.renames,
                conflicts: [],
                markerPaths: [],
              } satisfies OverleafReview["applyPlan"];
              // Room for every copy it keeps, the files the sync manages afterwards and
              // every group it may leave, before anything is written.
              const written = [...plan.targets.keys()];
              // Adoption records one kept copy per path a step touched, whatever it
              // keeps there: the displaced file, or a staged or provisional version
              // that interference left (further versions sit inside that one record).
              // A file written where none stood can still leave one.
              const touched = new Set([...plan.current.keys(), ...written]).size;
              if (connection.retention.copies.length + touched > RETAINED_COPY_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "kept-copies",
                });
              // Files it writes join the managed set and files it removes leave it, so
              // undoing a rename at the limit fits. A removal leaves for certain only
              // where every capture reads the path anyway (the base, a forced
              // conflict); elsewhere only once the applier has done it, so the worst
              // case keeps it.
              const retired = plan.removed.filter((path) => connection.managedPaths.includes(path));
              const managedAfter = unique([
                ...connection.managedPaths.filter(
                  (path) => !(retired.includes(path) && plan.covered.has(path)),
                ),
                ...written,
              ]);
              if (managedAfter.length > MANAGED_PATH_LIMIT)
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "managed-paths",
                });
              const groups = WorkspaceApplier.interruptibleGroups(applyPlan);
              if (
                connection.forcedConflicts.length + groups.length > FORCED_CONFLICT_LIMIT ||
                groups.some((group) => group.length > conflictPaths)
              )
                return yield* new OverleafRetainedLimitError({
                  connectionId: input.connectionId,
                  limit: "conflict-group",
                });
              const intentTree = yield* repos.writeTree({
                repo,
                entries: written.map((path) => ({ path, oid: plan.targets.get(path)! })),
              });
              const withLink: OverleafConnectionDocument = {
                ...connection,
                revision: connection.revision + 1,
                activeApply: {
                  applyId: newOverleafId(),
                  kind: "sync-undo",
                  operationId,
                  planDigest: sha256(
                    [String(attempt.attemptNumber), intentTree, ...plan.removed].join("\0"),
                  ),
                  baseGeneration: connection.base.generation,
                  intentTree,
                  remoteCommit: connection.base.commit ?? attempt.candidateCommit,
                  // What Overleaf had goes back to it, even where it is now local-only.
                  localOnly: connection.localOnlyPaths.filter((path) => !written.includes(path)),
                  // An undo writes only where the folder still holds exactly what the
                  // send left, which never has conflict marks (held files are never
                  // sent): no held file is replaced, and conflict material stays
                  // recorded as it is (`adoption`).
                  priorMarkers: [],
                  markers: [],
                  undoneAttempt: attempt.attemptNumber,
                  retired,
                },
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              };
              yield* replaceWithPins(repo, connection, withLink);
              linked = true;
              yield* hook(options, "linked");
              // Outstanding reviews were built against the files this replaces.
              registry.invalidate(input.connectionId);
              return {
                ...summary,
                adopted: (yield* runLinked(repo, withLink, applyPlan)).adopted,
              };
            }),
          );
        }).pipe(
          Effect.tapError(() => finish(linked ? "unknown" : "failed", "error")),
          Effect.tap((done) =>
            finish(
              done._tag === "undone" ? "completed" : "failed",
              done._tag === "undone" ? `undone-${done.adopted?.outcome ?? "none"}` : done._tag,
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
      const refuse = new CheckoutBarrier.CheckoutRecoveryRequiredError({ checkout: section.root });
      const connectionIds = yield* store.listConnections.pipe(Effect.mapError(() => refuse));
      for (const connectionId of connectionIds) {
        const read = yield* store.readConnection(connectionId).pipe(Effect.mapError(() => refuse));
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
        // Recovery can find structural source copies the apply left in the folder:
        // the record it adopted decides, not the one read before.
        const adopted = yield* store
          .readConnection(connectionId)
          .pipe(Effect.mapError(() => refuse));
        if (
          adopted._tag !== "ready" ||
          adopted.document.activeApply !== null ||
          adopted.document.stagingPaths.length > 0
        )
          return yield* refuse;
      }
    }),
  );

  return OverleafCoordinator.of({ prepare, confirm, recover, keptCopies, restoreKept, undo });
});
