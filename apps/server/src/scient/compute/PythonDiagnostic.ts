// @effect-diagnostics nodeBuiltinImport:off -- diagnostic normalization is a synchronous adapter contract.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ComputeDiagnostic,
  ComputeDiagnosticContext,
  ComputeDiagnosticFrame,
  ComputeRuntimeErrorReport,
} from "@scientfactory/compute";

// ---------------------------------------------------------------------------
// Limits (from Phase 2 plan §2.10)
// ---------------------------------------------------------------------------

const MAX_TRACEBACK_LINES = 200;
const MAX_TRACEBACK_LINE_BYTES = 4096;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_VALUE_BYTES = 16384;
const MAX_DIAGNOSTIC_FRAMES = 64;

// ---------------------------------------------------------------------------
// ANSI / control sequence stripping
// ---------------------------------------------------------------------------

// Matches CSI sequences (the most common ANSI escape), single-char C1 controls,
// and OSC sequences.  Python tracebacks sometimes embed colour codes from
// IPython or rich; stripping them keeps the diagnostic readable and prevents
// control characters from reaching durable storage or the UI.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- ANSI escape codes are the input we are cleaning.
  /(?:\u001B\[[0-9;]*[a-zA-Z])|(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))|(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F])/g;

const STANDARD_FRAME_PATTERN = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const IPYTHON_FILE_FRAME_PATTERN = /^\s*File\s+(.+):(\d+)(?:,\s+in\s+(.+))?\s*$/;
const IPYTHON_CELL_FRAME_PATTERN = /^\s*Cell\s+In\[[^\]]*\],\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const SYNTHETIC_PYTHON_PATH_PATTERN = /^<[^>]+>$/;
const SCIENT_SOURCE_PATTERN = /^<scient-compute-source:([0-9a-f]+):[0-9]+>$/;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Unicode-safe truncation
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function truncateOnByteBoundary(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Walk through complete UTF-8 characters and keep only those that fit
  // within the byte limit.  This avoids producing U+FFFD replacement
  // characters (3 bytes each) from incomplete multi-byte sequences.
  let safeEnd = 0;
  for (let i = 0; i < bytes.byteLength && i < maxBytes;) {
    const byte = bytes[i]!;
    let charLen: number;
    if (byte < 0x80) charLen = 1;
    else if ((byte & 0xe0) === 0xc0) charLen = 2;
    else if ((byte & 0xf0) === 0xe0) charLen = 3;
    else charLen = 4;
    if (i + charLen <= maxBytes) {
      safeEnd = i + charLen;
    }
    i += charLen;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, safeEnd));
}

