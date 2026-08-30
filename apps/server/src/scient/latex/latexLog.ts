/**
 * Parses TeX engine output into structured diagnostics. Builds run with
 * `-file-line-error`, so errors arrive as `./path.tex:12: message`; warnings
 * keep LaTeX's prose form. tectonic prefixes the same lines with `error:` or
 * `warning:`, which the parser strips before matching. The parser reads both
 * interleaved from one combined stdout/stderr transcript and never throws on
 * unfamiliar output — unrecognized lines are simply not diagnostics.
 *
 * Paths are reported exactly as the engine printed them, which means relative
 * to the compiler's working directory. `LatexBuildService` rebases them onto
 * the workspace root before they reach a client.
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
/** tectonic labels every line it forwards; the label is severity, not path. */
const SEVERITY_PREFIX_PATTERN = /^(error|warning):\s+/iu;

/**
 * Wrapper output that wears the `file:line:` shape without being an error in
 * the document. TeX Live drives its Perl tools through `runscript.tlu`, which
 * reports the exit code of the program it ran — "runscript.tlu:933: command
 * failed with exit code 12: perl.exe …" — at a path inside the distribution.
 * Read as a diagnostic it outranks the engine's own error, names a file no
 * reader can open, and is the last thing anyone needs to know about a missing
 * package.
 */
const WRAPPER_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".tlu", ".lua"]);
const WRAPPER_MESSAGE_PATTERN = /^command failed with exit code/iu;
/**
 * `latexmk`'s closing verdict. It is an error, and it is the summary of one:
 * the reason sits further up, so it is only the headline when nothing else is.
 */
const FATAL_SUMMARY_PATTERN = /^==>\s*Fatal error occurred/iu;

/**
 * Extensions the engine writes itself. A cold build prints `No file main.aux.`
 * on its first pass and then creates it, so reporting these as missing files
 * would put a warning on every first compile of every document.
 */
const GENERATED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".aux",
  ".bbl",
  ".blg",
  ".idx",
  ".lof",
  ".lot",
  ".nav",
  ".out",
  ".snm",
  ".synctex",
  ".toc",
]);

const MAX_DIAGNOSTICS = 200;
const MAX_MESSAGE_LENGTH = 500;

function normalizeEnginePath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** True for the TeX Live script wrappers whose own failures are not the document's. */
function isWrapperScriptPath(rawPath: string): boolean {
  const baseName = (normalizeEnginePath(rawPath).split("/").at(-1) ?? "").toLowerCase();
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && WRAPPER_SCRIPT_EXTENSIONS.has(baseName.slice(dot));
}

/** True for `main.aux` and for compound names like `main.synctex.gz`. */
function isGeneratedArtifactPath(rawPath: string): boolean {
  const baseName = (normalizeEnginePath(rawPath).split("/").at(-1) ?? "").toLowerCase();
  return [...GENERATED_EXTENSIONS].some(
    (extension) => baseName.endsWith(extension) || baseName.includes(`${extension}.`),
  );
}

