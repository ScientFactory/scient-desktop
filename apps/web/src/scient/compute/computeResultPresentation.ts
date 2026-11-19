import {
  projectComputeOutputs,
  sameComputeRepresentationBundle,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeProjectedOutput,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];
type ComputeExecutionStatus = NonNullable<ComputeExecutionRecord["result"]>["status"];
type ComputeSystemEvent = Extract<ComputeOutput, { readonly _tag: "system" }>["event"];
export const COMPUTE_NATIVE_FIGURE_MEDIA_TYPE = "application/vnd.mathworks.matlab.figure";
// Matches the retained representation-bundle limit; native files are never decoded here.
export const MAX_COMPUTE_NATIVE_FIGURE_BYTES = 8 * 1024 * 1024;

export type ComputeFigureResource = {
  readonly contentHash: Extract<ComputeOutput, { readonly _tag: "image" }>["contentHash"];
  readonly byteLength: number;
};

const COMPUTE_STATIC_IMAGE_MEDIA_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
] as const;
export type ComputeStaticImageMediaType = (typeof COMPUTE_STATIC_IMAGE_MEDIA_TYPES)[number];

/** Local presentation metadata; the retained output contract stays unchanged. */
export type ComputeStaticImageOutput = Omit<
  Extract<ComputeOutput, { readonly _tag: "image" }>,
  "mediaType"
> & {
  readonly mediaType: ComputeStaticImageMediaType;
  readonly displayId?: string;
  readonly nativeFigure?: ComputeFigureResource;
  /** A vector copy shown inline figures carry for saving. */
  readonly pdf?: ComputeFigureResource;
};

function isStaticImageMediaType(mediaType: string): mediaType is ComputeStaticImageMediaType {
  return (COMPUTE_STATIC_IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType);
}

