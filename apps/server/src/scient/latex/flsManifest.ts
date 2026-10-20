/**
 * Reads which files a compile actually opened out of the engine's own recorder
 * output.
 *
 * `latexmk` runs the engine with `-recorder`, which writes `<jobname>.fls` next
 * to the other aux files; Tectonic exposes the same boundary as Make rules.
 * Those engine-produced lists are the only
 * trustworthy answer to "what was this PDF built from" — a preamble scan sees
 * one level of `\input` and no `.bib`, no image, no class file, and no file a
 * package pulled in — which is what makes it the right basis for deciding
 * whether a published PDF still matches its sources.
 *
 * Nothing here reads a file or decides anything: it turns recorder text into
 * workspace-relative paths, and the caller decides what to do with them. Two
 * whole categories are dropped on the way out, because neither is an input the
 * user can edit:
 *   - anything outside the workspace root — the TeX distribution's own class,
 *     package, and font files, which change only when the distribution does;
 *   - anything inside the build work directory — the `.aux`, `.out`, and `.toc`
 *     files this very run wrote and then read back, which are outputs wearing
 *     an `INPUT` label and would make every document permanently out of date.
 */

/** Above this the manifest is not evidence, it is a liability; see `truncated`. */
export const MAX_RECORDER_DEPENDENCIES = 256;

export interface LatexRecorderManifest {
  /** Workspace-relative, forward-slash, deduplicated, sorted. */
  readonly dependencies: ReadonlyArray<string>;
  /**
   * The run named more workspace inputs than the cap allows, so `dependencies`
   * is empty and the caller must fall back to evidence it can stand behind
   * rather than to a truncated list that would claim more than it checks.
   */
  readonly truncated: boolean;
}

function boundedManifest(
  dependencies: ReadonlySet<string>,
  structurallyComplete: boolean,
): LatexRecorderManifest {
  // A successful compile necessarily reads at least its root source. An empty
  // set therefore means the recorder is absent, malformed, or only partly
  // written. Keep that distinct from a genuinely complete single-file build:
  // the latter contains the root and is validated by the caller.
  if (!structurallyComplete || dependencies.size === 0) {
    return { dependencies: [], truncated: true };
  }
  if (dependencies.size > MAX_RECORDER_DEPENDENCIES) {
    return { dependencies: [], truncated: true };
  }
  return { dependencies: [...dependencies].sort(), truncated: false };
}

const INPUT_LINE_PATTERN = /^INPUT\s+(.+?)\s*$/u;
const OUTPUT_LINE_PATTERN = /^OUTPUT\s+(.+?)\s*$/u;
const PWD_LINE_PATTERN = /^PWD\s+(.+?)\s*$/u;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:\//u;

/** `/home/u/paper`, `C:/work/paper`, `//server/share` — never `C:paper`. */
function isAbsolutePosixPath(pathText: string): boolean {
  return pathText.startsWith("/") || WINDOWS_ABSOLUTE_PATTERN.test(pathText);
}

function splitRoot(pathText: string): readonly [string, string] {
  if (pathText.startsWith("//")) return ["//", pathText.slice(2)];
  if (pathText.startsWith("/")) return ["/", pathText.slice(1)];
  if (WINDOWS_ABSOLUTE_PATTERN.test(pathText)) {
    return [pathText.slice(0, 3), pathText.slice(3)];
  }
  return ["", pathText];
}

/**
 * Collapses `.` and `..` and repeated separators without touching the disk.
 * `path.resolve` would answer against this process's own cwd, which is not the
 * directory the engine ran in.
 */
export function normalizePosixPath(pathText: string): string {
  const posix = pathText.replaceAll("\\", "/");
  const [root, body] = splitRoot(posix);
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    const last = segments.at(-1);
    if (last !== undefined && last !== "..") {
      segments.pop();
      continue;
    }
    // A parent walk above an absolute root has nowhere to go and is dropped.
    if (root === "") segments.push("..");
  }
  return root + segments.join("/");
}

/** Absolute paths stand; everything else is read against the run's own cwd. */
function resolveAgainst(base: string, target: string): string {
  const posix = target.replaceAll("\\", "/");
  return isAbsolutePosixPath(posix)
    ? normalizePosixPath(posix)
    : normalizePosixPath(`${base}/${posix}`);
}

/**
 * `target` expressed relative to `root`, or `null` when it does not live under
 * it. Windows drive paths compare case-insensitively because a recorder may
 * print a different spelling of the drive and directory names. POSIX paths do
 * not: `/Workspace` and `/workspace` can be different directories, and folding
 * their case would admit a sibling tree as if it were inside the workspace.
 */
