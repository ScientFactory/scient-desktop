// @effect-diagnostics nodeBuiltinImport:off -- diagnostic normalization is a synchronous adapter contract.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ComputeDiagnostic,
  ComputeDiagnosticContext,
  ComputeDiagnosticFrame,
  ComputeRuntimeErrorReport,
} from "@scientfactory/compute";

// Limits (from Phase 2 plan §2.10)

const MAX_TRACEBACK_LINES = 200;
const MAX_TRACEBACK_LINE_BYTES = 4096;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_VALUE_BYTES = 16384;
const MAX_DIAGNOSTIC_FRAMES = 64;

// ANSI / control sequence stripping

// Matches CSI sequences (the most common ANSI escape), single-char C1 controls,
// and OSC sequences.  Python tracebacks sometimes embed colour codes from
// IPython or rich; stripping them keeps the diagnostic readable and prevents
// control characters from reaching durable storage or the UI.
const ANSI_PATTERN =
  /(?:\u001B\[[0-9;]*[a-zA-Z])|(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))|(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F])/g;

const STANDARD_FRAME_PATTERN = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const IPYTHON_FILE_FRAME_PATTERN = /^\s*File\s+(.+):(\d+)(?:,\s+in\s+(.+))?\s*$/;
const IPYTHON_CELL_FRAME_PATTERN = /^\s*Cell\s+In\[[^\]]*\],\s+line\s+(\d+)(?:,\s+in\s+(.+))?\s*$/;
const JULIA_FRAME_PATTERN = /^\s*.*?@ (?:[\p{L}\p{N}_.]+ )?(.+):(\d+)\s*$/u;
const R_FRAME_PATTERN =
  /^\s*(?:!\s+)?(?:at\s+|Error in [^:]+ : |Error:\s*)?(.+?\.[rR]):(\d+)(?::(\d+))?(?::.*)?\s*$/;
const R_STACK_LOCATION = /^\s*(?:!\s+)?at\s+.+\.[rR]:\d+(?::\d+)?\s*$/;
const SYNTHETIC_PYTHON_PATH_PATTERN = /^<[^>]+>$/;
const SCIENT_SOURCE_PATTERN = /^<scient-compute-source:([0-9a-f]+):[0-9]+>$/;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

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

