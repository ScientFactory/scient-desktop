/**
 * Reads which files a compile actually opened out of the engine's own recorder
 * output.
 *
 * `latexmk` runs the engine with `-recorder`, which writes `<jobname>.fls` next
 * to the other aux files: a `PWD` line, then one `INPUT`/`OUTPUT` line per file
 * the run touched, in the order it touched them. That list is the only
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

const INPUT_LINE_PATTERN = /^INPUT\s+(.+?)\s*$/u;
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
 * it. The prefix comparison is case-insensitive because a Windows recorder
 * prints whatever case the lookup used and `C:/Work` and `c:/work` are the same
 * directory; the returned path keeps the case the recorder printed, which is
 * the case on disk.
 */
function relativeInside(root: string, target: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  return target.toLowerCase().startsWith(base.toLowerCase()) ? target.slice(base.length) : null;
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

  for (const rawLine of input.contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const pwdLine = PWD_LINE_PATTERN.exec(line);
    if (pwdLine?.[1] !== undefined) {
      pwd = normalizePosixPath(pwdLine[1]);
      continue;
    }
    const inputLine = INPUT_LINE_PATTERN.exec(line);
    if (inputLine?.[1] === undefined) continue;
    const absolutePath = resolveAgainst(pwd, inputLine[1]);
    // Outputs this run read back are not inputs, whatever the label says.
    if (relativeInside(workDirectory, absolutePath) !== null) continue;
    const relativePath = relativeInside(workspaceRoot, absolutePath);
    if (relativePath === null || relativePath.length === 0) continue;
    dependencies.add(relativePath);
  }

  if (dependencies.size > MAX_RECORDER_DEPENDENCIES) {
    return { dependencies: [], truncated: true };
  }
  return { dependencies: [...dependencies].sort(), truncated: false };
}