function clampMessage(message: string): string {
  const collapsed = message.trim().replace(/\s+/gu, " ");
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

function isMessageContinuation(rawLine: string): boolean {
  const line = rawLine.trimStart();
  // Indentation alone is not sufficient: an engine can indent another
  // diagnostic or its own progress note, neither of which belongs to this one.
  if (
    /^(?:error|warning|note|info):\s/iu.test(line) ||
    FILE_LINE_ERROR_PATTERN.test(line) ||
    BARE_ERROR_PATTERN.test(line) ||
    WARNING_PATTERN.test(line) ||
    MISSING_FILE_PATTERN.test(line)
  )
    return false;
  return /^\s{2,}\S/u.test(rawLine) || /^l\.\d+\s/u.test(line) || /^\([\w-]+\)\s+\S/u.test(line);
}

function readMessage(lines: readonly string[], index: number, message: string) {
  while (index + 1 < lines.length && isMessageContinuation(lines[index + 1] ?? "")) {
    index += 1;
    message += ` ${(lines[index] ?? "").trim()}`;
  }
  return { message, index };
}

/** Parses one combined engine transcript, retaining distinct diagnostics in order. */
export function parseLatexLog(transcript: string): LatexDiagnostic[] {
  const diagnostics: LatexDiagnostic[] = [];
  const seen = new Set<string>();
  const addDiagnostic = (diagnostic: LatexDiagnostic) => {
    const message = diagnostic.message.trim().replace(/\s+/gu, " ");
    // Compare the complete message before display truncation. Two different
    // warnings can share the same first 500 characters.
    const key = JSON.stringify([diagnostic.severity, diagnostic.file, diagnostic.line, message]);
    if (seen.has(key)) return;
    if (diagnostics.length === MAX_DIAGNOSTICS) {
      if (diagnostic.severity === "warning") return;
      const warningIndex = diagnostics.findLastIndex((entry) => entry.severity === "warning");
      if (warningIndex === -1) return;
      diagnostics.splice(warningIndex, 1);
    }
    seen.add(key);
    diagnostics.push({ ...diagnostic, message: clampMessage(message) });
  };
  const lines = transcript.split(/\r?\n/u);

  // Continue through the bounded engine transcript: repeats must not consume
  // the budget, and late errors must not be hidden by earlier warnings.
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = (lines[index] ?? "").trimStart();
    // Strip tectonic's label before anything else, so the file capture starts
    // at the path instead of swallowing `error: ` into it.
    const severityPrefix = SEVERITY_PREFIX_PATTERN.exec(rawLine);
    const line = severityPrefix === null ? rawLine : rawLine.slice(severityPrefix[0].length);
    const labelledSeverity =
      severityPrefix?.[1]?.toLowerCase() === "warning" ? ("warning" as const) : ("error" as const);

    const fileLineError = FILE_LINE_ERROR_PATTERN.exec(line);
    if (fileLineError?.[1] !== undefined && fileLineError[2] !== undefined) {
      // The wrapper that ran the engine reports its exit code in this shape.
      // It is not a diagnostic about the document, and taking it as one hides
      // the error that is.
      if (
        isWrapperScriptPath(fileLineError[1]) ||
        WRAPPER_MESSAGE_PATTERN.test((fileLineError[3] ?? "").trim())
      ) {
        continue;
      }
      const continued = readMessage(lines, index, fileLineError[3] ?? "");
      index = continued.index;
      addDiagnostic({
        severity: labelledSeverity,
        file: normalizeEnginePath(fileLineError[1]),
        line: Number.parseInt(fileLineError[2], 10),
        message: continued.message || "TeX error",
      });
      continue;
    }

    const bareError = BARE_ERROR_PATTERN.exec(line);
    if (bareError?.[1] !== undefined) {
      addDiagnostic({
        severity: "error",
        file: null,
        line: null,
        message: bareError[1],
      });
      continue;
    }

    const warning = WARNING_PATTERN.exec(line);
    if (warning?.[1] !== undefined) {
      const continued = readMessage(lines, index, warning[1]);
      index = continued.index;
      const lineMatch = WARNING_LINE_SUFFIX_PATTERN.exec(continued.message);
      addDiagnostic({
        severity: "warning",
        file: null,
        line: lineMatch?.[1] !== undefined ? Number.parseInt(lineMatch[1], 10) : null,
        message: continued.message,
      });
      continue;
    }

    const missingFile = MISSING_FILE_PATTERN.exec(line);
    if (missingFile?.[1] !== undefined && !isGeneratedArtifactPath(missingFile[1])) {
      addDiagnostic({
        severity: "warning",
        file: normalizeEnginePath(missingFile[1]),
        line: null,
        message: `Missing file: ${missingFile[1]}`,
      });
    }
  }

  return diagnostics;
}

