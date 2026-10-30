import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import {
  ByteLength,
  ContentHash,
  Count,
  EntityId,
  Label,
  ObservedAt,
  Pixels,
  ProcessId,
  RuntimeErrorText,
  Sequence,
  ShortText,
  Slug,
  StreamText,
} from "./primitives.ts";
import { ComputeDisplayOutput, ComputeMediaType } from "./representation.ts";
import type { DataTablePage, DataTableQuery } from "./table.ts";

export const ComputeSessionId = EntityId.pipe(Schema.brand("ComputeSessionId"));
export type ComputeSessionId = typeof ComputeSessionId.Type;

export const ComputeExecutionId = EntityId.pipe(Schema.brand("ComputeExecutionId"));
export type ComputeExecutionId = typeof ComputeExecutionId.Type;

/** Stable product identity for a reviewed scientific-computing Toolkit. */
export const ComputeToolkitId = Slug.pipe(Schema.brand("ComputeToolkitId"));
export type ComputeToolkitId = typeof ComputeToolkitId.Type;

/**
 * Correlates one command with the events it causes.
 *
 * It is not the execution identifier: a runtime also answers interrupt,
 * restart, and inspection commands, and it emits output that belongs to no
 * command at all.
 */
export const ComputeRequestId = EntityId.pipe(Schema.brand("ComputeRequestId"));
export type ComputeRequestId = typeof ComputeRequestId.Type;

export const ComputeLanguageId = Slug.pipe(Schema.brand("ComputeLanguageId"));
export type ComputeLanguageId = typeof ComputeLanguageId.Type;

/** "C++" → "cpp", "Wolfram Language" → "wolfram-language": a stable id from a language name. */
export function computeLanguageIdFromName(language: string): string {
  return (
    language
      .trim()
      .toLowerCase()
      .replace(/\+\+/gu, "pp")
      .replace(/#/gu, "sharp")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "kernel"
  );
}

export const ComputeTransportKind = Slug.pipe(Schema.brand("ComputeTransportKind"));
export type ComputeTransportKind = typeof ComputeTransportKind.Type;

/**
 * Names one namespace of a session. Restarting destroys a namespace, so every
 * mutating command carries the generation it was written against and is refused
 * when that namespace is gone.
 */
export const ComputeSessionGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("ComputeSessionGeneration"),
);
export type ComputeSessionGeneration = typeof ComputeSessionGeneration.Type;

export const INITIAL_COMPUTE_SESSION_GENERATION = ComputeSessionGeneration.make(1);

export function nextComputeSessionGeneration(
  generation: ComputeSessionGeneration,
): ComputeSessionGeneration {
  return ComputeSessionGeneration.make(generation + 1);
}

export const ComputeSessionStatus = Schema.Literals([
  "starting",
  "ready",
  "restarting",
  "stopping",
  "stopped",
  "failed",
  "lost",
]);
export type ComputeSessionStatus = typeof ComputeSessionStatus.Type;

export const TERMINAL_COMPUTE_SESSION_STATUSES: ReadonlySet<ComputeSessionStatus> = new Set([
  "stopped",
  "failed",
  "lost",
]);

/**
 * What the session is doing, which is not what has happened to it. A ready
 * session is idle or busy; a running execution whose interrupt does not settle
 * is unresponsive without yet destroying its namespace; a failed execution
 * leaves the session ready. Silence alone is valid for long scientific work.
 */
export const ComputeSessionActivity = Schema.Literals(["idle", "busy", "unresponsive"]);
export type ComputeSessionActivity = typeof ComputeSessionActivity.Type;

export const ComputeExecutionStatus = Schema.Literals([
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "interrupting",
  "cancelled",
  "lost",
]);
export type ComputeExecutionStatus = typeof ComputeExecutionStatus.Type;

export const TERMINAL_COMPUTE_EXECUTION_STATUSES: ReadonlySet<ComputeExecutionStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

