// @effect-diagnostics nodeBuiltinImport:off -- Folder identities and the folder walk.
/** Connect/disconnect/relink a folder and read status offline. Connect writes no
 * manuscript file and sends nothing; the first sync does both. Disconnect archives
 * with history and kept copies; reconnecting the same folder/project reactivates it.
 * Relink records a moved folder or renewed binding and keeps the base. */
import { platformFileIdentity } from "../workspace/PlatformFileIdentity.ts";
import { overleafDirectoryIdentity } from "./overleafHostPaths.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  OVERLEAF_CONNECTION_SCHEMA_VERSION,
  type OverleafConnectionDocument,
} from "./OverleafConnectionState.ts";
import {
  OverleafConnectionNotReadyError,
  type OverleafReservations,
  reserveOverleafConnection,
} from "./OverleafCoordinator.ts";
import { newOverleafId, type OverleafGitError } from "./OverleafGitExecutor.ts";
import { captureOverleafInventory } from "./OverleafInventory.ts";
import { classifyProbeGitFailure } from "./OverleafProtocolProbe.ts";
import { OverleafRepository, type OverleafRepositoryError } from "./OverleafRepository.ts";
import type { OverleafVolumeIdentityResolver } from "./OverleafRetentionVault.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";
import { manuscriptPathProblem } from "./manuscriptPaths.ts";

/** The workspace authority a connection is recorded under (contract rule 2). */
export interface OverleafAuthority {
  readonly bindingId: string;
  readonly authorityGeneration: number;
  readonly scopeRevision: number;
}