function projectRelativePath(projectRoot: string, reportedPath: string): string | null {
  const root = NodePath.resolve(projectRoot);
  const expanded = reportedPath.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), reportedPath.slice(2))
    : reportedPath;
  const absolute = NodePath.isAbsolute(expanded)
    ? NodePath.resolve(expanded)
    : NodePath.resolve(root, expanded);
  const relative = NodePath.relative(root, absolute);
  if (
    relative.length === 0 ||
    NodePath.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`)
  ) {
    return null;
  }
  const normalized = relative.split(NodePath.sep).join("/");
  return encoder.encode(normalized).byteLength <= MAX_TRACEBACK_LINE_BYTES ? normalized : null;
}

function positiveLine(value: string, offset = 0): number | null {
  const parsed = Number(value);
  const line = parsed + offset;
  return Number.isSafeInteger(parsed) && parsed >= 1 && Number.isSafeInteger(line) && line >= 1
    ? line
    : null;
}

function frameFunctionName(value: string | undefined): string | null {
  const name = value?.trim();
  return name ? truncateOnByteBoundary(name, MAX_ERROR_NAME_BYTES) : null;
}

function submittedFrame(
  context: ComputeDiagnosticContext,
  executionId: string,
  runtimeLine: string,
  functionName: string | undefined,
): ComputeDiagnosticFrame | null {
  const source = context.executionSources?.get(executionId);
  if (source === undefined) return null;
  const relativePath = projectRelativePath(context.projectRoot, source.relativePath);
  if (Number(runtimeLine) > source.lineCount) return null;
  const line = positiveLine(runtimeLine, source.startLine);
  if (relativePath === null || line === null) return null;
  return {
    relativePath,
    line,
    column: null,
    functionName: frameFunctionName(functionName),
  };
}

function parseFrame(
  line: string,
  context: ComputeDiagnosticContext,
): ComputeDiagnosticFrame | null {
  const cellMatch = IPYTHON_CELL_FRAME_PATTERN.exec(line);
  // Cell numbers and arbitrary synthetic filenames do not identify the current
  // submission: they may belong to retained functions or user-created code.
  if (cellMatch) return null;

  const standardMatch = STANDARD_FRAME_PATTERN.exec(line);
  const fileMatch = standardMatch ?? IPYTHON_FILE_FRAME_PATTERN.exec(line);
  if (!fileMatch) return null;
  const reportedPath = fileMatch[1]!.trim();
  const sourceMatch = SCIENT_SOURCE_PATTERN.exec(reportedPath);
  if (sourceMatch) {
    const encodedId = sourceMatch[1]!;
    if (encodedId.length % 2 !== 0) return null;
    const executionId = Buffer.from(encodedId, "hex").toString("utf8");
    return submittedFrame(context, executionId, fileMatch[2]!, fileMatch[3]);
  }
  if (SYNTHETIC_PYTHON_PATH_PATTERN.test(reportedPath)) {
    return null;
  }
  const relativePath = projectRelativePath(context.projectRoot, reportedPath);
  const frameLine = positiveLine(fileMatch[2]!);
  if (relativePath === null || frameLine === null) return null;
  return {
    relativePath,
    line: frameLine,
    column: null,
    functionName: frameFunctionName(fileMatch[3]),
  };
}

function extractFrames(
  traceback: ReadonlyArray<string>,
  context: ComputeDiagnosticContext,
): ReadonlyArray<ComputeDiagnosticFrame> {
  const frames: ComputeDiagnosticFrame[] = [];
  const seen = new Set<string>();
  tracebackLines: for (const tracebackEntry of traceback) {
    // Jupyter may group a frame and its code excerpt into one string. Parsing
    // physical lines preserves the retained traceback while still recognizing
    // the same frame grammar as CPython's one-line entries.
    for (const line of tracebackEntry.split(/\r?\n/u)) {
      const frame = parseFrame(line, context);
      if (frame === null) continue;
      const key = `${frame.relativePath}:${String(frame.line)}:${frame.functionName ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push(frame);
      if (frames.length === MAX_DIAGNOSTIC_FRAMES) break tracebackLines;
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw Python error report into one or more `ComputeDiagnostic`
 * records.
 *
 * Strips ANSI/control sequences, bounds every field, preserves the
 * human-readable traceback, and extracts only project-local source locations.
 * The adapter owns that decision because it has both runtime syntax knowledge
 * and the server-authoritative project root; clients never infer file authority
 * from traceback text.
 */
export function normalizePythonDiagnostic(
  report: ComputeRuntimeErrorReport,
  context: ComputeDiagnosticContext,
): ReadonlyArray<ComputeDiagnostic> {
  const errorName = truncateOnByteBoundary(stripAnsi(report.name), MAX_ERROR_NAME_BYTES);
  const message = truncateOnByteBoundary(stripAnsi(report.value), MAX_ERROR_VALUE_BYTES);

  // Emptied lines are dropped before the limit is applied, not after: a colour
  // reset on its own line is nothing a reader needs, and counting it would let
  // a traceback spend its whole allowance on lines that say nothing.
  const traceback = report.traceback
    .map(stripAnsi)
    .map((line) => truncateOnByteBoundary(line, MAX_TRACEBACK_LINE_BYTES))
    .filter((line) => line.length > 0)
    .slice(0, MAX_TRACEBACK_LINES);

  return [{ errorName, message, traceback, frames: extractFrames(traceback, context) }];
}