/**
 * `latexmk` collects what went wrong under this heading and indents each
 * entry. It is the only thing it prints when it decides not to run the engine
 * at all — "pdflatex: gave an error in previous invocation of latexmk." — and
 * that decision is exactly the case where there is no engine transcript to
 * parse, so this is the reason or there is none.
 */
const ERROR_SUMMARY_HEADING_PATTERN = /^Collected error summary/iu;
const INDENTED_ENTRY_PATTERN = /^\s+(\S.*?)\s*$/u;

/**
 * Lines that are the tooling talking about itself. They are the last thing a
 * failed run prints often enough that a naive "show the tail" would show only
 * these, which is how a build ends up reporting a console code page instead of
 * an error.
 */
const TRANSCRIPT_NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Initial Win CP for/iu,
  /^I changed them all to/iu,
  /^Reverting Windows console CPs/iu,
  /^Rc files read/iu,
  /^NONE$/iu,
  /^Latexmk: This is Latexmk/iu,
  /command failed with exit code/iu,
  /^perl(?:\.exe)?\s/iu,
  /^\[transcript truncated\]$/u,
];

/** How many trailing lines are worth quoting when nothing else identified itself. */
const MAX_TAIL_LINES = 3;

function isTranscriptNoise(line: string): boolean {
  return TRANSCRIPT_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

/** `latexmk`'s own collected error summary, joined, or `null` when it printed none. */
export function latexmkErrorSummary(transcript: string): string | null {
  const lines = transcript.split(/\r?\n/u);
  const entries: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (ERROR_SUMMARY_HEADING_PATTERN.test(line.trim())) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const entry = INDENTED_ENTRY_PATTERN.exec(line);
    if (entry?.[1] === undefined) {
      if (line.trim().length === 0) continue;
      break;
    }
    if (!isTranscriptNoise(entry[1])) entries.push(entry[1]);
  }
  return entries.length === 0 ? null : clampMessage(entries.join(" "));
}

/**
 * The reason a run failed when it left no diagnostic behind.
 *
 * A compile that never reaches TeX has no `file:line:` anywhere in it — the
 * ordinary case is `latexmk` refusing to redo a target it already failed on,
 * which prints its own prose and exits non-zero — and reporting that as
 * nothing at all is how a build tells its reader only that it failed. So the
 * run's own last words are read instead: its collected error summary if it
 * printed one, otherwise the tail of what it did say, otherwise the status it
 * exited with, which is at least true.
 */
export function transcriptFailureDiagnostic(input: {
  readonly transcript: string;
  readonly exitCode: number | null;
}): LatexDiagnostic {
  const message =
    latexmkErrorSummary(input.transcript) ??
    (() => {
      const meaningful = input.transcript
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isTranscriptNoise(line));
      return meaningful.length === 0
        ? null
        : clampMessage(meaningful.slice(-MAX_TAIL_LINES).join(" "));
    })() ??
    (input.exitCode === null
      ? "The LaTeX engine was stopped before it reported anything."
      : `The LaTeX engine exited with status ${String(input.exitCode)} and reported nothing.`);
  return { severity: "error", file: null, line: null, message };
}

/** The one-line failure summary recorded on a stale binding. */
export function summarizeLatexFailure(diagnostics: readonly LatexDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  // "Fatal error occurred, no output PDF file produced" is the run's verdict,
  // not its cause; the cause is an error further up. Say the cause, and fall
  // back to the verdict only when the run left nothing else to say.
  const firstError =
    errors.find((diagnostic) => !FATAL_SUMMARY_PATTERN.test(diagnostic.message)) ?? errors[0];
  if (firstError === undefined) return "LaTeX build failed.";
  const location =
    firstError.file !== null && firstError.line !== null
      ? `${firstError.file}:${firstError.line}: `
      : "";
  return `${location}${firstError.message}`;
}