/** What a client may know about a connection. Never a token or raw Git output. */
export interface OverleafConnectionSummary {
  readonly connectionId: string;
  readonly checkoutRoot: string;
  /** Relative to the checkout; empty when the checkout itself is linked. */
  readonly folder: string;
  readonly projectId: string;
  readonly branch: "main" | "master";
  readonly state: "active" | "archived";
  readonly completedSyncCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Why connect, relink or disconnect did nothing. A fixed category, safe to show. */
export type OverleafConnectionRefusal =
  /** Not a path a manuscript folder can have. */
  | "folder-invalid"
  /** Linking an existing folder that is not there, or is not a folder. */
  | "folder-missing"
  /** Bringing a project in as a new folder where a folder with files already is. */
  | "folder-not-empty"
  /** A link, or outside the checkout. */
  | "folder-outside-checkout"
  /** The same folder, or one inside or around it, is linked already. */
  | "folder-overlaps"
  /** This Overleaf project is linked to another folder of this checkout already. */
  | "project-already-linked"
  /** The token was refused, or this account has no Git access to the project. */
  | "access-denied"
  | "project-not-found"
  /** Overleaf could not be reached. */
  | "unreachable"
  /** The project has no single `main` or `master` branch. */
  | "no-branch"
  /** Git is missing or older than 2.39. */
  | "git-unavailable"
  | "git-failed"
  /** Disconnect or relink while an apply or its staged files are unsettled. */
  | "local-work-pending"
  /** The caller's workspace authority changed while the request ran. */
  | "authority-changed"
  /**
   * An earlier request with this ID started and never recorded its result (the
   * process stopped). It is not run again; send a new request.
   */
  | "request-incomplete"
  /**
   * A connection record cannot be read, so which folders are linked is unknown.
   * Nothing is linked or moved until it is repaired.
   */
  | "records-unreadable"
  /** Not an Overleaf project link or ID. */
  | "project-invalid";

export type OverleafConnectResult =
  | {
      readonly _tag: "connected";
      readonly connection: OverleafConnectionSummary;
      /** An archived connection of this folder and project was reactivated, history intact. */
      readonly reconnected: boolean;
    }
  | { readonly _tag: "refused"; readonly reason: OverleafConnectionRefusal };

export type OverleafManageResult =
  | { readonly _tag: "done"; readonly connection: OverleafConnectionSummary }
  | { readonly _tag: "refused"; readonly reason: OverleafConnectionRefusal };

/**
 * A connection's state as status reads it (contract section 4). Recovery and
 * attention can hold together, so every reason is listed.
 */
export type OverleafAvailability =
  | "ready"
  | "recovery-required"
  | "attention"
  | "unavailable"
  | "disconnected";

export type OverleafStatusReason =
  /** An apply did not finish; the next sync or recovery finishes it. */
  | "apply-pending"
  /** Files an interrupted apply left half done: a conflict to settle. */
  | "interrupted-files"
  /** Files with Scient's conflict marks. */
  | "conflict-marks"
  /** Folders an interrupted structural change left in place. */
  | "staging"
  /** The checkout or folder is not the one recorded: moved, removed, or its disk is away. */
  | "folder-changed"
  /** Sends whose outcome Overleaf has not shown yet. */
  | "unresolved-sends";

/** What the folder holds against the last sync, read from disk only. */
export type OverleafLocalChanges =
  | {
      readonly _tag: "read";
      readonly changed: number;
      readonly deleted: number;
      /** New files the next sync would send by default. */
      readonly added: number;
    }
  /** The folder could not be read within the inventory's limits; the reason is the inventory's. */
  | { readonly _tag: "unread"; readonly reason: string };

export interface OverleafConnectionStatus {
  readonly connection: OverleafConnectionSummary;
  readonly availability: OverleafAvailability;
  readonly reasons: ReadonlyArray<OverleafStatusReason>;
  /** Null when the connection is unavailable or disconnected. */
  readonly local: OverleafLocalChanges | null;
  readonly markerPaths: ReadonlyArray<string>;
  readonly unresolvedSends: number;
  readonly keptCopies: number;
  /** Another operation holds the connection right now. */
  readonly busy: boolean;
  /** The link record's revision: it moves with every operation that changes the link. */
  readonly revision: number;
}

/** One Overleaf project ID: Overleaf's 24 hexadecimal digits. */
const PROJECT_ID = /^[0-9a-f]{24}$/u;
/** Accepts a project ID or an Overleaf project link (`/project/<id>`), nothing else. */
export const parseOverleafProject = (input: string): string | null => {
  const trimmed = input.trim();
  if (PROJECT_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(?:www\.)?overleaf\.com$/u.test(url.hostname)) return null;
  if (url.username !== "" || url.password !== "") return null;
  const match = /^\/project\/([0-9a-f]{24})\/?$/u.exec(url.pathname);
  return match?.[1] ?? null;
};

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
/** Git's object ID of a file's bytes, as the private repository would store them. */
const gitBlobId = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const summarize = (document: OverleafConnectionDocument): OverleafConnectionSummary => ({
  connectionId: document.connectionId,
  checkoutRoot: document.checkout.canonicalRoot,
  folder: document.folder.relativePath,
  projectId: document.remote.projectId,
  branch: document.remote.branch,
  state: document.state,
  completedSyncCount: document.completedSyncCount,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

/** A Git failure as a fixed category; Git's own text never leaves (contract section 11). */
export const gitRefusal = (
  error: OverleafGitError | OverleafRepositoryError,
): OverleafConnectionRefusal => {
  if (error._tag === "OverleafRepositoryError") return "git-failed";
  if (error.reason === "git-not-found" || error.reason === "git-too-old") return "git-unavailable";
  switch (classifyProbeGitFailure(error).category) {
    case "authentication-or-access-denied":
    case "credential-prompt":
    case "server-refused":
      return "access-denied";
    case "project-not-found":
      return "project-not-found";
    case "timeout":
    case "dns":
    case "tls":
    case "connection":
    case "redirect":
      return "unreachable";
    default:
      return "git-failed";
  }
};

/**
 * The physical identity (device and inode) of `path` and of every folder above it.
 * Two folders overlap when either's identity is in the other's chain, whatever
 * spelling (letter case, Unicode form, firmlink) names them; null when a part is gone.
 */
const identityChain = async (path: string): Promise<ReadonlyArray<string> | null> => {
  const chain: string[] = [];
  for (let current = path; ;) {
    const key = await platformFileIdentity.key(current).catch(() => null);
    if (key === null) return null;
    chain.push(key);
    const parent = NodePath.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
};
const overlaps = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.includes(right[0]!) || right.includes(left[0]!);
/** How long an offline status is reused: header chips ask often, the folder rarely changes. */
const STATUS_TTL_MILLIS = 2_000;

export interface OverleafConnectionsOptions {
  /** `stateDir/overleaf`: the private repositories live here. */
  readonly stateRoot: string;
  readonly environmentId: string;
  /** The host's publication helper; null only for the declared development fallback. */
  readonly publicationHelper: string | null;
  readonly reservations: OverleafReservations;
  /** Test seam: the Git address of a project. Defaults to Overleaf's. */
  readonly gitUrl?: (projectId: string) => string;
  /** Test seam: the disk's volume UUID for a path. */
  readonly volumeUuid: OverleafVolumeIdentityResolver;
}

export const makeOverleafConnections = Effect.fn("OverleafConnections.make")(function* (
  options: OverleafConnectionsOptions,
) {
  const store = yield* OverleafStateStore;
  const repos = yield* OverleafRepository;
  /** Contract section 3: one feature-wide registration mutex. */
  const registration = yield* Semaphore.make(1);
  const gitUrl = options.gitUrl ?? ((projectId: string) => `https://git.overleaf.com/${projectId}`);
  const repositoryPath = (connectionId: string) =>
    NodePath.join(options.stateRoot, "repositories", `${connectionId}.git`);
  const folderOf = (document: OverleafConnectionDocument) =>
    document.folder.relativePath === ""
      ? document.checkout.canonicalRoot
      : NodePath.join(document.checkout.canonicalRoot, document.folder.relativePath);

  /** The volume and file ID of a directory, or null when it is not one or its disk has none. */
  const identityOf = (path: string) =>
    overleafDirectoryIdentity(path, options.volumeUuid, options.publicationHelper ?? undefined);

  /** Every readable connection of this environment, and whether any record could not be read. */
  const readAll = Effect.gen(function* () {
    const ids = yield* store.listConnections;
    const found: OverleafConnectionDocument[] = [];
    let unreadable = false;
    for (const id of ids) {
      const read = yield* store.readConnection(id);
      if (read._tag === "ready") {
        if (read.document.environmentId === options.environmentId) found.push(read.document);
      } else if (read._tag !== "missing") unreadable = true;
    }
    return { found, unreadable };
  });
  const connections = Effect.map(readAll, (all) => all.found);

  /** Every component from the checkout down to `relative` is a real folder, not a link. */
  const containedFolder = (checkoutRoot: string, relative: string) =>
    Effect.promise(async () => {
      let path = checkoutRoot;
      for (const segment of relative === "" ? [] : relative.split("/")) {
        path = NodePath.join(path, segment);
        const stat = await NodeFSP.lstat(path).catch(() => null);
        if (stat === null) return "missing" as const;
        if (stat.isSymbolicLink() || !stat.isDirectory()) return "outside" as const;
      }
      const real = await NodeFSP.realpath(path).catch(() => null);
      const root = await NodeFSP.realpath(checkoutRoot).catch(() => null);
      return real !== null &&
        root !== null &&
        (real === root || real.startsWith(root.endsWith(NodePath.sep) ? root : root + NodePath.sep))
        ? ("ok" as const)
        : ("outside" as const);
    });

  const list = Effect.fn("OverleafConnections.list")(function* (filter?: {
    readonly checkoutRoot?: string;
  }) {
    const all = yield* connections;
    return all
      .filter(
        (document) =>
          filter?.checkoutRoot === undefined ||
          document.checkout.canonicalRoot === filter.checkoutRoot,
      )
      .map(summarize);
  });

  const connect = Effect.fn("OverleafConnections.connect")(function* (input: {
    readonly authority: OverleafAuthority;
    /** The binding's canonical root, already resolved by the caller. */
    readonly checkoutRoot: string;
    readonly folder: string;
    /** Create the folder (bring a project in) rather than link an existing one. */
    readonly create: boolean;
    readonly projectId: string;
    readonly token: Uint8Array;
    readonly requestId: string;
    /** The caller's authority is still the one resolved for this request. */
    readonly stillAuthorized: Effect.Effect<boolean>;
    /** Whether a binding the caller did not resolve now belongs to the caller's project. */
    readonly owns: (bindingId: string) => Effect.Effect<boolean>;
  }) {
    const folderPath = input.folder.replace(/\/+$/u, "");
    yield* store.admitWritable;
    return yield* registration.withPermits(1)(
      Effect.gen(function* () {
        const absolute =
          folderPath === "" ? input.checkoutRoot : NodePath.join(input.checkoutRoot, folderPath);
        // A repeated request names the same receipt. It answers only the same caller
        // asking the same thing; reuse with other input is refused (contract section 3).
        const connectionId = `c-${sha256(`${options.environmentId}\0${input.requestId}`).slice(0, 40)}`;
        const started = DateTime.formatIso(yield* DateTime.now);
        const begun = yield* store.beginReceipt({
          schemaVersion: 1,
          connectionId,
          requestId: input.requestId,
          kind: "connect",
          payloadDigest: sha256(
            [
              input.authority.bindingId,
              input.checkoutRoot,
              folderPath,
              String(input.create),
              input.projectId,
            ].join("\0"),
          ),
          operationId: connectionId,
          status: "running",
          resultCategory: null,
          createdAt: started,
          updatedAt: started,
        });
        if (begun._tag === "existing" && begun.receipt.status === "running")
          return { _tag: "refused", reason: "request-incomplete" } satisfies OverleafConnectResult;
        if (begun._tag === "existing" && begun.receipt.status === "failed")
          return {
            _tag: "refused",
            reason: (begun.receipt.resultCategory ?? "git-failed") as OverleafConnectionRefusal,
          } satisfies OverleafConnectResult;
        if (begun._tag === "existing" && begun.receipt.status === "completed") {
          const made = begun.receipt.resultCategory?.replace(/^id-/u, "") ?? connectionId;
          const found = yield* store.readConnection(made);
          if (
            found._tag === "ready" &&
            found.document.binding.bindingId === input.authority.bindingId
          )
            return {
              _tag: "connected",
              connection: summarize(found.document),
              reconnected: false,
            } satisfies OverleafConnectResult;
          return { _tag: "refused", reason: "folder-overlaps" } satisfies OverleafConnectResult;
        }
        const finish = (status: "completed" | "failed", resultCategory: string) =>
          store
            .finishReceipt({ connectionId, requestId: input.requestId, status, resultCategory })
            .pipe(Effect.ignore);
        return yield* Effect.gen(function* () {
          let created = false;
          const removeCreated = Effect.promise(() =>
            created ? NodeFSP.rmdir(absolute).catch(() => undefined) : Promise.resolve(),
          );
          // Every refusal is recorded, so a repeated request gets it again.
          const refuse = (reason: OverleafConnectionRefusal) =>
            removeCreated.pipe(
              Effect.andThen(finish("failed", reason)),
              Effect.as({ _tag: "refused", reason } satisfies OverleafConnectResult),
            );
          if (
            (folderPath !== "" && manuscriptPathProblem(folderPath) !== null) ||
            (input.create && folderPath === "")
          )
            return yield* refuse("folder-invalid");
          if (!PROJECT_ID.test(input.projectId)) return yield* refuse("project-invalid");
          // Contract rule 2: the authority resolved for this request still holds, here
          // inside registration, before anything is created or recorded.
          if (!(yield* input.stillAuthorized)) return yield* refuse("authority-changed");
          if (input.create) {
            const parent = NodePath.dirname(folderPath);
            if ((yield* containedFolder(input.checkoutRoot, parent === "." ? "" : parent)) !== "ok")
              return yield* refuse("folder-missing");
            const entries = yield* Effect.promise(() =>
              NodeFSP.readdir(absolute).then(
                (names) => names,
                () => null,
              ),
            );
            if (entries !== null && entries.length > 0) return yield* refuse("folder-not-empty");
            if (entries === null) {
              const made = yield* Effect.promise(() =>
                NodeFSP.mkdir(absolute).then(
                  () => true,
                  () => false,
                ),
              );
              if (!made) return yield* refuse("folder-missing");
              created = true;
            }
          }

          const contained = yield* containedFolder(input.checkoutRoot, folderPath);
          if (contained === "missing") return yield* refuse("folder-missing");
          if (contained === "outside") return yield* refuse("folder-outside-checkout");
          const checkoutIdentity = yield* identityOf(input.checkoutRoot);
          const folderIdentity = yield* identityOf(absolute);
          if (checkoutIdentity === null || folderIdentity === null)
            return yield* refuse("folder-missing");

          // Contract rule 1: one connection owns a folder; none is inside another.
          const chain = yield* Effect.promise(() => identityChain(absolute));
          if (chain === null) return yield* refuse("folder-missing");
          // Contract rule 1 needs every record: one that cannot be read may own this folder.
          const all = yield* readAll;
          if (all.unreadable) return yield* refuse("records-unreadable");
          const others = all.found;
          let archive: OverleafConnectionDocument | null = null;
          for (const other of others) {
            const otherChain = yield* Effect.promise(() => identityChain(folderOf(other)));
            const sameDirectory = platformFileIdentity.equal(other.folder.identity, folderIdentity);
            const sameFolder = sameDirectory || (otherChain !== null && otherChain[0] === chain[0]);
            if (other.state === "archived") {
              // Reactivate an archive only for its own project and recorded directory:
              // a replacement at the same path would inherit its base and its first
              // sync would delete Overleaf's files. Otherwise start a new connection.
              if (
                sameDirectory &&
                other.remote.projectId === input.projectId &&
                archive === null &&
                (yield* input.owns(other.binding.bindingId))
              )
                archive = other;
              continue;
            }
            // Asking again for a link that already stands is answered with that link.
            if (
              sameFolder &&
              other.remote.projectId === input.projectId &&
              other.binding.bindingId === input.authority.bindingId
            ) {
              yield* finish("completed", `id-${other.connectionId}`);
              return {
                _tag: "connected",
                connection: summarize(other),
                reconnected: false,
              } satisfies OverleafConnectResult;
            }
            if (sameFolder || (otherChain !== null && overlaps(chain, otherChain)))
              return yield* refuse("folder-overlaps");
            if (
              other.remote.projectId === input.projectId &&
              other.checkout.canonicalRoot === input.checkoutRoot
            )
              return yield* refuse("project-already-linked");
          }

          const id = archive?.connectionId ?? connectionId;
          const repo = repositoryPath(id);
          const reached = yield* Effect.gen(function* () {
            yield* repos.initialize({ repo, gitUrl: gitUrl(input.projectId) });
            const branch = yield* repos.discoverBranch({ repo, token: input.token });
            if (branch === null) return null;
            yield* repos.fetch({ repo, branch, token: input.token });
            return branch;
          }).pipe(
            Effect.map((branch) =>
              branch === null
                ? ({ _tag: "refused", reason: "no-branch" } as const)
                : ({ _tag: "reached", branch } as const),
            ),
            Effect.catchTags({
              OverleafGitError: (error) =>
                Effect.as(
                  // Overleaf's wording for an unknown refusal is kept, without URLs, for diagnosis.
                  ["server-refused", "unclassified"].includes(
                    classifyProbeGitFailure(error).category,
                  )
                    ? Effect.logWarning("Overleaf connect refused in unrecognised words", {
                        detail: error.detail.replace(/https?:\/\/\S+/gu, "[remote]").slice(0, 1000),
                      })
                    : Effect.void,
                  { _tag: "refused", reason: gitRefusal(error) } as const,
                ),
              OverleafRepositoryError: (error) =>
                Effect.succeed({ _tag: "refused", reason: gitRefusal(error) } as const),
            }),
          );
          if (reached._tag === "refused") return yield* refuse(reached.reason);
          if (!(yield* input.stillAuthorized)) return yield* refuse("authority-changed");

          if (archive !== null) {
            // Reconnecting the same folder to the same project: its history survives.
            const reactivated = yield* reserveOverleafConnection(options.reservations, id, () =>
              Effect.gen(function* () {
                const retention = yield* store.prepareRetention({
                  environmentId: options.environmentId,
                  connectionId: id,
                  checkoutRoot: input.checkoutRoot,
                  publicationHelper: options.publicationHelper,
                  expected: archive.retention.vaultIdentity,
                });
                const next: OverleafConnectionDocument = {
                  ...archive,
                  revision: archive.revision + 1,
                  state: "active",
                  binding: input.authority,
                  checkout: { canonicalRoot: input.checkoutRoot, identity: checkoutIdentity },
                  folder: { relativePath: folderPath, identity: folderIdentity },
                  remote: { ...archive.remote, branch: reached.branch },
                  retention: { ...archive.retention, vaultIdentity: retention.identity },
                  updatedAt: started,
                };
                yield* store.replaceConnection({ expectedRevision: archive.revision, next });
                return next;
              }),
            );
            yield* finish("completed", `id-${id}`);
            return {
              _tag: "connected",
              connection: summarize(reactivated),
              reconnected: true,
            } satisfies OverleafConnectResult;
          }

          const retention = yield* store
            .prepareRetention({
              environmentId: options.environmentId,
              connectionId: id,
              checkoutRoot: input.checkoutRoot,
              publicationHelper: options.publicationHelper,
              expected: null,
            })
            .pipe(Effect.tapError(() => removeCreated));
          const document: OverleafConnectionDocument = {
            schemaVersion: OVERLEAF_CONNECTION_SCHEMA_VERSION,
            connectionId: id,
            revision: 1,
            environmentId: options.environmentId,
            binding: input.authority,
            checkout: { canonicalRoot: input.checkoutRoot, identity: checkoutIdentity },
            folder: { relativePath: folderPath, identity: folderIdentity },
            remote: {
              host: "www.overleaf.com",
              projectId: input.projectId,
              branch: reached.branch,
            },
            mode: "manual",
            state: "active",
            base: { commit: null, tree: null, generation: 0 },
            completedSyncCount: 0,
            priorBases: [],
            localSnapshots: [],
            managedPaths: [],
            localOnlyPaths: [],
            forcedConflicts: [],
            markers: [],
            stagingPaths: [],
            retention: { vaultIdentity: retention.identity, copies: [] },
            activeApply: null,
            lastAttemptNumber: 0,
            attempts: [],
            createdAt: started,
            updatedAt: started,
          };
          yield* store.createConnection(document).pipe(Effect.tapError(() => removeCreated));
          yield* finish("completed", `id-${id}`);
          return {
            _tag: "connected",
            connection: summarize(document),
            reconnected: false,
          } satisfies OverleafConnectResult;
        });
      }),
    );
  });

  /** Reads an active connection, or fails the way the coordinator does. */
  const readActive = Effect.fn("OverleafConnections.readActive")(function* (connectionId: string) {
    const read = yield* store.readConnection(connectionId);
    if (read._tag !== "ready")
      return yield* new OverleafConnectionNotReadyError({ connectionId, reason: read._tag });
    if (read.document.state !== "active")
      return yield* new OverleafConnectionNotReadyError({ connectionId, reason: "archived" });
    return read.document;
  });

  /**
   * A management request's receipt (contract section 3): a repeated request returns
   * its result, never acts twice; the same request ID with other input is refused.
   */
  const managed = Effect.fn("OverleafConnections.managed")(function* <E, R>(
    input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly kind: "disconnect" | "relink";
      readonly payload: ReadonlyArray<string>;
    },
    body: Effect.Effect<OverleafManageResult, E, R>,
  ) {
    const started = DateTime.formatIso(yield* DateTime.now);
    const begun = yield* store.beginReceipt({
      schemaVersion: 1,
      connectionId: input.connectionId,
      requestId: input.requestId,
      kind: input.kind,
      payloadDigest: sha256([input.kind, ...input.payload].join("\0")),
      operationId: newOverleafId(),
      status: "running",
      resultCategory: null,
      createdAt: started,
      updatedAt: started,
    });
    if (begun._tag === "existing" && begun.receipt.status === "running")
      return { _tag: "refused", reason: "request-incomplete" } satisfies OverleafManageResult;
    if (begun._tag === "existing") {
      if (begun.receipt.status === "failed")
        return {
          _tag: "refused",
          reason: (begun.receipt.resultCategory ?? "git-failed") as OverleafConnectionRefusal,
        } satisfies OverleafManageResult;
      const now = yield* store.readConnection(input.connectionId);
      if (now._tag === "ready")
        return {
          _tag: "done",
          connection: summarize(now.document),
        } satisfies OverleafManageResult;
    }
    const result = yield* body;
    yield* store
      .finishReceipt({
        connectionId: input.connectionId,
        requestId: input.requestId,
        status: result._tag === "done" ? "completed" : "failed",
        resultCategory: result._tag === "done" ? "done" : result.reason,
      })
      .pipe(Effect.ignore);
    return result;
  });

  const disconnect = Effect.fn("OverleafConnections.disconnect")(function* (input: {
    readonly connectionId: string;
    readonly requestId: string;
    readonly callerBindingId: string;
    /** The caller's and the connection's authority still hold, checked before the change. */
    readonly stillAuthorized: (document: OverleafConnectionDocument) => Effect.Effect<boolean>;
  }) {
    yield* store.admitWritable;
    return yield* reserveOverleafConnection(options.reservations, input.connectionId, () =>
      managed(
        {
          connectionId: input.connectionId,
          requestId: input.requestId,
          kind: "disconnect",
          payload: [input.callerBindingId],
        },
        Effect.gen(function* () {
          const document = yield* readActive(input.connectionId);
          // Contract section 4: local work settles first. Unknown sends may be archived.
          if (document.activeApply !== null || document.stagingPaths.length > 0)
            return { _tag: "refused", reason: "local-work-pending" } satisfies OverleafManageResult;
          if (!(yield* input.stillAuthorized(document)))
            return { _tag: "refused", reason: "authority-changed" } satisfies OverleafManageResult;
          const next: OverleafConnectionDocument = {
            ...document,
            revision: document.revision + 1,
            state: "archived",
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* store.replaceConnection({ expectedRevision: document.revision, next });
          return { _tag: "done", connection: summarize(next) } satisfies OverleafManageResult;
        }),
      ),
    );
  });

  const relink = Effect.fn("OverleafConnections.relink")(function* (input: {
    readonly connectionId: string;
    readonly requestId: string;
    readonly authority: OverleafAuthority;
    readonly checkoutRoot: string;
    readonly folder: string;
    /** The caller's authority still holds, checked before the change. */
    readonly stillAuthorized: Effect.Effect<boolean>;
  }) {
    const folderPath = input.folder.replace(/\/+$/u, "");
    yield* store.admitWritable;
    return yield* registration.withPermits(1)(
      reserveOverleafConnection(options.reservations, input.connectionId, () =>
        managed(
          {
            connectionId: input.connectionId,
            requestId: input.requestId,
            kind: "relink",
            payload: [input.authority.bindingId, input.checkoutRoot, folderPath],
          },
          Effect.gen(function* () {
            if (folderPath !== "" && manuscriptPathProblem(folderPath) !== null)
              return { _tag: "refused", reason: "folder-invalid" } satisfies OverleafManageResult;
            const document = yield* readActive(input.connectionId);
            if (document.activeApply !== null || document.stagingPaths.length > 0)
              return {
                _tag: "refused",
                reason: "local-work-pending",
              } satisfies OverleafManageResult;
            const absolute =
              folderPath === ""
                ? input.checkoutRoot
                : NodePath.join(input.checkoutRoot, folderPath);
            const contained = yield* containedFolder(input.checkoutRoot, folderPath);
            if (contained !== "ok")
              return {
                _tag: "refused",
                reason: contained === "missing" ? "folder-missing" : "folder-outside-checkout",
              } satisfies OverleafManageResult;
            const checkoutIdentity = yield* identityOf(input.checkoutRoot);
            const folderIdentity = yield* identityOf(absolute);
            if (checkoutIdentity === null || folderIdentity === null)
              return { _tag: "refused", reason: "folder-missing" } satisfies OverleafManageResult;
            const chain = yield* Effect.promise(() => identityChain(absolute));
            if (chain === null)
              return { _tag: "refused", reason: "folder-missing" } satisfies OverleafManageResult;
            const all = yield* readAll;
            if (all.unreadable)
              return {
                _tag: "refused",
                reason: "records-unreadable",
              } satisfies OverleafManageResult;
            for (const other of all.found) {
              if (other.connectionId === document.connectionId || other.state !== "active")
                continue;
              const otherChain = yield* Effect.promise(() => identityChain(folderOf(other)));
              if (
                platformFileIdentity.equal(other.folder.identity, folderIdentity) ||
                (otherChain !== null && overlaps(chain, otherChain))
              )
                return {
                  _tag: "refused",
                  reason: "folder-overlaps",
                } satisfies OverleafManageResult;
              if (
                other.remote.projectId === document.remote.projectId &&
                other.checkout.canonicalRoot === input.checkoutRoot
              )
                return {
                  _tag: "refused",
                  reason: "project-already-linked",
                } satisfies OverleafManageResult;
            }
            if (!(yield* input.stillAuthorized))
              return {
                _tag: "refused",
                reason: "authority-changed",
              } satisfies OverleafManageResult;
            // The kept copies' folder is found again by its recorded identity.
            const retention = yield* store.prepareRetention({
              environmentId: options.environmentId,
              connectionId: document.connectionId,
              checkoutRoot: input.checkoutRoot,
              publicationHelper: options.publicationHelper,
              expected: document.retention.vaultIdentity,
            });
            const next: OverleafConnectionDocument = {
              ...document,
              revision: document.revision + 1,
              binding: input.authority,
              checkout: { canonicalRoot: input.checkoutRoot, identity: checkoutIdentity },
              folder: { relativePath: folderPath, identity: folderIdentity },
              retention: { ...document.retention, vaultIdentity: retention.identity },
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* store.replaceConnection({ expectedRevision: document.revision, next });
            return { _tag: "done", connection: summarize(next) } satisfies OverleafManageResult;
          }),
        ),
      ),
    );
  });

  const statusCache = new Map<
    string,
    { readonly revision: number; readonly at: number; readonly status: OverleafConnectionStatus }
  >();
  /**
   * Reads disk only: never fetches, never writes, never takes the connection. A
   * status is reused briefly while the connection's record is unchanged.
   */
  const status = Effect.fn("OverleafConnections.status")(function* (input: {
    readonly connectionId: string;
  }) {
    const read = yield* store.readConnection(input.connectionId);
    const now = yield* Clock.currentTimeMillis;
    if (read._tag === "ready") {
      const cached = statusCache.get(input.connectionId);
      const busy = options.reservations.has(input.connectionId);
      if (
        cached !== undefined &&
        cached.revision === read.document.revision &&
        now - cached.at < STATUS_TTL_MILLIS
      )
        return { ...cached.status, busy } satisfies OverleafConnectionStatus;
      const fresh = yield* statusOf(read.document);
      statusCache.set(input.connectionId, {
        revision: read.document.revision,
        at: now,
        status: fresh,
      });
      return fresh;
    }
    return yield* new OverleafConnectionNotReadyError({
      connectionId: input.connectionId,
      reason: read._tag,
    });
  });

  const statusOf = Effect.fn("OverleafConnections.statusOf")(function* (
    document: OverleafConnectionDocument,
  ) {
    const busy = options.reservations.has(document.connectionId);
    const unresolvedSends = document.attempts.filter(
      (attempt) => attempt.outcome === "unknown" || attempt.outcome === "superseded-unresolved",
    ).length;
    const base = {
      connection: summarize(document),
      // The folder paths of files recorded with conflict marks not settled yet.
      markerPaths: document.markers.map((record) => record.path),
      unresolvedSends,
      keptCopies: document.retention.copies.length,
      busy,
      revision: document.revision,
    };
    if (document.state === "archived")
      return {
        ...base,
        availability: "disconnected",
        reasons: [],
        local: null,
      } satisfies OverleafConnectionStatus;

    const reasons: OverleafStatusReason[] = [];
    const checkout = yield* identityOf(document.checkout.canonicalRoot);
    const folder = yield* identityOf(folderOf(document));
    const same = (
      found: OverleafConnectionDocument["folder"]["identity"] | null,
      recorded: OverleafConnectionDocument["folder"]["identity"],
    ) => found !== null && platformFileIdentity.equal(found, recorded);
    if (!same(checkout, document.checkout.identity) || !same(folder, document.folder.identity))
      return {
        ...base,
        availability: "unavailable",
        reasons: ["folder-changed"],
        local: null,
      } satisfies OverleafConnectionStatus;
    if (document.activeApply !== null) reasons.push("apply-pending");
    if (document.forcedConflicts.length > 0) reasons.push("interrupted-files");
    if (document.markers.length > 0) reasons.push("conflict-marks");
    if (document.stagingPaths.length > 0) reasons.push("staging");
    if (unresolvedSends > 0) reasons.push("unresolved-sends");

    const local = yield* localChanges(document);
    const availability: OverleafAvailability =
      document.activeApply !== null
        ? "recovery-required"
        : reasons.some((reason) => reason !== "unresolved-sends")
          ? "attention"
          : "ready";
    return { ...base, availability, reasons, local } satisfies OverleafConnectionStatus;
  });

  /** Compares the folder with the base by Git object ID; reads files, writes nothing. */
  const localChanges = Effect.fn("OverleafConnections.localChanges")(function* (
    document: OverleafConnectionDocument,
  ) {
    const repo = repositoryPath(document.connectionId);
    const baseEntries =
      document.base.tree === null
        ? []
        : yield* repos
            .readTree({ repo, tree: document.base.tree })
            .pipe(Effect.orElseSucceed(() => null));
    if (baseEntries === null)
      return { _tag: "unread", reason: "history-unavailable" } satisfies OverleafLocalChanges;
    const base = new Map(baseEntries.map((entry) => [entry.path, entry.oid]));
    const captured = yield* Effect.promise(() =>
      captureOverleafInventory({
        folder: folderOf(document),
        managedPaths: [
          ...new Set([
            ...base.keys(),
            ...document.managedPaths,
            ...document.forcedConflicts.flat(),
          ]),
        ],
        localOnlyPaths: document.localOnlyPaths,
        selectedAdditions: [],
        sendLocalOnly: [],
        requestedPaths: [],
        stagingPaths: document.stagingPaths,
        atCheckoutTop: document.folder.relativePath === "",
      }),
    );
    if (captured._tag === "refused")
      return {
        _tag: "unread",
        reason: captured.refusal.reason,
      } satisfies OverleafLocalChanges;
    let changed = 0;
    for (const [path, file] of captured.inventory.captured) {
      const recorded = base.get(path);
      if (recorded === undefined || recorded !== gitBlobId(file.bytes)) changed++;
    }
    return {
      _tag: "read",
      changed,
      deleted: captured.inventory.missingManaged.filter((path) => base.has(path)).length,
      added: captured.inventory.additions.filter((addition) => addition.checkedByDefault).length,
    } satisfies OverleafLocalChanges;
  });

  /** Readable connection records with their recorded bindings, for ownership checks. */
  const documents = connections;

  return { connect, disconnect, relink, status, list, documents };
});

export type OverleafConnections = Effect.Success<ReturnType<typeof makeOverleafConnections>>;