function relativeInside(root: string, target: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  const caseInsensitive = WINDOWS_ABSOLUTE_PATTERN.test(root) || root.startsWith("//");
  const contained = caseInsensitive
    ? target.toLowerCase().startsWith(base.toLowerCase())
    : target.startsWith(base);
  return contained ? target.slice(base.length) : null;
}

export function parseLatexRecorderManifest(input: {
  readonly contents: string;
  /** Absolute workspace root; only files under it are the user's own inputs. */
  readonly workspaceRoot: string;
  /** Where the engine ran, used for the relative paths a recorder may print. */
  readonly compileDirectory: string;
  /** The Scient-owned aux directory, whose contents are this run's outputs. */
  readonly workDirectory: string;
}): LatexRecorderManifest {
  const workspaceRoot = normalizePosixPath(input.workspaceRoot);
  const workDirectory = normalizePosixPath(input.workDirectory);
  let pwd = normalizePosixPath(input.compileDirectory);
  const dependencies = new Set<string>();
  let sawInputRecord = false;
  let sawOutputRecord = false;

  for (const rawLine of input.contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const pwdLine = PWD_LINE_PATTERN.exec(line);
    if (pwdLine?.[1] !== undefined) {
      pwd = normalizePosixPath(pwdLine[1]);
      continue;
    }
    if (OUTPUT_LINE_PATTERN.test(line)) {
      sawOutputRecord = true;
      continue;
    }
    const inputLine = INPUT_LINE_PATTERN.exec(line);
    if (inputLine?.[1] === undefined) continue;
    sawInputRecord = true;
    const absolutePath = resolveAgainst(pwd, inputLine[1]);
    // Outputs this run read back are not inputs, whatever the label says.
    if (relativeInside(workDirectory, absolutePath) !== null) continue;
    const relativePath = relativeInside(workspaceRoot, absolutePath);
    if (relativePath === null || relativePath.length === 0) continue;
    dependencies.add(relativePath);
  }

  return boundedManifest(dependencies, sawInputRecord && sawOutputRecord);
}

/** Split the dependency side of one make rule without losing escaped spaces or Windows slashes. */
function makefileWords(source: string): ReadonlyArray<string> {
  const words: string[] = [];
  let word = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "#") break;
    if (/\s/u.test(character)) {
      if (word.length > 0) words.push(word);
      word = "";
      continue;
    }
    if (character !== "\\") {
      word += character;
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) {
      word += "\\";
      continue;
    }
    if (/\s/u.test(next) || next === "#" || next === ":" || next === "\\") {
      word += next;
      index += 1;
    } else {
      // A literal Windows separator, not a Make escape.
      word += "\\";
    }
  }
  if (word.length > 0) words.push(word);
  return words;
}

/**
 * Tectonic's `--makefile-rules` is its recorder: targets precede ` : ` and the
 * exact files read by the run follow it, with ordinary Make escaping and line
 * continuations. Normalize it through the same workspace/work-directory
 * boundary as latexmk's `.fls` output.
 */
export function parseTectonicMakefileRules(input: {
  readonly contents: string;
  readonly workspaceRoot: string;
  readonly compileDirectory: string;
  readonly workDirectory: string;
}): LatexRecorderManifest {
  const workspaceRoot = normalizePosixPath(input.workspaceRoot);
  const workDirectory = normalizePosixPath(input.workDirectory);
  const dependencies = new Set<string>();
  let sawRule = false;
  const logicalLines = input.contents.replace(/\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u);
  for (const line of logicalLines) {
    const separator = /\s+:\s+/u.exec(line);
    if (separator === null) continue;
    const targets = makefileWords(line.slice(0, separator.index));
    const dependencyText = line.slice(separator.index + separator[0].length);
    const dependencyWords = makefileWords(dependencyText);
    if (targets.length === 0 || dependencyWords.length === 0) continue;
    sawRule = true;
    for (const dependency of dependencyWords) {
      let absolutePath = resolveAgainst(input.compileDirectory, dependency);
      const workRelative = relativeInside(workDirectory, absolutePath);
      if (workRelative !== null) {
        // Tectonic reports project inputs as if they lived under `--outdir`
        // (for example `out/sections/intro.tex`) even though it read them from
        // the compile directory. With `--keep-intermediates`, run-owned files
        // are Make targets rather than dependencies, so every word on this
        // side is a source input and can be rebased without an extension
        // blacklist that would silently omit a legitimate `.out`/`.aux` file.
        absolutePath = resolveAgainst(input.compileDirectory, workRelative);
      }
      const relativePath = relativeInside(workspaceRoot, absolutePath);
      if (relativePath === null || relativePath.length === 0) continue;
      dependencies.add(relativePath);
    }
  }
  return boundedManifest(dependencies, sawRule);
}