/** How a runtime says an execution ended. Loss is reported about the session. */
export const ComputeExecutionOutcome = Schema.Literals(["succeeded", "failed", "cancelled"]);
export type ComputeExecutionOutcome = typeof ComputeExecutionOutcome.Type;

/**
 * Interrupt acknowledgement is not execution outcome. Preserve terminal/rejected/timeout
 * distinctions so callers know whether work ended or survived and whether escalation is needed.
 */
export const ComputeInterruptOutcome = Schema.Literals([
  "interrupted",
  "terminal",
  "rejected",
  "timeout",
]);
export type ComputeInterruptOutcome = typeof ComputeInterruptOutcome.Type;

export const ComputeOutputStream = Schema.Literals(["stdout", "stderr"]);
export type ComputeOutputStream = typeof ComputeOutputStream.Type;

/** A runtime error normalized out of a language-specific report. */
export const ComputeDiagnosticFrame = Schema.Struct({
  relativePath: ShortText,
  line: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  column: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  functionName: Schema.NullOr(Label),
});
export type ComputeDiagnosticFrame = typeof ComputeDiagnosticFrame.Type;

export const ComputeDiagnostic = Schema.Struct({
  errorName: Label,
  message: ShortText,
  traceback: Schema.Array(ShortText),
  // Older retained diagnostics predate structured source navigation.
  frames: Schema.Array(ComputeDiagnosticFrame)
    .check(Schema.isMaxLength(64))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type ComputeDiagnostic = typeof ComputeDiagnostic.Type;

export const ComputeImageMediaType = Schema.Literals(["image/png", "image/svg+xml"]);
export type ComputeImageMediaType = typeof ComputeImageMediaType.Type;

/** Capture provenance. A project-file is observed, not proven to be produced by the execution. */
export const ComputeImageOrigin = Schema.Union([
  Schema.TaggedStruct("runtime-display", {}),
  Schema.TaggedStruct("project-file", {
    path: ShortText,
    revision: ContentHash,
  }),
]);
export type ComputeImageOrigin = typeof ComputeImageOrigin.Type;

/** Facts about the session itself, told in the same ordered stream as its output. */
export const ComputeSystemEvent = Schema.Literals([
  "session-started",
  "session-restarted",
  "execution-interrupted",
  "session-lost",
  "output-truncated",
  "input-unsupported",
  "runtime-warning",
]);
export type ComputeSystemEvent = typeof ComputeSystemEvent.Type;

const OutputEnvelope = {
  sequence: Sequence,
  observedAt: ObservedAt,
} as const;

/**
 * Runtime sequence is an ordering cursor, not unique identity; normalized products may share it
 * with durable append order breaking ties. Keep the union closed so unknown output fails decoding
 * rather than disappearing silently.
 */
export const ComputeOutput = Schema.Union([
  Schema.TaggedStruct("stream", {
    ...OutputEnvelope,
    stream: ComputeOutputStream,
    text: StreamText,
  }),
  Schema.TaggedStruct("diagnostic", {
    ...OutputEnvelope,
    diagnostic: ComputeDiagnostic,
  }),
  Schema.TaggedStruct("image", {
    ...OutputEnvelope,
    mediaType: ComputeImageMediaType,
    contentHash: ContentHash,
    byteLength: ByteLength,
    width: Schema.NullOr(Pixels),
    height: Schema.NullOr(Pixels),
    // Optional for durable records written before image provenance existed.
    origin: Schema.optional(ComputeImageOrigin),
  }),
  Schema.TaggedStruct("system", {
    ...OutputEnvelope,
    event: ComputeSystemEvent,
    detail: Schema.NullOr(ShortText),
  }),
  ComputeDisplayOutput,
]);
export type ComputeOutput = typeof ComputeOutput.Type;

const utf8 = new TextEncoder();

/**
 * Charge exact NDJSON bytes plus resource bytes, including empty lifecycle facts. Count repeated
 * references repeatedly: limits bound produced output, not content-address deduplication. Transport
 * queue-memory estimates are a separate budget.
 */
export function computeOutputByteLength(output: ComputeOutput): number {
  const envelopeBytes = utf8.encode(`${JSON.stringify(output)}\n`).length;
  const resourceBytes =
    output._tag === "image"
      ? output.byteLength
      : output._tag === "display-data" ||
          output._tag === "execute-result" ||
          output._tag === "display-update"
        ? output.bundle.representations.reduce(
            (total, representation) =>
              total +
              (representation.data._tag === "resource" ? representation.data.byteLength : 0),
            0,
          )
        : 0;
  return envelopeBytes + resourceBytes;
}

/**
 * What a transport promises to do. A session refuses to start when the runtime
 * on the other side cannot do what the session needs, rather than discovering
 * it when a user asks.
 */
export const ComputeCapability = Schema.Literals([
  "execute",
  "interrupt",
  "restart",
  "shutdown",
  "completion",
  "inspection",
  "variables",
  "tables",
  "stdin",
]);
export type ComputeCapability = typeof ComputeCapability.Type;

/**
 * Namespace previews are transient descriptions, never serialized values/history. Omit unsafe
 * fields rather than invoke arbitrary user-defined representations to enrich display.
 */
export const ComputeVariable = Schema.Struct({
  name: Label,
  typeName: Label,
  shape: Schema.NullOr(ShortText),
  size: Schema.NullOr(Count),
  preview: Schema.NullOr(ShortText),
});
export type ComputeVariable = typeof ComputeVariable.Type;

/** One generation-scoped, bounded view of the current live namespace. */
export const ComputeVariableSnapshot = Schema.Struct({
  generation: ComputeSessionGeneration,
  variables: Schema.Array(ComputeVariable).check(Schema.isMaxLength(200)),
  truncated: Schema.Boolean,
});
export type ComputeVariableSnapshot = typeof ComputeVariableSnapshot.Type;

/** Identity of what is actually running, reported once the runtime answers. */
export const ComputeRuntimeIdentity = Schema.Struct({
  languageId: ComputeLanguageId,
  transportKind: ComputeTransportKind,
  protocolVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  languageVersion: Label,
  platform: Label,
  // The supervising sidecar and the process running user code are usually not
  // the same process, and stopping the session has to reach both.
  transportProcessId: Schema.NullOr(ProcessId),
  runtimeProcessId: Schema.NullOr(ProcessId),
});
export type ComputeRuntimeIdentity = typeof ComputeRuntimeIdentity.Type;

/**
 * Image bytes travel transiently beside durable metadata and are consumed once into compute
 * storage. Never persist base64 or large byte arrays in history snapshots.
 */
export const ComputeTransportImageEvent = Schema.Struct({
  bytes: Schema.Uint8Array,
});
export type ComputeTransportImageEvent = typeof ComputeTransportImageEvent.Type;

/** Transient bytes for one content-addressed rich representation. */
export const ComputeTransportResourceEvent = Schema.Struct({
  mediaType: ComputeMediaType,
  contentHash: ContentHash,
  bytes: Schema.Uint8Array,
});
export type ComputeTransportResourceEvent = typeof ComputeTransportResourceEvent.Type;

/**
 * Null requestId is session output, never whichever cell happens to run. Store transient
 * image/resources before appending references. Keep language errors raw for adapter normalization
 * with their original sequence/time; transports cannot infer language diagnostics.
 */
export const ComputeTransportEvent = Schema.Union([
  Schema.TaggedStruct("ready", {
    runtime: ComputeRuntimeIdentity,
    capabilities: Schema.Array(ComputeCapability),
  }),
  Schema.TaggedStruct("accepted", {
    requestId: ComputeRequestId,
    generation: ComputeSessionGeneration,
  }),
  Schema.TaggedStruct("output", {
    requestId: Schema.NullOr(ComputeRequestId),
    generation: ComputeSessionGeneration,
    output: ComputeOutput,
    image: Schema.NullOr(ComputeTransportImageEvent),
    resources: Schema.Array(ComputeTransportResourceEvent).check(Schema.isMaxLength(32)),
  }),
  Schema.TaggedStruct("runtime-error", {
    ...OutputEnvelope,
    requestId: Schema.NullOr(ComputeRequestId),
    generation: ComputeSessionGeneration,
    report: Schema.Struct({
      name: Label,
      value: RuntimeErrorText,
      traceback: Schema.Array(ShortText).check(Schema.isMaxLength(200)),
    }),
  }),
  Schema.TaggedStruct("completed", {
    ...OutputEnvelope,
    requestId: ComputeRequestId,
    generation: ComputeSessionGeneration,
    outcome: ComputeExecutionOutcome,
    /** The kernel's number for this run, for kernels that report one. */
    executionCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.TaggedStruct("restarted", {
    generation: ComputeSessionGeneration,
    runtime: ComputeRuntimeIdentity,
  }),
  Schema.TaggedStruct("lost", {
    reason: ShortText,
  }),
]);
export type ComputeTransportEvent = typeof ComputeTransportEvent.Type;

export class ComputeTransportError extends Schema.TaggedError<ComputeTransportError>()(
  "ComputeTransportError",
  {
    operation: Schema.Literals([
      "open",
      "handshake",
      "execute",
      "interrupt",
      "restart",
      "shutdown",
      "variables",
      "table",
      "receive",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** A Jupyter kernel the bridge host starts instead of ipykernel in its own interpreter. */
export interface ComputeKernelSpec {
  /** Kernel command line; Jupyter substitutes `{connection_file}`. */
  readonly argv: ReadonlyArray<string>;
  /** The `language_info.name` the kernel reports. */
  readonly language: string;
  readonly interruptMode: "signal" | "message";
  /** A kernel expression whose text/plain value is the variables JSON; absent means unsupported. */
  readonly variablesExpression: string | null;
  /** How long the bridge waits for this kernel to answer, for kernels slow to start. */
  readonly startupTimeoutSeconds?: number;
  /** An installed kernelspec's own environment and directory, as Jupyter would apply them. */
  readonly env?: Readonly<Record<string, string>>;
  readonly resourceDir?: string;
}

/**
 * The launched process may be a bridge host rather than the scientific runtime. Do not infer
 * runtime identity from this executable.
 */
export interface ComputeLaunchPlan {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Absent means ipykernel in the bridge host's own interpreter. */
  readonly kernel?: ComputeKernelSpec;
}

export interface ComputeTransportOpenRequest {
  readonly sessionId: ComputeSessionId;
  readonly generation: ComputeSessionGeneration;
  readonly languageId: ComputeLanguageId;
  readonly transportKind: ComputeTransportKind;
  readonly launch: ComputeLaunchPlan;
  readonly requiredCapabilities: ReadonlyArray<ComputeCapability>;
}

/**
 * Paths are project-relative claims, not authority. sourceBytesHash binds submitted bytes only; use
 * saved paths natively only after saved/hash and on-disk verification. Dirty/cell/selection
 * requests always execute exact submitted code.
 */
export interface ComputeExecuteSourceContext {
  readonly kind: "file" | "cell" | "selection";
  readonly filePath?: string;
  readonly fileName?: string;
  readonly sourceBytesHash?: string;
  readonly sourceRevision?: string;
  readonly saved?: boolean;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface ComputeExecuteRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
  readonly code: string;
  readonly sourceContext?: ComputeExecuteSourceContext;
}

export interface ComputeInterruptRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
}

export interface ComputeRestartRequest {
  readonly expectedGeneration: ComputeSessionGeneration;
  readonly nextGeneration: ComputeSessionGeneration;
}

export interface ComputeShutdownRequest {
  readonly expectedGeneration: ComputeSessionGeneration;
}

export interface ComputeVariablesRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
}

/** One page of a tabular value in the live namespace, read without entering history. */
export interface ComputeTableRequest {
  readonly requestId: ComputeRequestId;
  readonly expectedGeneration: ComputeSessionGeneration;
  readonly name: string;
  readonly query: DataTableQuery;
}

/**
 * Events decide asynchronous outcomes; interrupt's return only acknowledges signal delivery.
 * Expected generation on every mutation prevents stale clients from executing in or destroying a
 * replacement namespace.
 */
export interface ComputeChannel {
  readonly events: Stream.Stream<ComputeTransportEvent, ComputeTransportError>;
  readonly execute: (request: ComputeExecuteRequest) => Effect.Effect<void, ComputeTransportError>;
  readonly interrupt: (
    request: ComputeInterruptRequest,
  ) => Effect.Effect<ComputeInterruptOutcome, ComputeTransportError>;
  readonly restart: (request: ComputeRestartRequest) => Effect.Effect<void, ComputeTransportError>;
  readonly inspectVariables: (
    request: ComputeVariablesRequest,
  ) => Effect.Effect<ComputeVariableSnapshot, ComputeTransportError>;
  readonly inspectTable: (
    request: ComputeTableRequest,
  ) => Effect.Effect<DataTablePage, ComputeTransportError>;
  readonly shutdown: (
    request: ComputeShutdownRequest,
  ) => Effect.Effect<void, ComputeTransportError>;
}

export interface ComputeTransport {
  readonly open: (
    request: ComputeTransportOpenRequest,
  ) => Effect.Effect<ComputeChannel, ComputeTransportError, Scope.Scope>;
}

export const ComputeRuntimeSource = Schema.Literals([
  "managed",
  "configured",
  "project",
  "path",
  "conventional",
]);
export type ComputeRuntimeSource = typeof ComputeRuntimeSource.Type;

export const ComputeManagedRuntimeSelection = Schema.Literals(["managed", "existing"]);
export type ComputeManagedRuntimeSelection = typeof ComputeManagedRuntimeSelection.Type;

export const ComputeManagedRuntimeAction = Schema.Literals([
  "install",
  "update",
  "repair",
  "remove",
  "use-managed",
  "use-existing",
]);
export type ComputeManagedRuntimeAction = typeof ComputeManagedRuntimeAction.Type;

export const ComputeManagedRuntimePhase = Schema.Literals([
  "downloading",
  "installing-python",
  "installing-packages",
  "verifying",
  "removing",
]);
export type ComputeManagedRuntimePhase = typeof ComputeManagedRuntimePhase.Type;

export const ComputeManagedRuntimeOperation = Schema.Struct({
  operationId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  action: ComputeManagedRuntimeAction,
  phase: ComputeManagedRuntimePhase,
  startedAt: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  downloadedBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  totalBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ComputeManagedRuntimeOperation = typeof ComputeManagedRuntimeOperation.Type;

export const ComputeManagedRuntimeFailureReason = Schema.Literals([
  "invalid-request",
  "provision-failed",
  "verification-failed",
  "activation-failed",
  "remove-failed",
  "operation-failed",
]);
export type ComputeManagedRuntimeFailureReason = typeof ComputeManagedRuntimeFailureReason.Type;

export const ComputeManagedRuntimeFailure = Schema.Struct({
  reason: ComputeManagedRuntimeFailureReason,
  action: ComputeManagedRuntimeAction,
  summary: ShortText,
  detail: Schema.String.check(Schema.isMaxLength(4096)),
});
export type ComputeManagedRuntimeFailure = typeof ComputeManagedRuntimeFailure.Type;

/** An individual capability request, rebased by the server on its installed generation. */
export const ComputeManagedToolkitChange = Schema.Struct({
  toolkitId: ComputeToolkitId,
  action: Schema.Literals(["install", "remove", "cancel"]),
});
export type ComputeManagedToolkitChange = typeof ComputeManagedToolkitChange.Type;

export const ComputeManagedToolkitStatus = Schema.Struct({
  toolkitId: ComputeToolkitId,
  install: Schema.Boolean,
  state: Schema.Literals(["queued", "running", "failed"]),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ComputeManagedToolkitStatus = typeof ComputeManagedToolkitStatus.Type;

export const ComputeManagedRuntimeStatus = Schema.Struct({
  /** Labels belong to the reviewed adapter, not to a parallel UI provider switch. */
  displayName: Schema.optional(Label),
  description: Schema.optional(ShortText),
  /** The external installation served by an assisted connection helper. */
  installationExecutable: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  installed: Schema.Boolean,
  generationId: Schema.optional(Schema.NullOr(Label)),
  selection: ComputeManagedRuntimeSelection,
  updateAvailable: Schema.Boolean,
  /** Catalog freshness is separate from runtime readiness. */
  updateCheck: Schema.optional(Schema.Literals(["current", "checking", "cached", "unavailable"])),
  runtimeVersion: Schema.NullOr(Label),
  toolkitRevision: Schema.NullOr(Label),
  /** Reviewed Toolkits installed in the active immutable generation. */
  toolkitIds: Schema.optional(Schema.Array(ComputeToolkitId).check(Schema.isMaxLength(64))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  operation: Schema.NullOr(ComputeManagedRuntimeOperation),
  /** Present only on servers supporting individual queued Toolkit changes. */
  toolkitChanges: Schema.optional(
    Schema.Array(ComputeManagedToolkitStatus).check(Schema.isMaxLength(64)),
  ),
  /** Structured for current clients; failureMessage remains for older clients and logs. */
  failure: Schema.optional(Schema.NullOr(ComputeManagedRuntimeFailure)),
  failureMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
});
export type ComputeManagedRuntimeStatus = typeof ComputeManagedRuntimeStatus.Type;

export const ComputeRuntimeProfile = Schema.Struct({
  languageId: ComputeLanguageId,
  source: ComputeRuntimeSource,
  executable: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  languageVersion: Label,
  architecture: Schema.NullOr(Label),
  displayName: Label,
  /** Where discovery found it, as a user knows it: "conda: analysis", "pyenv", "Homebrew". */
  origin: Schema.optional(Label),
});
export type ComputeRuntimeProfile = typeof ComputeRuntimeProfile.Type;

/** Filesystem observation only. Presence is not execution or package readiness. */
export const ComputeRuntimeInstallation = Schema.Struct({
  executable: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  source: ComputeRuntimeSource,
  /** Explicit selection is independent of how an installation was discovered. */
  configured: Schema.optional(Schema.Boolean),
  version: Schema.NullOr(Label),
  problem: Schema.NullOr(ShortText),
  origin: Schema.optional(Label),
});
export type ComputeRuntimeInstallation = typeof ComputeRuntimeInstallation.Type;

export const ComputeRuntimeReadiness = Schema.Literals([
  "ready",
  "missing-requirement",
  "unsupported-version",
  "unusable",
]);
export type ComputeRuntimeReadiness = typeof ComputeRuntimeReadiness.Type;

/**
 * Package observations are bounded transient diagnostics, not a second durable package database.
 * Null means checked-and-missing; report only reviewed capability requirements and retain
 * fingerprint as execution identity.
 */
export const ComputeRuntimePackage = Schema.Struct({
  name: Slug,
  version: Schema.NullOr(Label),
});
export type ComputeRuntimePackage = typeof ComputeRuntimePackage.Type;

/** Why a runtime cannot be used, in terms a user can act on. */
export const ComputeRuntimeVerification = Schema.Struct({
  profile: ComputeRuntimeProfile,
  readiness: ComputeRuntimeReadiness,
  missingRequirements: Schema.Array(Label),
  message: Schema.NullOr(ShortText),
  /** Discovery is passive; only explicit verification starts and closes a real session. */
  connection: Schema.optional(Schema.Literals(["detected", "verified"])),
  // Optional on decode so retained fixtures and older attached clients remain
  // readable while current adapters always return the bounded observations.
  packages: Schema.Array(ComputeRuntimePackage)
    .check(Schema.isMaxLength(128))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type ComputeRuntimeVerification = typeof ComputeRuntimeVerification.Type;

/**
 * Identifies the environment an execution ran in without repeating it. The
 * contributor names say what was hashed; the values are deliberately absent so
 * a fingerprint can be stored and shown without leaking an environment.
 */
export const ComputeEnvironmentFingerprint = Schema.Struct({
  hash: ContentHash,
  contributors: Schema.Array(Label),
});
export type ComputeEnvironmentFingerprint = typeof ComputeEnvironmentFingerprint.Type;

/** A runtime error as the runtime reported it, before an adapter normalizes it. */
export interface ComputeRuntimeErrorReport {
  readonly name: string;
  readonly value: string;
  readonly traceback: ReadonlyArray<string>;
}

/** Server-owned source context an adapter may use to produce safe locations. */
export interface ComputeDiagnosticContext {
  readonly projectRoot: string;
  /** Bounded, server-owned provenance for executions retained by this live namespace. */
  readonly executionSources?: ReadonlyMap<
    string,
    {
      readonly relativePath: string;
      readonly startLine: number;
      readonly lineCount: number;
    }
  >;
  readonly submittedSource: {
    readonly relativePath: string;
    /** Zero-based first document line represented by runtime line one. */
    readonly startLine: number;
  } | null;
}

export interface ComputeDiscoveryRequest {
  /** Null for environment-level discovery, where project-local candidates are excluded. */
  readonly projectRoot: string | null;
  readonly configuredExecutable: string | null;
  /** Explicit user refresh bypasses the adapter's short probe cache. */
  readonly refresh?: boolean;
  /** Listing never runs anything unless a page asks for versions, within a short budget. */
  readonly probeVersions?: boolean;
}

export interface ComputeLaunchRequest {
  readonly profile: ComputeRuntimeProfile;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export class ComputeRuntimeError extends Schema.TaggedError<ComputeRuntimeError>()(
  "ComputeRuntimeError",
  {
    operation: Schema.Literals(["discover", "verify", "prepare", "fingerprint"]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Language adapters own discovery, readiness, launch, and diagnostics. Keep lifecycle, queueing,
 * persistence, and retention shared so each new language does not reimplement their guarantees.
 */
export interface ComputeLanguageAdapter {
  readonly languageId: ComputeLanguageId;
  readonly transportKind: ComputeTransportKind;
  /** Settings discovery must not spawn a runtime or import its execution bridge. */
  /**
   * The runtime the user chose for new sessions, if any. Automatic selection may pick any ready
   * runtime; an explicit choice keeps its own failure. Absent means the configured executable.
   */
  readonly selectedExecutable?: (
    request: ComputeDiscoveryRequest,
  ) => Effect.Effect<string | null, ComputeRuntimeError>;
  readonly listInstallations?: (
    request: ComputeDiscoveryRequest,
  ) => Effect.Effect<ReadonlyArray<ComputeRuntimeInstallation>, ComputeRuntimeError>;
  readonly discover: (
    request: ComputeDiscoveryRequest,
  ) => Effect.Effect<ReadonlyArray<ComputeRuntimeProfile>, ComputeRuntimeError>;
  readonly verify: (
    request: ComputeLaunchRequest,
  ) => Effect.Effect<ComputeRuntimeVerification, ComputeRuntimeError>;
  readonly prepareLaunch: (
    request: ComputeLaunchRequest,
  ) => Effect.Effect<ComputeLaunchPlan, ComputeRuntimeError>;
  readonly normalizeDiagnostic: (
    report: ComputeRuntimeErrorReport,
    context: ComputeDiagnosticContext,
  ) => ReadonlyArray<ComputeDiagnostic>;
  readonly fingerprintEnvironment: (
    profile: ComputeRuntimeProfile,
  ) => Effect.Effect<ComputeEnvironmentFingerprint, ComputeRuntimeError>;
}