function existingProjectFile(projectRoot: string, path: string): string | null {
  const relative = projectRelativePath(projectRoot, path);
  if (relative === null) return null;
  try {
    const root = NodeFS.realpathSync(projectRoot);
    const file = NodeFS.realpathSync(NodePath.resolve(projectRoot, relative));
    return projectRelativePath(root, file) !== null && NodeFS.statSync(file).isFile()
      ? relative
      : null;
  } catch {
    return null;
  }
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

function matchFrame(line: string, language: string) {
  if (language === "julia") return JULIA_FRAME_PATTERN.exec(line);
  if (language === "r") return R_FRAME_PATTERN.exec(line);
  return STANDARD_FRAME_PATTERN.exec(line) ?? IPYTHON_FILE_FRAME_PATTERN.exec(line);
}

function parseFrame(
  line: string,
  context: ComputeDiagnosticContext,
  language: string,
): ComputeDiagnosticFrame | null {
  const cellMatch = IPYTHON_CELL_FRAME_PATTERN.exec(line);
  // Cell numbers and arbitrary synthetic filenames do not identify the current
  // submission: they may belong to retained functions or user-created code.
  if (cellMatch) return null;

  const fileMatch = matchFrame(line, language);
  if (!fileMatch) return null;
  const reportedPath = fileMatch[1]!.trim();
  const sourceMatch = SCIENT_SOURCE_PATTERN.exec(reportedPath);
  if (sourceMatch) {
    const encodedId = sourceMatch[1]!;
    if (encodedId.length % 2 !== 0) return null;
    const executionId = Buffer.from(encodedId, "hex").toString("utf8");
    const frame = submittedFrame(context, executionId, fileMatch[2]!, fileMatch[3]);
    if (
      frame !== null &&
      language === "julia" &&
      existingProjectFile(context.projectRoot, frame.relativePath) === null
    )
      return null;
    return frame;
  }
  if (SYNTHETIC_PYTHON_PATH_PATTERN.test(reportedPath)) return null;
  if (language === "julia" && !NodePath.isAbsolute(reportedPath) && !reportedPath.startsWith("~/"))
    return null;
  const relativePath =
    language === "julia" || language === "r"
      ? existingProjectFile(context.projectRoot, reportedPath)
      : projectRelativePath(context.projectRoot, reportedPath);
  const frameLine = positiveLine(fileMatch[2]!);
  if (relativePath === null || frameLine === null) return null;
  return {
    relativePath,
    line: frameLine,
    column: language === "r" ? positiveLine(fileMatch[3] ?? "") : null,
    functionName: language === "r" ? null : frameFunctionName(fileMatch[3]),
  };
}

function extractFrames(
  traceback: ReadonlyArray<string>,
  context: ComputeDiagnosticContext,
  language: string,
): ReadonlyArray<ComputeDiagnosticFrame> {
  const frames: ComputeDiagnosticFrame[] = [];
  const seen = new Set<string>();
  tracebackLines: for (const tracebackEntry of traceback) {
    // Jupyter may group a frame and its code excerpt into one string. Parsing
    // physical lines preserves the retained traceback while still recognizing
    // the same frame grammar as CPython's one-line entries.
    for (const line of tracebackEntry.split(/\r?\n/u)) {
      const frame = parseFrame(line, context, language);
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

/**
 * Only the runtime adapter has both Python syntax and the authorized project root. Extract
 * project-local locations there; clients must never infer file authority from traceback text. Strip
 * controls and bound diagnostics.
 */
/** Bounded, control-free error text for any Jupyter kernel's error report. */
export function normalizeDiagnosticText(
  report: ComputeRuntimeErrorReport,
): Omit<ComputeDiagnostic, "frames"> {
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

  return { errorName, message, traceback };
}

function normalizeRDiagnostic(
  text: Omit<ComputeDiagnostic, "frames">,
  context: ComputeDiagnosticContext,
): ComputeDiagnostic {
  const messageLines = text.message.split("\n");
  const frames = extractFrames([text.message, ...text.traceback], context, "r");
  const relativeLocation = (line: string) => {
    const match = R_FRAME_PATTERN.exec(line);
    const frame = match === null ? null : parseFrame(line, context, "r");
    return frame === null ? line : line.replace(match![1]!, frame.relativePath);
  };
  const locations = messageLines
    .filter((line) => R_STACK_LOCATION.test(line) && parseFrame(line, context, "r") !== null)
    .map(relativeLocation);
  return {
    errorName: text.errorName.trim(),
    message: messageLines
      .filter((line) => !R_STACK_LOCATION.test(line))
      .map(relativeLocation)
      .join("\n")
      .replace(/^(?:Error:\s*)?![ \t]*/u, "")
      .replace(/(\n)[ \t]*![ \t]+/gu, "$1"),
    traceback: [...locations, ...text.traceback.map(relativeLocation)],
    frames,
  };
}

export function normalizeKernelDiagnostic(
  report: ComputeRuntimeErrorReport,
  context: ComputeDiagnosticContext,
  language: string,
): ReadonlyArray<ComputeDiagnostic> {
  const text = normalizeDiagnosticText(report);
  if (language === "r") return [normalizeRDiagnostic(text, context)];
  const frames = extractFrames(text.traceback, context, language);
  const traceback = text.traceback.map((entry) =>
    entry
      .split("\n")
      .map((line) => {
        const match = matchFrame(line, language);
        const path = match?.[1];
        if (path === undefined || !SCIENT_SOURCE_PATTERN.test(path)) return line;
        const frame = parseFrame(line, context, language);
        if (frame === null) return line;
        const location = line.indexOf(path);
        const tail = line.slice(location + path.length);
        return (
          line.slice(0, location) +
          frame.relativePath +
          tail.replace(/^(:|",\s+line\s+)\d+/, (_line, separator: string) => separator + frame.line)
        );
      })
      .join("\n"),
  );
  return [{ ...text, frames, traceback }];
}

export function normalizePythonDiagnostic(
  report: ComputeRuntimeErrorReport,
  context: ComputeDiagnosticContext,
): ReadonlyArray<ComputeDiagnostic> {
  return normalizeKernelDiagnostic(report, context, "python");
}
