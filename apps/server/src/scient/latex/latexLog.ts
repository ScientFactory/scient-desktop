/**
 * Parses TeX engine output into structured diagnostics. Builds run with
 * `-file-line-error`, so errors arrive as `./path.tex:12: message`; warnings
 * keep LaTeX's prose form. The parser reads both interleaved from one
 * combined stdout/stderr transcript and never throws on unfamiliar output —
 * unrecognized lines are simply not diagnostics.
 */

export interface LatexDiagnostic {
  readonly severity: "error" | "warning";
  /** Path as the engine printed it, normalized to forward slashes, no leading ./ */
  readonly file: string | null;
  readonly line: number | null;
  readonly message: string;
}

const FILE_LINE_ERROR_PATTERN = /^(.+?\.\w{1,8}):(\d+):\s?(.*)$/u;
const BARE_ERROR_PATTERN = /^!\s?(.+)$/u;
const WARNING_PATTERN = /^(?:LaTeX|Package|Class)(?:\s+\S+)?\s+Warning:\s?(.*)$/u;
const WARNING_LINE_SUFFIX_PATTERN = /on input line (\d+)\.?\s*$/u;
const MISSING_FILE_PATTERN = /^No file\s+(.+?)\.\s*$/u;

const MAX_DIAGNOSTICS = 200;
const MAX_MESSAGE_LENGTH = 500;

function normalizeEnginePath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function clampMessage(message: string): string {
  const collapsed = message.trim().replace(/\s+/gu, " ");
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

/** Parses one combined engine transcript into bounded, ordered diagnostics. */
export function parseLatexLog(transcript: string): LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const lines = transcript.split(/\r?\n/u);

  for (let index = 0; index < lines.length && diagnostics.length < MAX_DIAGNOSTICS; index += 1) {
    const line = lines[index] ?? "";

    const fileLineError = FILE_LINE_ERROR_PATTERN.exec(line);
    if (fileLineError?.[1] !== undefined && fileLineError[2] !== undefined) {
      // Engines wrap the message across following lines until a blank one;
      // one continuation line is enough context without swallowing the log.
      const continuation = (lines[index + 1] ?? "").trim();
      const message = clampMessage(
        `${fileLineError[3] ?? ""}${continuation && !continuation.startsWith("!") ? ` ${continuation}` : ""}`,
      );
      diagnostics.push({
        severity: "error",
        file: normalizeEnginePath(fileLineError[1]),
        line: Number.parseInt(fileLineError[2], 10),
        message: message || "TeX error",
      });
      continue;
    }

    const bareError = BARE_ERROR_PATTERN.exec(line);
    if (bareError?.[1] !== undefined) {
      diagnostics.push({
        severity: "error",
        file: null,
        line: null,
        message: clampMessage(bareError[1]),
      });
      continue;
    }

    const warning = WARNING_PATTERN.exec(line);
    if (warning?.[1] !== undefined) {
      let message = warning[1];
      // Multi-line warnings continue on indented lines; join until blank.
      let lookahead = index + 1;
      while (lookahead < lines.length && /^\s{2,}\S/u.test(lines[lookahead] ?? "")) {
        message += ` ${(lines[lookahead] ?? "").trim()}`;
        lookahead += 1;
      }
      index = lookahead - 1;
      const lineMatch = WARNING_LINE_SUFFIX_PATTERN.exec(message);
      diagnostics.push({
        severity: "warning",
        file: null,
        line: lineMatch?.[1] !== undefined ? Number.parseInt(lineMatch[1], 10) : null,
        message: clampMessage(message),
      });
      continue;
    }

    const missingFile = MISSING_FILE_PATTERN.exec(line);
    if (missingFile?.[1] !== undefined) {
      diagnostics.push({
        severity: "warning",
        file: normalizeEnginePath(missingFile[1]),
        line: null,
        message: clampMessage(`Missing file: ${missingFile[1]}`),
      });
    }
  }

  return diagnostics;
}

/** The one-line failure summary recorded on a stale binding. */
export function summarizeLatexFailure(diagnostics: readonly LatexDiagnostic[]): string {
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError === undefined) return "LaTeX build failed.";
  const location =
    firstError.file !== null && firstError.line !== null
      ? `${firstError.file}:${firstError.line}: `
      : "";
  return `${location}${firstError.message}`;
}
