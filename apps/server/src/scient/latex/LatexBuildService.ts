// @effect-diagnostics nodeBuiltinImport:off -- Build work directories are keyed by a host SHA-256 digest.
/**
 * Coalesce rebuilds and bound compiles; keep aux files outside the workspace. Superseded
 * generations cannot mutate binding/failure state. Publish only clean exits, retaining stale
 * last-good PDF on compiler failure; succeeded also requires unchanged content evidence.
 */
import * as NodeCrypto from "node:crypto";

import {
  type ArtifactId,
  ArtifactProducerId,
  type ArtifactRevisionId,
  type DocumentArtifactBinding,
  LogicalDocumentKey,
  ProducingOperationId,
  type PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { ExecutionRunId, type ExecutionProcessHandle } from "@scientfactory/execution";
import type {
  ScientLatexBuildSnapshot,
  ScientLatexBuildState,
  ScientLatexDiagnostic,
  ScientLatexResolveRequest,
  ScientLatexResolveResult,
  ScientLatexToolchainStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { makeOperationAnalytics } from "../../telemetry/OperationAnalytics.ts";
import * as ServerConfig from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import {
  GeneratedDocumentStore,
  type GeneratedDocumentProductionHandle,
} from "../documentArtifacts/GeneratedDocumentStore.ts";
import * as LocalExecutionProcess from "../execution/LocalExecutionProcess.ts";
import { LatexPackageInstaller } from "./LatexPackageInstaller.ts";
import { resolveLatexDocument } from "./LatexProjectIndex.ts";
import { LatexToolchain, latexDriverBinDirectory, latexDriverLabel } from "./LatexToolchain.ts";
import { LatexSyncTex } from "./LatexSyncTex.ts";
import { latexTexDirectory } from "./latexTexDirectory.ts";
import { parseLatexRecorderManifest, parseTectonicMakefileRules } from "./flsManifest.ts";
import {
  EMPTY_EVIDENCE_MARKS,
  collectLatexBuildEvidence,
  decodePublishedLatexBuildEvidence,
  encodePublishedLatexBuildEvidence,
  latexBuildInputsChangedDuringCompile,
  latexEvidenceMatches,
  latexVisualNeedsRequalification,
  latexVisualSourceRevisions,
  probeLatexEvidence,
  UNVERIFIED_FILE_DIGEST,
  type LatexBuildEvidence,
  type LatexEvidenceMarks,
} from "./latexBuildEvidence.ts";
import { buildLatexInvocation, latexEngineEnvironment } from "./latexCommand.ts";
import { selectLatexBuildEngine } from "./latexEngineGate.ts";
import { parseLatexLog, summarizeLatexFailure, transcriptFailureDiagnostic } from "./latexLog.ts";
import { missingLatexPackageInputs } from "./latexMissingPackages.ts";
import { latexPreambleIncludes, latexPreamblePackages } from "./latexPreamble.ts";
import { makeLatexProcessRetirementMarkers } from "./latexProcessRetirement.ts";
import { isLatexSourcePath, resolveLatexRoot } from "./latexRoot.ts";

export interface LatexBuildInput {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}

/** Server-local admission carried by callers that already captured a source intent. */
export interface LatexBuildAdmission {
  readonly expectedMutationEpoch: string;
}

function staleSnapshot(snapshot: ScientLatexBuildSnapshot): ScientLatexBuildSnapshot {
  const reason = "Sources changed. Rebuild to update the PDF.";
  const { compiledBibliography: _bibliography, ...current } = snapshot;
  return {
    ...current,
    state: "idle",
    visualSourceRevisions: {},
    descriptor:
      snapshot.descriptor?._tag === "generated-pdf"
        ? { ...snapshot.descriptor, bindingStatus: "stale", staleReason: reason }
        : snapshot.descriptor,
  };
}

export class LatexBuildError extends Schema.TaggedError<LatexBuildError>()("LatexBuildError", {
  operation: Schema.Literals(["resolve", "build", "status", "cancel"]),
  reason: Schema.Literals([
    "invalid-path",
    "document-key-too-long",
    "workspace-unsettled",
    "sources-changed",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class LatexBuildService extends Context.Service<
  LatexBuildService,
  {
    readonly resolveDocument: (
      input: ScientLatexResolveRequest,
    ) => Effect.Effect<ScientLatexResolveResult, LatexBuildError>;
    readonly requestBuild: (
      input: LatexBuildInput,
      admission?: LatexBuildAdmission,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
    readonly status: (
      input: LatexBuildInput,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
    /** Consume only the original guarded output receipt, never a freshly read epoch. */
    readonly acknowledgeOutputPublication: (input: {
      readonly logicalDocumentKey: string;
      readonly artifactId: ArtifactId;
      readonly revisionId: ArtifactRevisionId;
      readonly expectedMutationEpoch: string;
      readonly publicationEpoch: string;
    }) => Effect.Effect<boolean>;
    readonly cancel: (
      input: LatexBuildInput,
    ) => Effect.Effect<ScientLatexBuildSnapshot, LatexBuildError>;
  }
>()("t3/scient/latex/LatexBuildService") {}

const LATEX_PRODUCER_ID = ArtifactProducerId.make("latex");
const BUILD_TIMEOUT = "240 seconds";
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** The banner and the engine's own summary of the run live at the very top. */
const TRANSCRIPT_HEAD_BYTES = 2 * 1024;
const MAX_LOGICAL_DOCUMENT_KEY_LENGTH = 1_024;
/**
 * Root resolution never needs more than the head of a file: the magic-comment
 * scan stops at 4 000 characters and `\documentclass` sits in the preamble, so
 * a status poll on a multi-megabyte source reads one block instead of all of it.
 */
const ROOT_RESOLUTION_HEAD_BYTES = 8 * 1_024;
/** Bounds containing-root discovery in source-heavy workspaces. */
const MAX_ROOT_DISCOVERY_CANDIDATES = 128;
const MAX_ROOT_DISCOVERY_ANCESTORS = 16;
/**
 * How much of the root document the upfront package scan reads. A preamble is
 * the first page or two of a file, but a document that defines its own macros
 * before the last `\usepackage` can push one a long way down, and this read is
 * paid once per build rather than per poll.
 */
const PREAMBLE_SCAN_HEAD_BYTES = 64 * 1_024;
/**
 * And of each file the root pulls in. A chapter's own `\usepackage` lines sit
 * at its top or not at all, and there are up to eight of these reads.
 */
const INCLUDED_PREAMBLE_SCAN_HEAD_BYTES = 16 * 1_024;
/** Across the root and everything it pulls in, after deduplication. */
const MAX_PREAMBLE_PACKAGES_PER_BUILD = 40;
/** A compile is CPU- and disk-bound; three at once keeps a laptop usable. */
const MAX_CONCURRENT_COMPILES = 3;
/**
 * LaTeX exposes only the first missing package per compile, even in nonstopmode. Keep the round
 * bound above real preambles; stop on no progress and never retry an already-attempted missing name
 * within the build.
 */
const MAX_PACKAGE_RESOLUTION_ROUNDS = 15;

/**
 * TeX wraps its own messages at 79 columns by default, which cuts file paths
 * and error text in half before the parser ever sees them. These are the
 * documented `texmf.cnf` knobs for that, and every engine reads them from the
 * environment.
 */
const TEX_OUTPUT_ENVIRONMENT: Readonly<Record<string, string>> = {
  max_print_line: "1000",
  error_line: "254",
  half_error_line: "238",
};

const NO_TOOLCHAIN_SUMMARY =
  "No LaTeX toolchain found. Install latexmk (TeX Live or MiKTeX) or tectonic, then try again.";

/**
 * A broken existing driver needs its own complaint, not no-install advice. Agent-visible summaries
 * name distribution/file without username-bearing folders; show full paths only in setup UI.
 */
function noToolchainSummary(toolchain: Pick<ScientLatexToolchainStatus, "unusable">): string {
  const unusable = toolchain.unusable?.[0];
  return unusable === undefined
    ? NO_TOOLCHAIN_SUMMARY
    : `No working LaTeX toolchain found. ${latexDriverLabel(unusable.executable)} did not run: ${unusable.reason}`;
}
const TIMEOUT_SUMMARY = "Build timed out.";
const CANCELLED_SUMMARY = "Build cancelled.";
const MISSING_PDF_SUMMARY = "The LaTeX engine reported success but produced no PDF.";
const SOURCES_CHANGED_DURING_BUILD_SUMMARY =
  "LaTeX sources changed while the document was compiling. Rebuild after the edits settle.";
const PUBLISHED_PDF_VERIFICATION_SUMMARY =
  "The published PDF could not be verified against its live document binding.";
const UNEXPECTED_FAILURE_SUMMARY = "The LaTeX build could not be completed.";

const ACTIVE_STATES: ReadonlySet<ScientLatexBuildState> = new Set([
  "queued",
  "running",
  "publishing",
]);

/**
 * What a build says about a package it cannot install itself. A TeX Live or
 * MiKTeX installation is the user's own, so Scient names the package and the
 * command that places it rather than reaching into an installation it does not
 * own. The engine's own error stays alongside this.
 */
function missingPackageDiagnostic(packageName: string): ScientLatexDiagnostic {
  return {
    severity: "error",
    file: null,
    line: null,
    message: `Missing LaTeX package '${packageName}'. Install it with your TeX distribution (tlmgr install ${packageName}, or the MiKTeX Console), then rebuild.`,
  };
}

/**
 * Keep the engine's missing-package error beside repository failure because it identifies the
 * source location. Offline, frozen-repository drift, and author-private files need distinct honest
 * fetch outcomes.
 */
function unresolvedPackageDiagnostic(packageName: string): ScientLatexDiagnostic {
  return {
    severity: "error",
    file: null,
    line: null,
    message: `Scient tried to install '${packageName}' automatically and could not. If this is your own file, check its path; otherwise retry when online.`,
  };
}

/**
 * Every terminal failure needs actionable diagnostics. latexmk can emit only prose when declining a
 * failed target, so empty parse output must retain that explanation rather than fall back to a bare
 * Build failed.
 */
function withFailureReason(
  diagnostics: ReadonlyArray<ScientLatexDiagnostic>,
  reason: string | (() => ScientLatexDiagnostic),
): ReadonlyArray<ScientLatexDiagnostic> {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return diagnostics;
  return [
    ...diagnostics,
    typeof reason === "string"
      ? { severity: "error" as const, file: null, line: null, message: reason }
      : reason(),
  ];
}

interface LatexBuildEntry {
  readonly visualSourceRevisions?: Readonly<Record<string, string>>;
  readonly logicalDocumentKey: string;
  /**
   * Which build this entry belongs to. `requestBuild` stamps a fresh number
   * every time it replaces the entry, so a fiber that wakes up after its own
   * build was cancelled and rebuilt can tell that it no longer speaks here.
   */
  readonly generation: number;
  /** Sequential compile/publication pass within one coalesced build generation. */
  readonly passId: number;
  /** Absolute, resolved workspace root; every path a client sees is relative to it. */
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  /** The settled source-selection epoch of this exact queued intent; never rebased at execution. */
  readonly mutationEpoch: string;
  readonly pendingMutationEpoch: string | null;
  readonly state: ScientLatexBuildState;
  readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  readonly descriptor: PdfSourceDescriptor | null;
  readonly failureSummary: string | null;
  readonly startedAtEpochMs: number | null;
  readonly finishedAtEpochMs: number | null;
  readonly pendingRerun: boolean;
  readonly cancelRequested: boolean;
  /** Non-null only while this build is fetching packages the compile asked for. */
  readonly installingPackages: ReadonlyArray<string> | null;
  /** Live only while a build owns the binding; cleared on every terminal state. */
  readonly production: GeneratedDocumentProductionHandle | null;
  readonly handle: ExecutionProcessHandle | null;
}

type CancellationClaim =
  | { readonly claimed: false; readonly entry: LatexBuildEntry | null }
  | { readonly claimed: true; readonly entry: LatexBuildEntry };

/**
 * One document's build-input evidence as this process holds it, plus the stat
 * memory that keeps re-checking it cheap. `evidence: null` is a real answer —
 * "this document has none on disk" — cached so a poll does not re-read a file
 * that is not there.
 */
interface LatexEvidenceCacheEntry {
  readonly compiledBibliography?: string | undefined;
  readonly mutationEpoch?: string | undefined;
  readonly sourceRevisions?: Readonly<Record<string, string>> | undefined;
  /** Exact immutable PDF revision this evidence is allowed to vouch for. */
  readonly revision: {
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
  } | null;
  readonly evidence: LatexBuildEvidence | null;
  readonly marks: LatexEvidenceMarks;
  /** Paths whose readable-after-unverified transition already caused one rebuild. */
  readonly reverifiedUnverifiedPaths: ReadonlySet<string>;
}

interface ResolvedLatexTarget {
  readonly logicalDocumentKey: string;
  readonly workspaceRoot: string;
  readonly rootRelativePath: string;
  /** Non-null when the requested source could not be read; no build is possible. */
  readonly failureSummary: string | null;
}

interface LatexPreambleHeads {
  readonly rootText: string;
  readonly includedTexts: ReadonlyArray<string>;
}

/**
 * The transcript is bounded but the interesting part is at the end: the final
 * error, the rerun decision, and `Output written on …` all arrive last. The
 * state therefore keeps a short head (the engine banner) plus the newest bytes
 * that fit, and drops the middle.
 */
interface TranscriptState {
  readonly head: string;
  readonly headBytes: number;
  /** Oldest first; whole chunks fall off the front as newer ones arrive. */
  readonly tail: ReadonlyArray<TranscriptChunk>;
  readonly tailBytes: number;
  readonly dropped: boolean;
}

interface TranscriptChunk {
  readonly text: string;
  readonly bytes: number;
}

export const emptyTranscript: TranscriptState = {
  head: "",
  headBytes: 0,
  tail: [],
  tailBytes: 0,
  dropped: false,
};

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/** Stable across separator and trailing-slash differences so one document keeps one key. */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const posix = toPosixPath(workspaceRoot);
  return posix.length > 1 ? posix.replace(/\/+$/u, "") : posix;
}

/** Stable server-private workspace identity that does not expose the host path. */
function workspaceIdentityDigest(workspaceRoot: string): string {
  return NodeCrypto.createHash("sha256")
    .update(normalizeWorkspaceRoot(workspaceRoot))
    .digest("hex");
}

/** `/etc/passwd`, `C:/other/x.tex` — what `path.relative` returns when it cannot stay relative. */
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:)/u;

/**
 * Reject absolute results as well as parent walks: path.relative returns absolute across Windows
 * drives, including drive-relative requests. Normalized slashes alone do not prove containment.
 */
export function escapesWorkspaceRoot(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    ABSOLUTE_PATH_PATTERN.test(relativePath)
  );
}

function workDirectoryName(logicalDocumentKey: string): string {
  return NodeCrypto.createHash("sha256").update(logicalDocumentKey).digest("hex").slice(0, 16);
}

function documentTitle(rootRelativePath: string): string {
  const baseName = rootRelativePath.split("/").at(-1) ?? rootRelativePath;
  return baseName.replace(/\.\w+$/u, "") || baseName;
}

/** Splits on a codepoint boundary at or before `maxBytes` so neither side gains a replacement character. */
function splitAtBytes(text: string, maxBytes: number): readonly [string, string] {
  if (maxBytes <= 0) return ["", text];
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return [text, ""];
  let cut = maxBytes;
  while (cut > 0 && ((buffer[cut] ?? 0) & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return [buffer.toString("utf8", 0, cut), buffer.toString("utf8", cut)];
}

const TRANSCRIPT_TAIL_BYTES = MAX_TRANSCRIPT_BYTES - TRANSCRIPT_HEAD_BYTES;
const TRANSCRIPT_TRUNCATION_MARKER = "\n[transcript truncated]\n";

export function appendBoundedTranscript(state: TranscriptState, text: string): TranscriptState {
  const [headPart, overflow] = splitAtBytes(text, TRANSCRIPT_HEAD_BYTES - state.headBytes);
  const head = state.head + headPart;
  const headBytes = state.headBytes + Buffer.byteLength(headPart);
  if (overflow.length === 0) return { ...state, head, headBytes };

  const tail = [...state.tail, { text: overflow, bytes: Buffer.byteLength(overflow) }];
  let tailBytes = state.tailBytes + Buffer.byteLength(overflow);
  let dropped = state.dropped;
  while (tailBytes > TRANSCRIPT_TAIL_BYTES && tail.length > 0) {
    const oldest = tail[0];
    if (oldest === undefined) break;
    dropped = true;
    const excess = tailBytes - TRANSCRIPT_TAIL_BYTES;
    if (oldest.bytes <= excess) {
      tail.shift();
      tailBytes -= oldest.bytes;
      continue;
    }
    const [discarded, kept] = splitAtBytes(oldest.text, excess);
    const discardedBytes = Buffer.byteLength(discarded);
    // Snapping to a codepoint boundary can leave the last few bytes in place;
    // stop rather than spin, a handful of bytes over a four-megabyte budget.
    if (discardedBytes === 0) break;
    tail[0] = { text: kept, bytes: oldest.bytes - discardedBytes };
    tailBytes -= discardedBytes;
  }
  return { head, headBytes, tail, tailBytes, dropped };
}

/** Head, a marker where the middle was dropped, then the newest output. */
export function renderTranscript(state: TranscriptState): string {
  const tail = state.tail.map((chunk) => chunk.text).join("");
  return state.dropped ? `${state.head}${TRANSCRIPT_TRUNCATION_MARKER}${tail}` : state.head + tail;
}

export const make = Effect.gen(function* () {
  const observeOperation = yield* makeOperationAnalytics;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const acquireProcessRetirementMarker = yield* makeLatexProcessRetirementMarkers;
  const config = yield* ServerConfig.ServerConfig;
  const texDirectory = yield* latexTexDirectory;
  const store = yield* GeneratedDocumentStore;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const toolchainProbe = yield* LatexToolchain;
  const syncTex = yield* LatexSyncTex;
  const packageInstaller = yield* LatexPackageInstaller;
  const processes = yield* LocalExecutionProcess.ExecutionProcess;
  const hostEnvironment = yield* HostProcess.Environment;
  const windows = (yield* HostProcess.Platform) === "win32";
  const pathDelimiter = windows ? ";" : ":";
  const entriesRef = yield* Ref.make(new Map<string, LatexBuildEntry>());
  const evidenceRef = yield* Ref.make(new Map<string, LatexEvidenceCacheEntry>());
  const evidencePersistence = yield* Semaphore.make(1);
  // Monotonic across the process; only `requestBuild` hands one out.
  const generationRef = yield* Ref.make(0);
  // Build fibers outlive the request that started them, so they are supervised
  // by the service instead of a request scope.
  const buildScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(buildScope, Exit.void));
  // Admission control for the compile itself. A fiber holds no permit while it
  // waits, which is what keeps the `queued` state honest.
  const admission = yield* Semaphore.make(MAX_CONCURRENT_COMPILES);
  const unretiredDirectories = new Set<string>();
  /** Reads only the head of a source file; never the whole of a large one. */
  const readSourceHead = (absolutePath: string, maxBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(absolutePath, { flag: "r" });
        const chunk = yield* file.readAlloc(maxBytes);
        return Option.isNone(chunk) ? "" : new TextDecoder().decode(chunk.value);
      }),
    );

  /**
   * A fragment without `% !TEX root` may still belong to one nearby document.
   * Search only the fragment's directory and its ancestors, and only inspect
   * bounded LaTeX heads. This catches the ordinary `main.tex` + `sections/`
   * layout without turning every status poll into a recursive workspace walk.
   */
  const discoverContainingLatexRoots = Effect.fnUntraced(function* (input: {
    readonly workspaceRoot: string;
    readonly requestedRelativePath: string;
  }) {
    const requested = input.requestedRelativePath.replaceAll("\\", "/");
    const roots: string[] = [];
    let candidates = 0;
    let directory = path.dirname(path.join(input.workspaceRoot, requested));
    let truncated = false;

    for (let depth = 0; depth < MAX_ROOT_DISCOVERY_ANCESTORS; depth += 1) {
      const names = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const name of names.toSorted()) {
        const absolutePath = path.join(directory, name);
        const relativePath = toPosixPath(path.relative(input.workspaceRoot, absolutePath));
        if (
          relativePath === requested ||
          escapesWorkspaceRoot(relativePath) ||
          !isLatexSourcePath(relativePath)
        )
          continue;
        candidates += 1;
        if (candidates > MAX_ROOT_DISCOVERY_CANDIDATES) {
          truncated = true;
          break;
        }
        const contents = yield* readSourceHead(absolutePath, PREAMBLE_SCAN_HEAD_BYTES).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (contents === null) continue;
        const resolution = resolveLatexRoot({ relativePath, contents });
        if (resolution.reason !== "documentclass") continue;
        const rootDirectory = path.dirname(absolutePath);
        const includesRequested = latexPreambleIncludes(contents).some((included) => {
          const includedRelative = toPosixPath(
            path.relative(input.workspaceRoot, path.resolve(rootDirectory, included)),
          );
          return includedRelative === requested;
        });
        if (includesRequested) roots.push(relativePath);
      }
      if (truncated || directory === input.workspaceRoot) break;
      const parent = path.dirname(directory);
      if (parent === directory || !path.isAbsolute(parent)) break;
      directory = parent;
    }

    return { roots: [...new Set(roots)].toSorted(), truncated };
  });

  /**
   * TeX paths are relative to the root document's compile directory, not the workspace. Rebase
   * before clients see them, and link only existing project entries; engine-package basenames
   * remain noninteractive labels.
   */
  const rebaseDiagnostics = (input: {
    readonly workspaceRoot: string;
    readonly compileDirectory: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }) =>
    Effect.forEach(input.diagnostics, (diagnostic) => {
      if (diagnostic.file === null) return Effect.succeed(diagnostic);
      const absolute = path.resolve(input.compileDirectory, diagnostic.file);
      const relative = toPosixPath(path.relative(input.workspaceRoot, absolute));
      if (escapesWorkspaceRoot(relative)) return Effect.succeed({ ...diagnostic, file: null });
      const unlinked = {
        ...diagnostic,
        file: null,
        message: `${diagnostic.file}${diagnostic.line === null ? "" : `:${diagnostic.line}`}: ${diagnostic.message}`,
      };
      return fileSystem.exists(absolute).pipe(
        Effect.map((exists) => (exists ? { ...diagnostic, file: relative } : unlinked)),
        Effect.orElseSucceed(() => unlinked),
      );
    });

  const getEntry = (key: string) =>
    Ref.get(entriesRef).pipe(Effect.map((entries) => entries.get(key) ?? null));

  const updateEntryWhen = (
    key: string,
    matches: (entry: LatexBuildEntry) => boolean,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) =>
    Ref.update(entriesRef, (entries) => {
      const current = entries.get(key);
      if (current === undefined || !matches(current)) return entries;
      const next = new Map(entries);
      next.set(key, update(current));
      return next;
    });

  /**
   * Write only while the fiber still owns this entry. A cancelled package fetch can wake after
   * replacement and otherwise overwrite a fresh build's state/process handle.
   */
  const updateOwnEntry = (
    key: string,
    generation: number,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) => updateEntryWhen(key, (entry) => entry.generation === generation, update);

  /**
   * A pass-scoped update cannot let a completed pass speak for the coalesced
   * successor that reused its generation.
   */
  const updateOwnPassEntry = (
    key: string,
    generation: number,
    passId: number,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) =>
    Ref.modify(entriesRef, (entries) => {
      const current = entries.get(key);
      if (current === undefined || current.generation !== generation || current.passId !== passId) {
        return [false, entries] as const;
      }
      const next = new Map(entries);
      next.set(key, update(current));
      return [true, next] as const;
    });

  /** True once this build may no longer speak for the entry: cancelled, or replaced. */
  const isSuperseded = (key: string, generation: number) =>
    getEntry(key).pipe(
      Effect.map(
        (entry) => entry === null || entry.generation !== generation || entry.cancelRequested,
      ),
    );

  const inspectLiveDescriptor = (key: string) =>
    store.getDescriptor(LogicalDocumentKey.make(key)).pipe(
      Effect.map((descriptor) => ({ _tag: "read" as const, descriptor })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "read-failed" as const, detail: error.detail }),
      ),
    );

  /** Best-effort reads are appropriate only where absence already fails closed. */
  const readLiveDescriptor = (key: string) =>
    inspectLiveDescriptor(key).pipe(
      Effect.map((result) => (result._tag === "read" ? result.descriptor : null)),
    );

  /**
   * A descriptor captured from `publishPdf` is current only while the binding
   * still names that exact immutable revision *and* generation. Comparing the
   * generation matters while a newer producer is building over the same PDF:
   * the active revision has not changed yet, but ownership already has.
   */
  const isExactLiveDescriptor = (
    expected: PdfSourceDescriptor | null,
    live: PdfSourceDescriptor | null,
  ): boolean =>
    expected?._tag === "generated-pdf" &&
    expected.bindingStatus === "current" &&
    live?._tag === "generated-pdf" &&
    live.bindingStatus === "current" &&
    live.authority === expected.authority &&
    live.logicalDocumentKey === expected.logicalDocumentKey &&
    live.artifactId === expected.artifactId &&
    live.revisionId === expected.revisionId &&
    live.bindingGeneration === expected.bindingGeneration;

  const snapshotOf = (
    entry: LatexBuildEntry,
    toolchain: ScientLatexToolchainStatus,
  ): ScientLatexBuildSnapshot => ({
    logicalDocumentKey: entry.logicalDocumentKey,
    rootRelativePath: entry.rootRelativePath,
    state: entry.state,
    diagnostics: entry.diagnostics,
    descriptor: entry.descriptor,
    failureSummary: entry.failureSummary,
    startedAtEpochMs: entry.startedAtEpochMs,
    finishedAtEpochMs: entry.finishedAtEpochMs,
    toolchain,
    pendingRerun: entry.pendingRerun,
    ...(entry.state === "succeeded" &&
    !entry.pendingRerun &&
    entry.visualSourceRevisions !== undefined
      ? { visualSourceRevisions: entry.visualSourceRevisions }
      : {}),
    // Absent unless a fetch is running, so an ordinary poll carries nothing new.
    ...(entry.installingPackages === null ? {} : { installingPackages: entry.installingPackages }),
  });

  const withToolchain = (entry: LatexBuildEntry) =>
    toolchainProbe
      .probe(false)
      .pipe(
        Effect.flatMap((toolchain) => restoreCompiledBibliography(snapshotOf(entry, toolchain))),
      );

  const readEntrySnapshot = (key: string) =>
    getEntry(key).pipe(
      Effect.flatMap((entry) =>
        entry === null ? Effect.die(`latex build entry disappeared: ${key}`) : withToolchain(entry),
      ),
    );

  /** Terminal transition; always clears the process handle and binding handle. */
  const finishBuild = Effect.fn("LatexBuildService.finishBuild")(function* (
    key: string,
    generation: number,
    update: (entry: LatexBuildEntry) => LatexBuildEntry,
  ) {
    const finishedAtEpochMs = yield* Clock.currentTimeMillis;
    yield* updateOwnEntry(key, generation, (entry) => ({
      ...update(entry),
      finishedAtEpochMs,
      production: null,
      handle: null,
      installingPackages: null,
    }));
    const entry = yield* getEntry(key);
    if (
      entry?.generation === generation &&
      entry.startedAtEpochMs !== null &&
      entry.finishedAtEpochMs === finishedAtEpochMs
    ) {
      const status =
        entry.state === "succeeded"
          ? "completed"
          : entry.state === "cancelled"
            ? "cancelled"
            : entry.state === "failed"
              ? "failed"
              : null;
      if (status !== null)
        yield* observeOperation({
          key: `${generation}:${entry.startedAtEpochMs}`,
          operationKind: "latex-build",
          status,
          startedAt: entry.startedAtEpochMs,
          finishedAt: finishedAtEpochMs,
        });
    }
  });

  const recordStoreFailure = (production: GeneratedDocumentProductionHandle, reason: string) =>
    store.failProduction({ ...production, reason }).pipe(
      Effect.asVoid,
      // `superseded` means a newer build already owns the binding, which is the
      // expected outcome of a rebuild racing its predecessor.
      Effect.catch((error) =>
        error.reason === "superseded"
          ? Effect.void
          : Effect.logWarning("latex build failure could not be recorded", { error }),
      ),
    );

  /**
   * Cancel, supersession, and infrastructure failure do not discredit source freshness. Abandon
   * rather than fail production so a valid published PDF is not staled; the store operation must
   * remain idempotent.
   */
  const recordStoreAbandon = (production: GeneratedDocumentProductionHandle, reason: string) =>
    store.abandonProduction({ ...production, reason }).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("latex build production could not be released", { error }),
      ),
    );

  /**
   * Publication and cancellation linearize at the document-store binding.
   * Once this exact production has committed a revision, an abandon is an
   * idempotent no-op and cancellation arrived too late to truthfully call the
   * build cancelled. A different attempt in the binding means this build lost.
   */
  const productionHasPublished = (
    binding: DocumentArtifactBinding,
    production: GeneratedDocumentProductionHandle,
  ) =>
    binding.generation === production.generation &&
    binding.latestAttempt.generation === production.generation &&
    binding.latestAttempt.operationId === production.operationId &&
    binding.latestAttempt.producerId === production.producerId &&
    binding.latestAttempt.state === "succeeded";

  const recordFailure = Effect.fn("LatexBuildService.recordFailure")(function* (input: {
    readonly key: string;
    readonly generation: number;
    readonly production: GeneratedDocumentProductionHandle;
    readonly summary: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
  }) {
    yield* recordStoreFailure(input.production, input.summary);
    // Re-read the binding so the snapshot carries the stale status the store
    // just recorded instead of the status the descriptor had while current.
    const descriptor = yield* store
      .getDescriptor(LogicalDocumentKey.make(input.key))
      .pipe(Effect.orElseSucceed(() => null));
    // Last line of defence for the invariant: whatever else a caller passed,
    // the summary itself is a reason and belongs in the list.
    const diagnostics = withFailureReason(input.diagnostics, input.summary);
    yield* finishBuild(input.key, input.generation, (entry) => ({
      ...entry,
      state: "failed",
      failureSummary: input.summary,
      diagnostics,
      descriptor: descriptor ?? entry.descriptor,
    }));
  });

  const runProcess = (input: {
    readonly key: string;
    readonly generation: number;
    readonly workDirectory: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runId = ExecutionRunId.make(NodeCrypto.randomUUID());
        const quarantine = Effect.sync(() => unretiredDirectories.add(input.workDirectory));
        const { handle } = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const settleRetirement = yield* acquireProcessRetirementMarker(
              path.join(input.workDirectory, ".unretired"),
              runId,
            );
            const handle = yield* processes
              .start({
                runId,
                executable: input.command,
                args: input.args,
                cwd: input.cwd,
                environment: input.environment,
              })
              .pipe(Effect.onError(() => quarantine));
            return { handle, settleRetirement };
          }),
          ({ handle, settleRetirement }) =>
            handle.cancel.pipe(
              Effect.andThen(handle.exitCode),
              Effect.andThen(settleRetirement),
              Effect.onError(() => quarantine),
              Effect.orDie,
            ),
        );
        yield* updateOwnEntry(input.key, input.generation, (entry) => ({ ...entry, handle }));
        // A cancel that raced the spawn still has to reach this process tree.
        if (yield* isSuperseded(input.key, input.generation)) {
          yield* handle.cancel;
        }
        const transcriptRef = yield* Ref.make<TranscriptState>(emptyTranscript);
        const outputFiber = yield* handle.output.pipe(
          Stream.runForEach((chunk) =>
            Ref.update(transcriptRef, (state) => appendBoundedTranscript(state, chunk.text)),
          ),
          Effect.catchCause((cause) =>
            Effect.logDebug("latex build output stream ended early", { cause }),
          ),
          Effect.forkScoped,
        );
        const exitCode = yield* handle.exitCode.pipe(Effect.timeoutOption(BUILD_TIMEOUT));
        // Cancellation and exit observation finish before this attempt can publish.
        if (Option.isNone(exitCode)) yield* handle.cancel;
        yield* Fiber.join(outputFiber).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.ignoreCause(),
        );
        const transcript = yield* Ref.get(transcriptRef);
        return {
          exitCode: Option.isNone(exitCode) ? null : exitCode.value,
          transcript: renderTranscript(transcript),
        };
      }),
    );

  const publish = Effect.fn("LatexBuildService.publish")(function* (input: {
    readonly key: string;
    readonly generation: number;
    readonly production: GeneratedDocumentProductionHandle;
    readonly pdfPath: string;
    readonly syncTexPath: string;
    readonly workspaceRoot: string;
    readonly rootRelativePath: string;
    readonly compileDirectory: string;
    readonly managedToolchain: boolean;
    readonly title: string;
    readonly diagnostics: ReadonlyArray<ScientLatexDiagnostic>;
    readonly evidence: LatexBuildEvidence;
    readonly visualSourceRevisions: Readonly<Record<string, string>>;
    readonly mutationEpoch: string;
  }) {
    const bytes = yield* fileSystem.readFile(input.pdfPath);
    // Keep generated presentation with the PDF revision, not beside editable project files.
    const compiledBibliography = yield* Effect.gen(function* () {
      const bibliographyPath = input.pdfPath.replace(/\.pdf$/iu, ".bbl");
      const info = yield* fileSystem.stat(bibliographyPath);
      if (info.size > 1_000_000n) return undefined;
      const source = yield* fileSystem.readFileString(bibliographyPath);
      return source.length <= 1_000_000 ? source : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    const failDescriptorVerification = (detail: string, descriptor: PdfSourceDescriptor) =>
      Effect.logWarning("published latex PDF binding could not be verified", {
        logicalDocumentKey: input.key,
        detail,
      }).pipe(
        Effect.andThen(
          finishBuild(input.key, input.generation, (entry) => ({
            ...entry,
            state: "failed",
            descriptor,
            failureSummary: PUBLISHED_PDF_VERIFICATION_SUMMARY,
            diagnostics: withFailureReason(input.diagnostics, PUBLISHED_PDF_VERIFICATION_SUMMARY),
          })),
        ),
      );
    yield* updateOwnEntry(input.key, input.generation, (entry) => ({
      ...entry,
      state: "publishing",
    }));
    yield* workspaceFiles
      .withWorkspacePublicationFence(
        { cwd: input.workspaceRoot, expectedEpoch: input.mutationEpoch },
        () =>
          store.publishPdf({
            ...input.production,
            bytes,
            title: input.title,
            provenanceKind: "document-build",
          }),
      )
      .pipe(
        Effect.flatMap((descriptor) =>
          Effect.gen(function* () {
            if (descriptor._tag !== "generated-pdf") {
              return yield* Effect.die("LaTeX publication returned a non-generated PDF");
            }
            // The index is auxiliary: persist it before the terminal build
            // state becomes visible, but never discredit an otherwise valid
            // PDF if navigation data was absent or could not be retained.
            yield* syncTex
              .publishIndex({
                artifactId: descriptor.artifactId,
                revisionId: descriptor.revisionId,
                workspaceRoot: input.workspaceRoot,
                rootRelativePath: input.rootRelativePath,
                compileDirectory: input.compileDirectory,
                syncTexPath: input.syncTexPath,
                evidenceFileName: `${workDirectoryName(input.key)}.json`,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("latex synctex index could not be persisted", {
                    logicalDocumentKey: input.key,
                    cause,
                  }),
                ),
              );
            let liveDescriptorRead = yield* inspectLiveDescriptor(input.key);
            if (liveDescriptorRead._tag === "read-failed") {
              yield* failDescriptorVerification(liveDescriptorRead.detail, descriptor);
              return;
            }
            let liveDescriptor = liveDescriptorRead.descriptor;
            if (!isExactLiveDescriptor(descriptor, liveDescriptor)) {
              yield* finishBuild(input.key, input.generation, (entry) => ({
                ...entry,
                state: "cancelled",
                descriptor: liveDescriptor ?? entry.descriptor,
                diagnostics: input.diagnostics,
                failureSummary: null,
              }));
              return;
            }
            // The source evidence becomes durable against the exact revision
            // before `succeeded` can be observed. If this best-effort cache
            // write fails, its in-memory identity remains exact and a restart
            // rejects any older evidence file whose revision does not match.
            yield* persistBuildEvidence({
              key: input.key,
              artifactId: descriptor.artifactId,
              revisionId: descriptor.revisionId,
              evidence: input.evidence,
              mutationEpoch: input.mutationEpoch,
              sourceRevisions: input.visualSourceRevisions,
              compiledBibliography,
            });
            // Evidence persistence is outside the document-store lock. A
            // producer may have claimed the binding while it ran, so verify
            // ownership again before exposing the terminal success state.
            liveDescriptorRead = yield* inspectLiveDescriptor(input.key);
            if (liveDescriptorRead._tag === "read-failed") {
              yield* failDescriptorVerification(liveDescriptorRead.detail, descriptor);
              return;
            }
            liveDescriptor = liveDescriptorRead.descriptor;
            if (!isExactLiveDescriptor(descriptor, liveDescriptor)) {
              yield* finishBuild(input.key, input.generation, (entry) => ({
                ...entry,
                state: "cancelled",
                descriptor: liveDescriptor ?? entry.descriptor,
                diagnostics: input.diagnostics,
                failureSummary: null,
              }));
              return;
            }
            yield* finishBuild(input.key, input.generation, (entry) => ({
              ...entry,
              state: "succeeded",
              cancelRequested: false,
              visualSourceRevisions: input.visualSourceRevisions,
              descriptor,
              // Warnings survive a successful build; they are the point of the log.
              diagnostics: input.diagnostics,
              failureSummary: null,
            }));
          }),
        ),
        Effect.catch((error) => {
          if (error._tag !== "GeneratedDocumentStoreError") {
            return recordFailure({
              key: input.key,
              generation: input.generation,
              production: input.production,
              summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
              diagnostics: input.diagnostics,
            });
          }
          if (error.reason === "superseded") {
            // A newer build owns the binding. Report cancelled and leave the
            // store untouched so the winner's own outcome stands.
            return finishBuild(input.key, input.generation, (entry) => ({
              ...entry,
              state: "cancelled",
              diagnostics: input.diagnostics,
            }));
          }
          if (error.reason === "validation-rejected") {
            // The store already recorded this failure while rejecting the PDF.
            return finishBuild(input.key, input.generation, (entry) => ({
              ...entry,
              state: "failed",
              failureSummary: error.detail,
              diagnostics: withFailureReason(input.diagnostics, error.detail),
            }));
          }
          return recordFailure({
            key: input.key,
            generation: input.generation,
            production: input.production,
            summary: error.detail,
            diagnostics: input.diagnostics,
          });
        }),
      );
  });

  /**
   * Fetches what the last compile said it was missing, with the snapshot saying
   * so while it runs. The state stays `running`, so a client polls exactly as
   * it already does. Answers whether anything new landed, which is the only
   * reason to compile again.
   */
  const installMissingPackages = Effect.fn("LatexBuildService.installMissingPackages")(
    function* (input: {
      readonly key: string;
      readonly generation: number;
      readonly workspaceRoot: string;
      readonly mutationEpoch: string;
      readonly production: GeneratedDocumentProductionHandle;
      readonly packages: ReadonlyArray<string>;
      /** What each package was fetched for; the installer holds the fetch to these. */
      readonly files: ReadonlyArray<string>;
      readonly binDirectory: string;
    }) {
      const sourceStillAdmitted = Effect.gen(function* () {
        if (yield* isSuperseded(input.key, input.generation)) return false;
        if (
          (yield* workspaceFiles.getMutationEpoch({ cwd: input.workspaceRoot })) ===
          input.mutationEpoch
        )
          return true;
        yield* recordFailure({
          key: input.key,
          generation: input.generation,
          production: input.production,
          summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
          diagnostics: [],
        });
        return false;
      });
      yield* updateOwnEntry(input.key, input.generation, (entry) => ({
        ...entry,
        installingPackages: input.packages,
      }));
      if (!(yield* sourceStillAdmitted)) {
        yield* updateOwnEntry(input.key, input.generation, (entry) => ({
          ...entry,
          installingPackages: null,
        }));
        return null;
      }
      const outcome = yield* packageInstaller.install({
        packages: input.packages,
        binDirectory: input.binDirectory,
        expectedFiles: input.files,
      });
      yield* updateOwnEntry(input.key, input.generation, (entry) => ({
        ...entry,
        installingPackages: null,
      }));
      if (!(yield* sourceStillAdmitted)) return null;
      if (outcome.failed.length > 0) {
        yield* Effect.logDebug("latex packages could not be installed", {
          logicalDocumentKey: input.key,
          packages: outcome.failed,
        });
      }
      return outcome.installed.length > 0;
    },
  );

  /**
   * LaTeX reveals one missing input per compile. Scan root/one-level preambles and batch absent
   * package names before compiling; retain the reactive loop for transitive package dependencies.
   */
  const readPreambleHeads = Effect.fn("LatexBuildService.readPreambleHeads")(function* (
    rootAbsolutePath: string,
  ) {
    const rootText = yield* readSourceHead(rootAbsolutePath, PREAMBLE_SCAN_HEAD_BYTES).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (rootText === null) return null;
    const includedTexts: string[] = [];
    const rootDirectory = path.dirname(rootAbsolutePath);
    for (const include of latexPreambleIncludes(rootText)) {
      const includedText = yield* readSourceHead(
        path.resolve(rootDirectory, include),
        INCLUDED_PREAMBLE_SCAN_HEAD_BYTES,
      ).pipe(Effect.orElseSucceed(() => null));
      if (includedText !== null) includedTexts.push(includedText);
    }
    return { rootText, includedTexts } satisfies LatexPreambleHeads;
  });

  const preamblePackagesToFetch = Effect.fn("LatexBuildService.preamblePackagesToFetch")(
    function* (input: { readonly preamble: LatexPreambleHeads; readonly binDirectory: string }) {
      const names = [
        ...latexPreamblePackages(input.preamble.rootText),
        ...input.preamble.includedTexts.flatMap((text) => latexPreamblePackages(text)),
      ];
      // Nine files' worth of preambles is more names than any real document
      // has; the cap is what stops a generated one becoming a giant argv.
      const requested = [...new Set(names)].slice(0, MAX_PREAMBLE_PACKAGES_PER_BUILD);
      const unresolved = new Set(
        (yield* packageInstaller.unresolvedFiles({
          files: requested.map((name) => `${name}.sty`),
          binDirectory: input.binDirectory,
        })).map((fileName) => fileName.toLowerCase()),
      );
      return requested.filter((name) => unresolved.has(`${name.toLowerCase()}.sty`));
    },
  );

  /**
   * The evidence modules ask for the platform services by name so their own
   * tests can drive them directly; the service already holds both, and its
   * public methods declare no requirements, so they are handed over here.
   */
  const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Beside the build work directory, keyed the same way, one file per document. */
  const evidenceFilePath = (key: string) =>
    path.join(config.latexDir, "evidence", `${workDirectoryName(key)}.json`);

  const loadEvidence = Effect.fn("LatexBuildService.loadEvidence")(function* (key: string) {
    const cached = yield* Ref.get(evidenceRef).pipe(Effect.map((all) => all.get(key)));
    if (cached !== undefined) return cached;
    const source = yield* fileSystem
      .readFileString(evidenceFilePath(key))
      .pipe(Effect.orElseSucceed(() => null));
    const published = source === null ? null : decodePublishedLatexBuildEvidence(source);
    const entry: LatexEvidenceCacheEntry = {
      revision:
        published === null
          ? null
          : { artifactId: published.artifactId, revisionId: published.revisionId },
      evidence: published?.evidence ?? null,
      compiledBibliography: published?.compiledBibliography,
      mutationEpoch: published?.mutationEpoch,
      sourceRevisions: published?.sourceRevisions,
      marks: EMPTY_EVIDENCE_MARKS,
      reverifiedUnverifiedPaths: new Set(),
    };
    return yield* Ref.modify(evidenceRef, (all) => {
      const current = all.get(key);
      return current === undefined
        ? ([entry, new Map(all).set(key, entry)] as const)
        : ([current, all] as const);
    });
  });

  const restoreCompiledBibliography = Effect.fn("LatexBuildService.restoreCompiledBibliography")(
    function* (snapshot: ScientLatexBuildSnapshot) {
      const descriptor = snapshot.descriptor;
      if (
        snapshot.state !== "succeeded" ||
        snapshot.pendingRerun ||
        descriptor?._tag !== "generated-pdf" ||
        descriptor.bindingStatus !== "current"
      )
        return snapshot;
      const cached = yield* loadEvidence(snapshot.logicalDocumentKey);
      if (
        cached.revision?.artifactId !== descriptor.artifactId ||
        cached.revision.revisionId !== descriptor.revisionId ||
        cached.compiledBibliography === undefined
      )
        return snapshot;
      return { ...snapshot, compiledBibliography: cached.compiledBibliography };
    },
  );

  /**
   * Without a recorder, root plus one-level inputs is explicitly narrower evidence: it omits
   * bibliographies, images, and package-loaded files. Do not present it as a full dependency
   * manifest.
   */
  const preambleDependencies = Effect.fn("LatexBuildService.preambleDependencies")(
    function* (input: {
      readonly workspaceRoot: string;
      readonly rootRelativePath: string;
      readonly rootAbsolutePath: string;
    }) {
      const head = yield* readSourceHead(input.rootAbsolutePath, PREAMBLE_SCAN_HEAD_BYTES).pipe(
        Effect.orElseSucceed(() => ""),
      );
      const rootDirectory = path.dirname(input.rootAbsolutePath);
      const dependencies: string[] = [];
      for (const include of latexPreambleIncludes(head)) {
        const relative = toPosixPath(
          path.relative(input.workspaceRoot, path.resolve(rootDirectory, include)),
        );
        if (!escapesWorkspaceRoot(relative)) dependencies.push(relative);
      }
      return dependencies;
    },
  );

  /**
   * Collect inputs immediately after engine exit, before publishing succeeded state. Polling
   * succeeded without evidence would trigger another rebuild on every build, so artifact-store
   * round trips must not precede collection.
   */
  const collectBuildEvidence = Effect.fn("LatexBuildService.collectBuildEvidence")(
    function* (input: {
      readonly key: string;
      readonly workspaceRoot: string;
      readonly rootRelativePath: string;
      readonly rootAbsolutePath: string;
      readonly compileDirectory: string;
      readonly workDirectory: string;
      readonly dependencyManifest: {
        readonly path: string;
        readonly format: "fls" | "makefile";
      };
    }) {
      const parsedManifest = yield* fileSystem.readFileString(input.dependencyManifest.path).pipe(
        Effect.map((contents) =>
          input.dependencyManifest.format === "fls"
            ? parseLatexRecorderManifest({
                contents,
                workspaceRoot: input.workspaceRoot,
                compileDirectory: input.compileDirectory,
                workDirectory: input.workDirectory,
              })
            : parseTectonicMakefileRules({
                contents,
                workspaceRoot: input.workspaceRoot,
                compileDirectory: input.compileDirectory,
                workDirectory: input.workDirectory,
              }),
        ),
        Effect.orElseSucceed(() => null),
      );
      // A complete recorder must name the root that was compiled. Empty,
      // malformed, truncated, or root-less output cannot prove what this PDF
      // read, even if it happens to name another workspace file.
      const manifest =
        parsedManifest !== null &&
        !parsedManifest.truncated &&
        parsedManifest.dependencies.includes(input.rootRelativePath)
          ? parsedManifest
          : null;
      // Unusable recorder output leaves the preamble scan, which is useful for
      // freshness but explicitly incomplete for Visual authorization.
      const dependencies =
        manifest === null
          ? yield* preambleDependencies({
              workspaceRoot: input.workspaceRoot,
              rootRelativePath: input.rootRelativePath,
              rootAbsolutePath: input.rootAbsolutePath,
            })
          : manifest.dependencies;
      const nowEpochMs = yield* Clock.currentTimeMillis;
      const collected = yield* withPlatform(
        collectLatexBuildEvidence({
          workspaceRoot: input.workspaceRoot,
          rootRelativePath: input.rootRelativePath,
          dependencies,
          // The fallback scan is intentionally incomplete (no bibliography,
          // images, or package-discovered inputs), so it may keep ordinary
          // build-currentness evidence but can never authorize direct Visual
          // source writes.
          truncated: manifest?.truncated ?? true,
          nowEpochMs,
        }),
      );
      yield* Ref.update(evidenceRef, (all) => {
        const previous = all.get(input.key)?.reverifiedUnverifiedPaths ?? new Set<string>();
        const stillUnverified = new Set(
          collected.evidence.dependencies
            .filter(
              (dependency) =>
                dependency.sha256 === UNVERIFIED_FILE_DIGEST && previous.has(dependency.path),
            )
            .map((dependency) => dependency.path),
        );
        return new Map(all).set(input.key, {
          revision: null,
          evidence: collected.evidence,
          marks: collected.marks,
          reverifiedUnverifiedPaths: stillUnverified,
        });
      });
      return collected.evidence;
    },
  );

  /**
   * Puts the evidence where the next process start will find it, once the
   * publish it belongs to has actually stood. Best-effort: a state directory
   * that cannot be written costs a re-check after restart and nothing else,
   * because the in-memory copy is already in place.
   */
  const persistBuildEvidence = (input: {
    readonly key: string;
    readonly artifactId: ArtifactId;
    readonly revisionId: ArtifactRevisionId;
    readonly evidence: LatexBuildEvidence;
    readonly mutationEpoch: string;
    readonly compiledBibliography?: string | undefined;
    readonly sourceRevisions?: Readonly<Record<string, string>> | undefined;
    readonly expectedEvidence?: LatexEvidenceCacheEntry;
  }) =>
    evidencePersistence.withPermits(1)(
      Effect.gen(function* () {
        if (input.expectedEvidence !== undefined) {
          const current = (yield* Ref.get(evidenceRef)).get(input.key);
          if (
            current?.revision?.artifactId !== input.artifactId ||
            current.revision.revisionId !== input.revisionId ||
            current.evidence !== input.expectedEvidence.evidence ||
            current.mutationEpoch !== input.expectedEvidence.mutationEpoch
          )
            return false;
        }
        const published = {
          schemaVersion: 1 as const,
          artifactId: input.artifactId,
          revisionId: input.revisionId,
          evidence: input.evidence,
          mutationEpoch: input.mutationEpoch,
          compiledBibliography: input.compiledBibliography,
          ...(input.sourceRevisions === undefined
            ? {}
            : { sourceRevisions: input.sourceRevisions }),
        };
        const writeEvidence = writeFileStringAtomically({
          filePath: evidenceFilePath(input.key),
          contents: `${encodePublishedLatexBuildEvidence(published)}\n`,
          durable: true,
        }).pipe(
          withPlatform,
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logDebug("latex build evidence could not be persisted", {
              logicalDocumentKey: input.key,
              error,
            }).pipe(Effect.as(false)),
          ),
        );
        // Original builds retain verified memory evidence on cache I/O failure.
        // An output epoch rebind is acknowledged only after its exact durable write.
        if (input.expectedEvidence !== undefined && !(yield* writeEvidence)) return false;
        const accepted = yield* Ref.modify(evidenceRef, (all) => {
          const current = all.get(input.key);
          if (
            input.expectedEvidence !== undefined &&
            (current?.revision?.artifactId !== input.artifactId ||
              current.revision.revisionId !== input.revisionId ||
              current.evidence !== input.expectedEvidence.evidence ||
              current.mutationEpoch !== input.expectedEvidence.mutationEpoch)
          )
            return [false, all] as const;
          return [
            true,
            new Map(all).set(input.key, {
              revision: { artifactId: input.artifactId, revisionId: input.revisionId },
              evidence: input.evidence,
              compiledBibliography: input.compiledBibliography,
              sourceRevisions: input.sourceRevisions,
              mutationEpoch: input.mutationEpoch,
              marks: current?.marks ?? EMPTY_EVIDENCE_MARKS,
              reverifiedUnverifiedPaths: current?.reverifiedUnverifiedPaths ?? new Set<string>(),
            }),
          ] as const;
        });
        if (!accepted) return false;
        if (input.expectedEvidence === undefined) yield* writeEvidence;
        return true;
      }),
    );

  const acknowledgeOutputPublication = Effect.fn("LatexBuildService.acknowledgeOutputPublication")(
    function* (input: Parameters<LatexBuildService["Service"]["acknowledgeOutputPublication"]>[0]) {
      const cached = yield* loadEvidence(input.logicalDocumentKey);
      if (
        cached.evidence === null ||
        cached.mutationEpoch !== input.expectedMutationEpoch ||
        cached.revision?.artifactId !== input.artifactId ||
        cached.revision.revisionId !== input.revisionId
      )
        return false;
      const descriptor = yield* readLiveDescriptor(input.logicalDocumentKey);
      if (
        descriptor?._tag !== "generated-pdf" ||
        descriptor.bindingStatus !== "current" ||
        descriptor.artifactId !== input.artifactId ||
        descriptor.revisionId !== input.revisionId
      )
        return false;
      if (input.publicationEpoch === cached.mutationEpoch) return true;
      return yield* persistBuildEvidence({
        key: input.logicalDocumentKey,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        evidence: cached.evidence,
        mutationEpoch: input.publicationEpoch,
        compiledBibliography: cached.compiledBibliography,
        sourceRevisions: cached.sourceRevisions,
        expectedEvidence: cached,
      });
    },
  );

  /**
   * A surviving binding without input evidence cannot establish freshness. Rebuild once to replace
   * legacy/lost evidence, then judge currentness from recorded facts.
   */
  const evidenceIsCurrent = Effect.fn("LatexBuildService.evidenceIsCurrent")(function* (
    target: ResolvedLatexTarget,
    descriptor: PdfSourceDescriptor | null,
    mutationEpoch: string,
  ) {
    if (descriptor?._tag !== "generated-pdf" || descriptor.bindingStatus !== "current") {
      return false;
    }
    // An in-memory build entry can outlive its claim on the producer-neutral
    // binding. Never let its captured descriptor/evidence vouch for a
    // revision another producer has already superseded.
    if (!isExactLiveDescriptor(descriptor, yield* readLiveDescriptor(target.logicalDocumentKey))) {
      return false;
    }
    const cached = yield* loadEvidence(target.logicalDocumentKey);
    if (
      cached.evidence === null ||
      cached.mutationEpoch !== mutationEpoch ||
      cached.revision?.artifactId !== descriptor.artifactId ||
      cached.revision.revisionId !== descriptor.revisionId
    )
      return false;
    const probe = yield* withPlatform(
      probeLatexEvidence({
        workspaceRoot: target.workspaceRoot,
        evidence: cached.evidence,
        marks: cached.marks,
        reverifiedUnverifiedPaths: cached.reverifiedUnverifiedPaths,
      }),
    );
    yield* Ref.update(evidenceRef, (all) =>
      all.get(target.logicalDocumentKey) !== cached
        ? all
        : new Map(all).set(target.logicalDocumentKey, {
            ...cached,
            marks: probe.marks,
          }),
    );
    if (!probe.changed) return true;
    // Recollect full dependency identities before spending a compile on stat-probe disagreement. If
    // content matches, rebuilding cannot fix the shortcut and would repeat every status poll; bound
    // that disagreement instead.
    const recollected = yield* withPlatform(
      collectLatexBuildEvidence({
        workspaceRoot: target.workspaceRoot,
        rootRelativePath: cached.evidence.rootRelativePath,
        dependencies: cached.evidence.dependencies.map((dependency) => dependency.path),
        truncated: cached.evidence.truncated,
        nowEpochMs: cached.evidence.recordedAtEpochMs,
      }),
    );
    if (latexEvidenceMatches(recollected.evidence, cached.evidence)) {
      yield* Effect.logDebug("latex evidence probe disagreed with a full re-read", {
        logicalDocumentKey: target.logicalDocumentKey,
        changedPath: probe.changedPath,
      });
      // The freshly verified marks, so the next poll is cheap again rather
      // than re-entering this path.
      yield* Ref.update(evidenceRef, (all) =>
        all.get(target.logicalDocumentKey) !== cached
          ? all
          : new Map(all).set(target.logicalDocumentKey, {
              ...cached,
              marks: recollected.marks,
            }),
      );
      return true;
    }
    // A status read must not consume a requalification attempt: without an
    // actual rebuild the same stale evidence must remain stale on later polls.
    yield* Effect.logDebug("latex build inputs changed since the published PDF", {
      logicalDocumentKey: target.logicalDocumentKey,
      changedPath: probe.changedPath,
    });
    return false;
  });

  const compileAndPublish = (key: string, generation: number) => {
    let attemptDirectory: string | null = null;
    return Effect.gen(function* () {
      const entry = yield* getEntry(key);
      if (entry === null || entry.generation !== generation || entry.cancelRequested) return;
      yield* updateOwnEntry(key, generation, (current) => ({ ...current, state: "running" }));

      const defaultToolchain = yield* toolchainProbe.probe(false);
      if (defaultToolchain.kind === null || defaultToolchain.executable === null) {
        // Without an engine there is nothing to produce, so the binding stays
        // exactly as the last real build left it.
        yield* finishBuild(key, generation, (current) => ({
          ...current,
          state: "failed",
          failureSummary: noToolchainSummary(defaultToolchain),
          diagnostics: withFailureReason([], noToolchainSummary(defaultToolchain)),
        }));
        return;
      }
      if (yield* isSuperseded(key, generation)) return;

      const buildsDirectory = path.join(texDirectory, "builds");
      yield* fileSystem.makeDirectory(buildsDirectory, { recursive: true });
      // Never adopt a previous attempt's aux files, including after cancellation
      // or service restart. A late writer cannot supply a successor's output.
      const workDirectory = yield* fileSystem.makeTempDirectory({
        directory: buildsDirectory,
        prefix: `${workDirectoryName(key)}-`,
      });
      attemptDirectory = workDirectory;

      const production = yield* store.beginProduction({
        logicalDocumentKey: LogicalDocumentKey.make(key),
        operationId: ProducingOperationId.make(NodeCrypto.randomUUID()),
        producerId: LATEX_PRODUCER_ID,
      });
      yield* updateOwnEntry(key, generation, (current) => ({ ...current, production }));
      // Cancel can miss the handle between beginProduction and entry assignment. Abandon after
      // failed ownership installation too, closing that producing-state leak; duplicate abandonment
      // is safe.
      if (yield* isSuperseded(key, generation)) {
        yield* recordStoreAbandon(production, CANCELLED_SUMMARY);
        return;
      }

      const rootAbsolutePath = path.join(entry.workspaceRoot, entry.rootRelativePath);
      // Execute only the epoch admitted during source/root selection, including
      // time spent queued or coalesced behind another build.
      const mutationEpoch = entry.mutationEpoch;
      const admissionEpoch = yield* workspaceFiles
        .getMutationEpoch({ cwd: entry.workspaceRoot })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const summary =
                "Build admission blocked: workspace file operations are unavailable or require recovery.";
              yield* Effect.logWarning(summary, { error });
              yield* recordStoreAbandon(production, summary);
              yield* finishBuild(key, generation, (current) => ({
                ...current,
                state: "failed",
                failureSummary: summary,
                diagnostics: withFailureReason([], summary),
              }));
              return null;
            }),
          ),
        );
      if (admissionEpoch === null || (yield* isSuperseded(key, generation))) return;
      if (admissionEpoch !== mutationEpoch) {
        yield* recordFailure({
          key,
          generation,
          production,
          summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
          diagnostics: [],
        });
        return;
      }
      const preamble = yield* readPreambleHeads(rootAbsolutePath);
      const selection = selectLatexBuildEngine(preamble ?? { rootText: "" }, defaultToolchain.kind);
      const requiredCompiler = selection.driver ?? selection.engine;
      const toolchain = yield* toolchainProbe.probe(false, requiredCompiler);
      if (toolchain.kind === null || toolchain.executable === null) {
        yield* recordFailure({
          key,
          generation,
          production,
          summary:
            // A Tectonic that is installed but broken says why, ahead of
            // the advice to install it.
            selection.driver === "tectonic" && toolchain.unusable === undefined
              ? (selection.error ?? NO_TOOLCHAIN_SUMMARY)
              : noToolchainSummary(toolchain),
          diagnostics: [],
        });
        return;
      }
      const toolchainExecutable = toolchain.executable;
      const compiler = selectLatexBuildEngine(preamble ?? { rootText: "" }, toolchain.kind);
      if (compiler.error !== null) {
        yield* recordFailure({
          key,
          generation,
          production,
          summary: compiler.error,
          diagnostics: [
            {
              severity: "error",
              file: entry.rootRelativePath,
              line: null,
              message: compiler.error,
            },
          ],
        });
        return;
      }

      // Keep the original cwd even when a Windows Unicode root needs a private
      // ASCII entry point: relative inputs, assets and source navigation use it.
      const compileDirectory = path.dirname(rootAbsolutePath);
      const invocation = buildLatexInvocation({
        engine: compiler.engine,
        toolchain: {
          kind: toolchain.kind,
          executable: toolchainExecutable,
          version: toolchain.version ?? "unknown",
        },
        rootFileName: path.basename(rootAbsolutePath),
        workDirectory,
        windows,
        relativeWorkDirectory: path.relative(compileDirectory, workDirectory) || ".",
        forceReprocess: true,
      });

      if (invocation.inputWrapper !== undefined) {
        yield* fileSystem.writeFileString(
          invocation.inputWrapper.path,
          invocation.inputWrapper.contents,
        );
      }

      // Compile from the root document's folder because TeX resolves input against cwd. Extend only
      // Scient's own distribution, with tlmgr beside its engine; system distributions are not ours
      // to mutate.
      const managedBinDirectory =
        toolchain.source === "scient-managed" ? path.dirname(toolchainExecutable) : null;
      if (managedBinDirectory !== null && preamble === null) {
        yield* packageInstaller.unresolvedFiles({ binDirectory: managedBinDirectory, files: [] });
        if (yield* isSuperseded(key, generation)) return;
      }
      // Any driver found by absolute path leads its own engines, not only the
      // managed one: a TeX Live `latexmk` behind MiKTeX on PATH must not run
      // MiKTeX's `pdflatex`.
      const environment = latexEngineEnvironment({
        base: TEX_OUTPUT_ENVIRONMENT,
        hostEnvironment,
        binDirectory: latexDriverBinDirectory(toolchain, path),
        pathDelimiter,
      });
      // Every package this build has already asked for, so one no repository
      // has cannot send the same document round the loop again.
      const attempted = new Set<string>();
      let visualQualificationRetried = false;

      // One fetch for everything the document already says it wants, so the
      // reactive loop below only has to cover what a package pulls in.
      if (managedBinDirectory !== null && preamble !== null) {
        const upfront = yield* preamblePackagesToFetch({
          preamble,
          binDirectory: managedBinDirectory,
        });
        if (upfront.length > 0) {
          const placed = yield* installMissingPackages({
            key,
            generation,
            workspaceRoot: entry.workspaceRoot,
            mutationEpoch,
            production,
            packages: upfront,
            files: upfront.map((packageName) => `${packageName}.sty`),
            binDirectory: managedBinDirectory,
          });
          if (placed === null) return;
          if (yield* isSuperseded(key, generation)) return;
        }
      }

      for (let round = 0; ; round += 1) {
        // Include the previous recorder's dependencies and statically visible
        // inputs. Newly discovered inputs deliberately disable Visual until a
        // subsequent build has observed them on both sides of compilation.
        const previousEvidence = yield* loadEvidence(key);
        const declaredDependencies = yield* preambleDependencies({
          workspaceRoot: entry.workspaceRoot,
          rootRelativePath: entry.rootRelativePath,
          rootAbsolutePath,
        });
        const beforeCompile = yield* withPlatform(
          collectLatexBuildEvidence({
            workspaceRoot: entry.workspaceRoot,
            rootRelativePath: entry.rootRelativePath,
            dependencies: [
              ...declaredDependencies,
              ...(previousEvidence.evidence?.dependencies.map((item) => item.path) ?? []),
            ],
            truncated: previousEvidence.evidence?.truncated ?? false,
            nowEpochMs: yield* Clock.currentTimeMillis,
          }),
        );
        if (yield* isSuperseded(key, generation)) return;
        if (
          (yield* workspaceFiles.getMutationEpoch({ cwd: entry.workspaceRoot })) !== mutationEpoch
        ) {
          yield* recordFailure({
            key,
            generation,
            production,
            summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
            diagnostics: [],
          });
          return;
        }
        // Remove all run-owned outputs before spawn because the work directory survives builds. A
        // clean invocation that omits PDF/recorder/SyncTeX must not inherit the previous run's
        // file.
        for (const outputPath of [
          invocation.pdfPath,
          invocation.syncTexPath,
          invocation.syncTexPath.replace(/\.gz$/iu, ""),
          invocation.dependencyManifest.path,
        ]) {
          // `force` makes absence successful. Any remaining error is a lock,
          // permission, or storage failure; proceeding would let this run
          // inherit stale bytes, so it must fail before the engine starts.
          yield* fileSystem.remove(outputPath, { force: true });
        }

        const outcome = yield* runProcess({
          key,
          generation,
          workDirectory,
          command: invocation.command,
          args: invocation.args,
          cwd: compileDirectory,
          environment,
        });
        // A cancel that landed while the engine ran already wrote the terminal
        // state and told the store; do not overwrite it with the kill's exit code.
        if (yield* isSuperseded(key, generation)) return;

        const parsed = yield* rebaseDiagnostics({
          workspaceRoot: entry.workspaceRoot,
          compileDirectory,
          diagnostics: parseLatexLog(outcome.transcript),
        });
        if (outcome.exitCode === null) {
          yield* recordFailure({
            key,
            generation,
            production,
            summary: TIMEOUT_SUMMARY,
            diagnostics: withFailureReason(parsed, () =>
              transcriptFailureDiagnostic({ transcript: outcome.transcript, exitCode: null }),
            ),
          });
          return;
        }

        const producedBytes = yield* fileSystem.stat(invocation.pdfPath).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        // A clean exit with a PDF needs no package fetch despite incidental transcript mentions.
        // Other outcomes may need resolution even if pages exist, since missing packages can abort
        // defining commands.
        const missing =
          producedBytes > 0 && outcome.exitCode === 0
            ? []
            : missingLatexPackageInputs(outcome.transcript);
        const wanted =
          managedBinDirectory === null
            ? []
            : missing.filter((entryMissing) => !attempted.has(entryMissing.packageName));
        if (
          managedBinDirectory !== null &&
          wanted.length > 0 &&
          round < MAX_PACKAGE_RESOLUTION_ROUNDS
        ) {
          for (const entryMissing of wanted) attempted.add(entryMissing.packageName);
          const placed = yield* installMissingPackages({
            key,
            generation,
            workspaceRoot: entry.workspaceRoot,
            mutationEpoch,
            production,
            packages: wanted.map((entryMissing) => entryMissing.packageName),
            // The installer only reports these placed once the engine can find
            // the very files this compile stopped on, so a retry never runs
            // against a tree that has the bytes but not yet the index.
            files: wanted.map((entryMissing) => entryMissing.fileName),
            binDirectory: managedBinDirectory,
          });
          if (placed === null) return;
          // A cancel during the fetch already wrote the terminal state, and a
          // rebuild during it left this fiber with nothing to say.
          if (yield* isSuperseded(key, generation)) return;
          if (placed) continue;
        }
        // Reaching here with names still missing means resolution is over:
        // either Scient does not own this distribution, or it owns it and
        // could not place them. Both need saying, in the voice that fits.
        const diagnostics =
          missing.length === 0
            ? parsed
            : [
                ...parsed,
                ...missing.map((entryMissing) =>
                  managedBinDirectory === null
                    ? missingPackageDiagnostic(entryMissing.packageName)
                    : unresolvedPackageDiagnostic(entryMissing.packageName),
                ),
              ];

        // Error exits must never publish partial PDFs as Built. TeX may still produce pages with
        // missing sections/bibliography/references; retain the last clean PDF and mark it stale
        // with this failure reason.
        if (outcome.exitCode !== 0) {
          const failureDiagnostics = withFailureReason(diagnostics, () =>
            transcriptFailureDiagnostic({
              transcript: outcome.transcript,
              exitCode: outcome.exitCode,
            }),
          );
          yield* recordFailure({
            key,
            generation,
            production,
            summary: summarizeLatexFailure(failureDiagnostics),
            diagnostics: failureDiagnostics,
          });
          return;
        }
        if (producedBytes <= 0) {
          // Exited clean and produced nothing: still a failure, and one whose
          // reason the transcript does not carry, so it is stated outright.
          const failureDiagnostics = withFailureReason(diagnostics, MISSING_PDF_SUMMARY);
          yield* recordFailure({
            key,
            generation,
            production,
            summary: MISSING_PDF_SUMMARY,
            diagnostics: failureDiagnostics,
          });
          return;
        }
        // A build already replaced or cancelled must not stamp its own
        // evidence over the one the winner has recorded for its own PDF.
        if (yield* isSuperseded(key, generation)) return;
        const evidence = yield* collectBuildEvidence({
          key,
          workspaceRoot: entry.workspaceRoot,
          rootRelativePath: entry.rootRelativePath,
          rootAbsolutePath,
          compileDirectory,
          workDirectory,
          dependencyManifest: invocation.dependencyManifest,
        });
        // Evidence collection hashes workspace files and can take long enough
        // for a cancel or replacement build to win. Never let the superseded
        // fiber qualify another compile or publish after that boundary.
        if (yield* isSuperseded(key, generation)) return;
        if (
          (yield* workspaceFiles.getMutationEpoch({ cwd: entry.workspaceRoot })) !== mutationEpoch
        ) {
          yield* recordFailure({
            key,
            generation,
            production,
            summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
            diagnostics,
          });
          return;
        }
        if (
          !visualQualificationRetried &&
          latexVisualNeedsRequalification(beforeCompile.evidence, evidence)
        ) {
          // The recorder found workspace inputs the pre-compile snapshot could
          // not know yet. Re-run once inside the same production so the exact
          // dependency set is observed both before and after compilation; do
          // not publish a permanently read-only intermediate revision.
          visualQualificationRetried = true;
          continue;
        }
        if (
          visualQualificationRetried &&
          latexBuildInputsChangedDuringCompile(beforeCompile.evidence, evidence)
        ) {
          // A second pass is the bounded stabilization opportunity. If an
          // external writer changes a known input again during that pass, no
          // single source revision can truthfully be attached to its PDF.
          yield* recordFailure({
            key,
            generation,
            production,
            summary: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
            diagnostics,
          });
          return;
        }
        yield* publish({
          key,
          generation,
          production,
          pdfPath: invocation.pdfPath,
          syncTexPath: invocation.syncTexPath,
          workspaceRoot: entry.workspaceRoot,
          rootRelativePath: entry.rootRelativePath,
          compileDirectory,
          managedToolchain: managedBinDirectory !== null,
          title: documentTitle(entry.rootRelativePath),
          diagnostics,
          evidence,
          mutationEpoch,
          visualSourceRevisions: latexVisualSourceRevisions(beforeCompile.evidence, evidence),
        });
        return;
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          attemptDirectory === null || unretiredDirectories.has(attemptDirectory)
            ? Effect.void
            : fileSystem
                .remove(attemptDirectory, { recursive: true, force: true })
                .pipe(Effect.ignoreCause()),
        ),
      ),
    );
  };

  /**
   * One pass of the build loop. The permit is taken around the compile itself,
   * so a build that is waiting its turn stays in `queued` — the state a client
   * polls — instead of claiming to be running.
   */
  const runOnce = (key: string, generation: number) =>
    admission
      .withPermits(1)(compileAndPublish(key, generation))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Shutdown interrupts through this handler but is not a build verdict. Re-raise
            // interruption unchanged and leave binding settlement to startup reconciliation.
            if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
            yield* Effect.logWarning("latex build failed", { logicalDocumentKey: key, cause });
            const entry = yield* getEntry(key);
            if (entry === null || entry.generation !== generation) return;
            if (!ACTIVE_STATES.has(entry.state)) return;
            const summary = UNEXPECTED_FAILURE_SUMMARY;
            if (entry.production !== null) {
              // Infrastructure failure does not discredit source inputs. Release production without
              // staling its PDF, while reporting the build entry failed with the actual
              // infrastructure reason.
              yield* recordStoreAbandon(entry.production, summary);
            }
            yield* finishBuild(key, generation, (current) => ({
              ...current,
              state: "failed",
              failureSummary: summary,
              // Without this the snapshot keeps whatever the last finished
              // build said — nothing, on a first build — and the reader is
              // left with a generic sentence and an empty list.
              diagnostics: withFailureReason(current.diagnostics, summary),
            }));
          }),
        ),
      );

  /** Consumes a coalesced rebuild request and re-arms the entry for another pass. */
  const consumePendingRerun = Effect.fn("LatexBuildService.consumePendingRerun")(function* (
    key: string,
    generation: number,
  ) {
    const startedAtEpochMs = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(entriesRef, (entries) => {
      const current = entries.get(key);
      if (
        current === undefined ||
        current.generation !== generation ||
        !current.pendingRerun ||
        current.pendingMutationEpoch === null ||
        current.cancelRequested
      ) {
        return [false, entries] as const;
      }
      const next = new Map(entries);
      next.set(key, {
        ...current,
        passId: current.passId + 1,
        mutationEpoch: current.pendingMutationEpoch,
        pendingMutationEpoch: null,
        state: "queued",
        startedAtEpochMs,
        finishedAtEpochMs: null,
        pendingRerun: false,
        production: null,
        handle: null,
        installingPackages: null,
      });
      return [true, next] as const;
    });
  });

  const runBuildLoop = Effect.fn("LatexBuildService.runBuildLoop")(function* (
    key: string,
    generation: number,
  ) {
    let again = true;
    while (again) {
      const entry = yield* getEntry(key);
      if (
        entry?.generation === generation &&
        entry.startedAtEpochMs !== null &&
        ACTIVE_STATES.has(entry.state)
      ) {
        yield* observeOperation({
          key: `${generation}:${entry.startedAtEpochMs}`,
          operationKind: "latex-build",
          status: "active",
          startedAt: entry.startedAtEpochMs,
        });
      }
      yield* runOnce(key, generation);
      again = yield* consumePendingRerun(key, generation);
    }
  });

  const resolveTarget = Effect.fn("LatexBuildService.resolveTarget")(function* (
    operation: LatexBuildError["operation"],
    input: LatexBuildInput,
  ) {
    // Both fields arrive through `Schema.Trimmed`, so there is nothing left
    // to trim off them here.
    const workspaceRoot = path.resolve(input.workspaceRoot);
    const requested = input.relativePath;
    const invalidPath = () =>
      new LatexBuildError({
        operation,
        reason: "invalid-path",
        detail: "The document path must be relative to the workspace root.",
      });
    if (path.isAbsolute(requested)) return yield* invalidPath();
    const requestedRelative = toPosixPath(
      path.relative(workspaceRoot, path.resolve(workspaceRoot, requested)),
    );
    if (escapesWorkspaceRoot(requestedRelative)) return yield* invalidPath();

    const makeTarget = (
      rootRelativePath: string,
      failureSummary: string | null,
    ): Effect.Effect<ResolvedLatexTarget, LatexBuildError> => {
      const logicalDocumentKey = `latex:${workspaceIdentityDigest(workspaceRoot)}:${rootRelativePath}`;
      if (logicalDocumentKey.length > MAX_LOGICAL_DOCUMENT_KEY_LENGTH) {
        return Effect.fail(
          new LatexBuildError({
            operation,
            reason: "document-key-too-long",
            detail: "The document path is too long for Scient to track a build against it.",
          }),
        );
      }
      return Effect.succeed({
        logicalDocumentKey,
        workspaceRoot,
        rootRelativePath,
        failureSummary,
      });
    };

    const contents = yield* readSourceHead(
      path.resolve(workspaceRoot, requestedRelative),
      ROOT_RESOLUTION_HEAD_BYTES,
    ).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(contents)) {
      return yield* makeTarget(
        requestedRelative,
        `Unable to read ${requestedRelative}. Save the file and try again.`,
      );
    }

    const resolution = resolveLatexRoot({
      relativePath: requestedRelative,
      contents: contents.value,
    });
    if (resolution.reason === "fallback-self") {
      const containing = yield* discoverContainingLatexRoots({
        workspaceRoot,
        requestedRelativePath: requestedRelative,
      });
      if (containing.truncated) {
        return yield* makeTarget(
          requestedRelative,
          `Scient found too many possible LaTeX roots for ${requestedRelative}. Add a % !TEX root comment to select one.`,
        );
      }
      if (containing.roots.length > 1) {
        return yield* makeTarget(
          requestedRelative,
          `Multiple LaTeX roots include ${requestedRelative}: ${containing.roots.join(", ")}. Add a % !TEX root comment to select one.`,
        );
      }
      const containingRoot = containing.roots[0];
      if (containingRoot !== undefined) return yield* makeTarget(containingRoot, null);
    }
    const rootRelativePath = toPosixPath(
      path.relative(workspaceRoot, path.resolve(workspaceRoot, resolution.rootRelativePath)),
    );
    if (escapesWorkspaceRoot(rootRelativePath)) return yield* invalidPath();
    return yield* makeTarget(rootRelativePath, null);
  });

  /** The root lease covers raw source I/O only, never queueing or a process lifetime. */
  const observeSettledSourceEffect = Effect.fn("LatexBuildService.observeSettledSource")(
    function* <A>(
      operation: LatexBuildError["operation"],
      input: LatexBuildInput,
      observe: () => Effect.Effect<A, LatexBuildError>,
      expectedMutationEpoch?: string,
    ) {
      const mutationEpoch = yield* workspaceFiles.getMutationEpoch({ cwd: input.workspaceRoot });
      const changed = () =>
        new LatexBuildError({
          operation,
          reason: "sources-changed",
          detail: SOURCES_CHANGED_DURING_BUILD_SUMMARY,
        });
      if (expectedMutationEpoch !== undefined && mutationEpoch !== expectedMutationEpoch)
        return yield* Effect.fail(changed());
      const value = yield* workspaceFiles.withSettledWorkspaceRead(
        { cwd: input.workspaceRoot, relativePath: input.relativePath },
        (attention) =>
          attention === null
            ? observe()
            : Effect.fail(
                new LatexBuildError({
                  operation,
                  reason: "workspace-unsettled",
                  detail: "Source observation requires settled workspace publication authority.",
                }),
              ),
      );
      if ((yield* workspaceFiles.getMutationEpoch({ cwd: input.workspaceRoot })) !== mutationEpoch)
        return yield* Effect.fail(changed());
      return { value, mutationEpoch };
    },
    (effect, operation) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.fail(
            Schema.is(LatexBuildError)(error)
              ? error
              : new LatexBuildError({
                  operation,
                  reason: "workspace-unsettled",
                  detail:
                    error instanceof Error
                      ? error.message
                      : "Workspace source observation is unavailable or requires recovery.",
                }),
          ),
        ),
      ),
  );

  const observeSettledSource = <A>(
    operation: LatexBuildError["operation"],
    input: LatexBuildInput,
    observe: () => Effect.Effect<A, LatexBuildError>,
    expectedMutationEpoch?: string,
  ) => observeSettledSourceEffect(operation, input, observe, expectedMutationEpoch);

  /** The answer for a document this process has never built in memory. */
  const syntheticSnapshot = Effect.fn("LatexBuildService.syntheticSnapshot")(function* (
    target: ResolvedLatexTarget,
  ) {
    const toolchain = yield* toolchainProbe.probe(false);
    const base = {
      logicalDocumentKey: target.logicalDocumentKey,
      rootRelativePath: target.rootRelativePath,
      diagnostics: [] as ReadonlyArray<ScientLatexDiagnostic>,
      startedAtEpochMs: null,
      finishedAtEpochMs: null,
      toolchain,
      pendingRerun: false,
    };
    if (target.failureSummary !== null) {
      return {
        ...base,
        state: "failed" as const,
        descriptor: null,
        failureSummary: target.failureSummary,
      };
    }
    // Persisted bindings survive an empty in-memory registry, but cannot alone establish source
    // freshness. Put restored succeeded state through evidence checks before presenting it as
    // current.
    const descriptor = yield* store
      .getDescriptor(LogicalDocumentKey.make(target.logicalDocumentKey))
      .pipe(Effect.orElseSucceed(() => null));
    if (descriptor === null) {
      // Never built in this process and nothing persisted: the document is idle.
      return { ...base, state: "idle" as const, descriptor: null, failureSummary: null };
    }
    const stale = descriptor._tag === "generated-pdf" && descriptor.bindingStatus === "stale";
    return {
      ...base,
      state: stale ? ("failed" as const) : ("succeeded" as const),
      descriptor,
      failureSummary: descriptor._tag === "generated-pdf" && stale ? descriptor.staleReason : null,
    };
  });

  /**
   * Reuse the revision-scoped build evidence for export eligibility. Missing
   * evidence leaves the PDF readable but cannot authorize exporting it as current.
   */
  const restoreVisualSourceRevisions = Effect.fn("LatexBuildService.restoreVisualSourceRevisions")(
    function* (target: ResolvedLatexTarget, snapshot: ScientLatexBuildSnapshot) {
      const descriptor = snapshot.descriptor;
      if (
        snapshot.state !== "succeeded" ||
        descriptor?._tag !== "generated-pdf" ||
        descriptor.bindingStatus !== "current"
      )
        return snapshot;
      const cached = yield* loadEvidence(target.logicalDocumentKey);
      if (
        !cached.evidence ||
        cached.revision?.artifactId !== descriptor.artifactId ||
        cached.revision.revisionId !== descriptor.revisionId
      )
        return snapshot;
      return {
        ...snapshot,
        ...(cached.compiledBibliography === undefined
          ? {}
          : { compiledBibliography: cached.compiledBibliography }),
        visualSourceRevisions: latexVisualSourceRevisions(cached.evidence, cached.evidence),
      };
    },
  );

  /**
   * Auto-freshness builds must use the same admission/coalescing as explicit requests, adding no
   * concurrency. Seed a persisted descriptor after restart so rebuilding cannot blank a valid stale
   * PDF.
   */
  const startBuild = Effect.fn("LatexBuildService.startBuild")(function* (
    target: ResolvedLatexTarget,
    mutationEpoch: string,
    seedDescriptor: PdfSourceDescriptor | null = null,
  ) {
    const startedAtEpochMs = yield* Clock.currentTimeMillis;
    // Claimed before the entry is written, so the build this call may start
    // is the only one that owns the entry from here on.
    const generation = yield* Ref.updateAndGet(generationRef, (current) => current + 1);
    const started = yield* Ref.modify(entriesRef, (entries) => {
      const current = entries.get(target.logicalDocumentKey);
      const next = new Map(entries);
      if (current !== undefined && ACTIVE_STATES.has(current.state) && !current.cancelRequested) {
        // Coalesce: one follow-up run regardless of how many saves land.
        next.set(target.logicalDocumentKey, {
          ...current,
          pendingRerun: true,
          pendingMutationEpoch: mutationEpoch,
        });
        return [false, next] as const;
      }
      // Cancellation already owns the active entry. A request arriving after
      // that linearization point is new work, not a rerun to leave stranded
      // behind the cancelled pass.
      next.set(target.logicalDocumentKey, {
        logicalDocumentKey: target.logicalDocumentKey,
        generation,
        passId: 1,
        workspaceRoot: target.workspaceRoot,
        rootRelativePath: target.rootRelativePath,
        mutationEpoch,
        pendingMutationEpoch: null,
        state: "queued",
        // Last finished diagnostics and descriptor stay visible while the new
        // build runs; they are replaced only when it produces its own.
        diagnostics: current?.diagnostics ?? [],
        descriptor: current?.descriptor ?? seedDescriptor,
        failureSummary: current?.failureSummary ?? null,
        startedAtEpochMs,
        finishedAtEpochMs: null,
        pendingRerun: false,
        cancelRequested: false,
        production: null,
        handle: null,
        installingPackages: null,
      });
      return [true, next] as const;
    });
    if (started) {
      yield* Effect.forkIn(runBuildLoop(target.logicalDocumentKey, generation), buildScope);
    }
    return yield* readEntrySnapshot(target.logicalDocumentKey);
  });

  const requestBuild = Effect.fn("LatexBuildService.requestBuild")(function* (
    input: LatexBuildInput,
    admission?: LatexBuildAdmission,
  ) {
    const selection = yield* observeSettledSource(
      "build",
      input,
      () => resolveTarget("build", input),
      admission?.expectedMutationEpoch,
    );
    const target = selection.value;
    if (target.failureSummary !== null) return yield* syntheticSnapshot(target);
    return yield* startBuild(target, selection.mutationEpoch);
  });

  const status = Effect.fn("LatexBuildService.status")(function* (input: LatexBuildInput) {
    const selection = yield* observeSettledSource("status", input, () =>
      resolveTarget("status", input),
    );
    const target = selection.value;
    const currentEvidence = (descriptor: PdfSourceDescriptor | null) =>
      observeSettledSource(
        "status",
        input,
        () => evidenceIsCurrent(target, descriptor, selection.mutationEpoch),
        selection.mutationEpoch,
      ).pipe(
        Effect.map((observed) => observed.value),
        Effect.catch((error) =>
          error.reason === "sources-changed" ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
    if (target.failureSummary !== null) return yield* syntheticSnapshot(target);
    const entry = yield* getEntry(target.logicalDocumentKey);
    if (entry === null) {
      const restored = yield* syntheticSnapshot(target);
      // Status is observational: stale evidence never starts a compiler.
      if (restored.state !== "succeeded") return restored;
      if (yield* currentEvidence(restored.descriptor)) {
        return yield* restoreVisualSourceRevisions(target, restored);
      }
      return staleSnapshot(restored);
    }
    // Only a finished, successful entry can be wrong about being current: an
    // active one is already going to answer with its own compile, and a
    // failed one is already telling the reader not to trust what it shows.
    if (entry.state === "succeeded") {
      if (!(yield* currentEvidence(entry.descriptor))) {
        return staleSnapshot(yield* withToolchain(entry));
      }
    }
    return yield* withToolchain(entry);
  });

  const cancel = Effect.fn("LatexBuildService.cancel")(function* (input: LatexBuildInput) {
    const target = yield* resolveTarget("cancel", input);
    // Capture and mark one exact pass in a single Ref transition. A completed
    // pass may hand off to its coalesced successor between arbitrary effects;
    // a stale snapshot must neither cancel nor revive that successor.
    const cancellation = yield* Ref.modify(
      entriesRef,
      (entries): readonly [CancellationClaim, Map<string, LatexBuildEntry>] => {
        const current = entries.get(target.logicalDocumentKey) ?? null;
        if (current === null || !ACTIVE_STATES.has(current.state)) {
          return [{ claimed: false, entry: current }, entries];
        }
        const next = new Map(entries);
        next.set(target.logicalDocumentKey, {
          ...current,
          cancelRequested: true,
          pendingRerun: false,
        });
        return [{ claimed: true, entry: current }, next];
      },
    );
    const entry = cancellation.entry;
    if (entry === null) return yield* syntheticSnapshot(target);
    if (!cancellation.claimed) return yield* withToolchain(entry);
    let retirementUnknown = false;
    if (entry.handle !== null)
      yield* entry.handle.cancel.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            retirementUnknown = true;
            yield* Effect.logWarning("latex cancellation could not prove process retirement", {
              logicalDocumentKey: target.logicalDocumentKey,
              cause,
            });
          }),
        ),
      );
    if (entry.production !== null) {
      // Cancellation abandons without discrediting sources. Its returned binding is the
      // linearization result: if publication already won the store lock, reporting cancelled would
      // overwrite a real success.
      const binding = yield* store
        .abandonProduction({ ...entry.production, reason: CANCELLED_SUMMARY })
        .pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning("latex build production could not be released", { error }).pipe(
              Effect.as(Option.none<DocumentArtifactBinding>()),
            ),
          ),
        );
      if (Option.isSome(binding) && productionHasPublished(binding.value, entry.production)) {
        const descriptor = yield* readLiveDescriptor(target.logicalDocumentKey);
        const publicationWonThisPass = yield* updateOwnPassEntry(
          target.logicalDocumentKey,
          entry.generation,
          entry.passId,
          (current) => ({
            ...current,
            cancelRequested: false,
            descriptor: descriptor ?? current.descriptor,
          }),
        );
        if (publicationWonThisPass) {
          return yield* readEntrySnapshot(target.logicalDocumentKey);
        }
      }
    }
    // Same re-read as `recordFailure`: the snapshot this call returns has to
    // carry whatever the store now says about the binding rather than echo
    // the status it was holding before the cancel.
    const descriptor = yield* readLiveDescriptor(target.logicalDocumentKey);
    yield* finishBuild(target.logicalDocumentKey, entry.generation, (current) => ({
      ...current,
      state: retirementUnknown ? "failed" : "cancelled",
      failureSummary: retirementUnknown
        ? "The compiler could not be stopped. Its private output directory was retained."
        : CANCELLED_SUMMARY,
      descriptor: descriptor ?? current.descriptor,
    }));
    return yield* readEntrySnapshot(target.logicalDocumentKey);
  });

  const resolveDocumentRequest = Effect.fn("LatexBuildService.resolveDocument")(function* (
    input: ScientLatexResolveRequest,
  ) {
    const observation = yield* observeSettledSource(
      "resolve",
      { workspaceRoot: input.workspaceRoot, relativePath: input.sourceRelativePath },
      () =>
        Effect.tryPromise({
          try: () => resolveLatexDocument(input),
          catch: (cause) =>
            new LatexBuildError({
              operation: "resolve",
              reason: "invalid-path",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "The LaTeX document could not be resolved.",
            }),
        }),
    );
    return observation.value;
  });

  return LatexBuildService.of({
    resolveDocument: resolveDocumentRequest,
    requestBuild,
    status,
    acknowledgeOutputPublication,
    cancel,
  });
});

/**
 * Mount one shared package-installer instance for managed install and builds; tlmgr writes one
 * distribution database, so separate instances cannot provide serialization even if layers look
 * equivalent.
 */
export const layer = Layer.effect(LatexBuildService, make);