/** A standalone image update is itself a complete retained figure snapshot. */
export function projectComputeFigureOutputs(
  outputs: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeProjectedOutput> {
  const displays = new Set<string>();
  return projectComputeOutputs(
    outputs.map((output): ComputeOutput => {
      if (output._tag === "display-data" && output.displayId !== null)
        displays.add(output.displayId);
      if (
        output._tag === "display-update" &&
        !displays.has(output.displayId) &&
        output.bundle.representations.some(
          (item) => isStaticImageMediaType(item.mediaType) && item.data._tag === "resource",
        )
      ) {
        displays.add(output.displayId);
        return { ...output, _tag: "display-data" };
      }
      return output;
    }),
  );
}

/** Adapts one projected rich bundle into the existing producer-neutral image surface. */
export function computeProjectedStaticImage(
  output: Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>,
): ComputeStaticImageOutput | null {
  const native = output.bundle.representations.find(
    (item) => item.mediaType === COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
  );
  const nativeFigure =
    native?.data._tag === "resource" &&
    Number.isSafeInteger(native.data.byteLength) &&
    native.data.byteLength > 0 &&
    native.data.byteLength <= MAX_COMPUTE_NATIVE_FIGURE_BYTES
      ? native.data
      : null;
  const pdf = output.bundle.representations.find(
    (item) => item.mediaType === "application/pdf",
  )?.data;
  for (const mediaType of COMPUTE_STATIC_IMAGE_MEDIA_TYPES) {
    const representation = output.bundle.representations.find(
      (candidate) => candidate.mediaType === mediaType && candidate.data._tag === "resource",
    );
    if (representation?.data._tag !== "resource") continue;
    return {
      _tag: "image",
      sequence: output.sequence,
      observedAt: output.observedAt,
      mediaType,
      contentHash: representation.data.contentHash,
      byteLength: representation.data.byteLength,
      width: null,
      height: null,
      origin: { _tag: "runtime-display" },
      ...(output.displayId === null ? {} : { displayId: output.displayId }),
      ...(nativeFigure === null ? {} : { nativeFigure }),
      ...(pdf?._tag === "resource" ? { pdf } : {}),
    };
  }
  return null;
}

function sameOutput(left: ComputeOutput, right: ComputeOutput): boolean {
  if (left.sequence !== right.sequence || left._tag !== right._tag) return false;
  switch (left._tag) {
    case "stream":
      return right._tag === "stream" && left.stream === right.stream && left.text === right.text;
    case "diagnostic":
      return (
        right._tag === "diagnostic" &&
        left.diagnostic.errorName === right.diagnostic.errorName &&
        left.diagnostic.message === right.diagnostic.message &&
        left.diagnostic.traceback.length === right.diagnostic.traceback.length &&
        left.diagnostic.traceback.every(
          (line, index) => line === right.diagnostic.traceback[index],
        ) &&
        left.diagnostic.frames.length === right.diagnostic.frames.length &&
        left.diagnostic.frames.every((frame, index) => {
          const candidate = right.diagnostic.frames[index];
          return (
            candidate !== undefined &&
            frame.relativePath === candidate.relativePath &&
            frame.line === candidate.line &&
            frame.column === candidate.column &&
            frame.functionName === candidate.functionName
          );
        })
      );
    case "image":
      return right._tag === "image" && left.contentHash === right.contentHash;
    case "system":
      return right._tag === "system" && left.event === right.event && left.detail === right.detail;
    case "display-data":
      return (
        right._tag === "display-data" &&
        left.displayId === right.displayId &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "execute-result":
      return (
        right._tag === "execute-result" &&
        left.executionCount === right.executionCount &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "display-update":
      return (
        right._tag === "display-update" &&
        left.displayId === right.displayId &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "clear-output":
      return right._tag === "clear-output" && left.wait === right.wait;
  }
}

/**
 * Reconciles a possibly stale durable read with newer bounded notifications.
 * Sequence groups preserve multiple figures emitted by one runtime event.
 */
export function mergeComputeOutputs(
  persisted: ReadonlyArray<ComputeOutput>,
  live: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeOutput> {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const groups = new Map<number, ComputeOutput[]>();
  for (const output of persisted) {
    const group = groups.get(output.sequence) ?? [];
    group.push(output);
    groups.set(output.sequence, group);
  }
  for (const output of live) {
    const group = groups.get(output.sequence) ?? [];
    if (!group.some((candidate) => sameOutput(candidate, output))) group.push(output);
    groups.set(output.sequence, group);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, outputs]) => outputs);
}

/** `msg()` strings. */
const SOURCE_ORIGIN_LABELS = {
  file: msg("File", { $context: "a run of the whole file" }),
  selection: msg("Selection", { $context: "a run of selected code" }),
  cell: msg("Cell", { $context: "a run of one notebook-style cell" }),
} as const satisfies Record<
  Extract<ComputeExecutionSource, { _tag: "document" }>["origin"],
  string
>;

/** The origin with its line or line range. */
function sourceOriginRangeLabel(
  origin: Extract<ComputeExecutionSource, { _tag: "document" }>["origin"],
  range: string,
  resolve: MessageResolver,
): string {
  switch (origin) {
    case "file":
      return resolve(
        msg("File {range}", { range, $context: "a run of the whole file, then its lines" }),
      );
    case "selection":
      return resolve(
        msg("Selection {range}", { range, $context: "a run of selected code, then its lines" }),
      );
    case "cell":
      return resolve(msg("Cell {range}", { range, $context: "a run of one cell, then its lines" }));
  }
}

/** `msg()` strings. */
const EXECUTION_STATUS_LABELS = {
  queued: msg("Queued"),
  submitting: msg("Starting", { $context: "run status" }),
  running: msg("Running"),
  succeeded: msg("Succeeded"),
  failed: msg("Failed", { $context: "run status" }),
  interrupting: msg("Stopping"),
  cancelled: msg("Cancelled"),
  lost: msg("Session ended"),
} as const satisfies Record<ComputeExecutionStatus, string>;

/** `msg()` strings. */
const SYSTEM_EVENT_LABELS = {
  "session-started": msg("Session started"),
  "session-restarted": msg("Session restarted"),
  "execution-interrupted": msg("Execution interrupted"),
  "session-lost": msg("Session ended unexpectedly"),
  "output-truncated": msg("Some output was not retained"),
  "input-unsupported": msg("Interactive input is not supported"),
  "runtime-warning": msg("Runtime warning"),
} as const satisfies Record<ComputeSystemEvent, string>;

export function computeSourceLabel(
  source: ComputeExecutionSource,
  options: { readonly includePath: boolean },
  resolve: MessageResolver = m,
): string {
  if (source._tag === "console") return resolve(msg("Console"));
  const range =
    source.origin === "file" || source.range === null
      ? null
      : source.range.startLine === source.range.endLine
        ? `${source.range.startLine + 1}`
        : `${source.range.startLine + 1}–${source.range.endLine + 1}`;
  const what =
    source.origin === "file"
      ? options.includePath
        ? null
        : resolve(SOURCE_ORIGIN_LABELS.file)
      : range === null
        ? resolve(SOURCE_ORIGIN_LABELS[source.origin])
        : sourceOriginRangeLabel(source.origin, range, resolve);
  return [
    options.includePath ? source.path : null,
    what,
    source.bufferState === "dirty" ? resolve(msg("unsaved")) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function computeExecutionStatusLabel(
  result: Pick<NonNullable<ComputeExecutionRecord["result"]>, "status" | "queuePosition"> | null,
  resolve: MessageResolver = m,
): string {
  if (result === null) return resolve(msg("Pending"));
  if (result.status !== "queued" || result.queuePosition === null) {
    return resolve(EXECUTION_STATUS_LABELS[result.status]);
  }
  return result.queuePosition <= 1
    ? resolve(msg("Queued · next"))
    : resolve(msg("Queued · {count} ahead", { count: result.queuePosition }));
}

export function computeSystemEventLabel(
  event: ComputeSystemEvent,
  resolve: MessageResolver = m,
): string {
  return resolve(SYSTEM_EVENT_LABELS[event]);
}

export function computeRunDurationLabel(
  result: Pick<NonNullable<ComputeExecutionRecord["result"]>, "startedAt" | "finishedAt"> | null,
): string | null {
  if (result?.startedAt == null || result.finishedAt == null) return null;
  const ms = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
