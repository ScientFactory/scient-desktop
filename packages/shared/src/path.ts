export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function isRootPath(value: string): boolean {
  // The drive separator is required: a bare `C:` is not the drive root (it
  // means "current directory on C:"), and treating it as already-canonical
  // would leave it as `C:` while `C:\` and `C:/` normalize to the drive root,
  // so the same location would fail project identity/dedup comparisons.
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

// Windows refuses these as file names, with or without an extension.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/**
 * Folder name for a project started from just a name ("Pinball Stats" becomes
 * "pinball-stats"). The server uses it for `projects.createNew`, and clients
 * use it to show the path before the server makes it.
 */
export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

export function fileBasename(path: string): string {
  // A trailing separator is a valid way to write a directory. Trim it before
  // taking the final segment so the label is never empty.
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

// SCIENT-FORK:START — canonical host paths preserve POSIX filename characters.
const UNC_ROOT_PATTERN = /^\\\\[^\\/]+[\\/][^\\/]+/;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:(?=[\\/])/;

/**
 * Resolves `.` and `..` segments in an absolute host path without climbing
 * above its root, keeping the path's own separator style:
 *
 * - `C:\` and `C:/` drive paths and `\\host\share` UNC paths are Windows
 *   paths, where both separators divide segments;
 * - `/` paths are POSIX paths, where only `/` divides segments and a
 *   backslash is an ordinary filename character.
 *
 * A path starting with exactly `//` is ambiguous (a POSIX path, or a Windows
 * UNC share written with forward slashes) and a relative path has no base
 * here, so both are returned unchanged.
 */
export function collapseAbsoluteFilePath(path: string): string {
  const source = stripSlashPrefixedWindowsDrive(path);
  let root: string;
  let separator: string;
  let splitter: RegExp;
  const unc = source.match(UNC_ROOT_PATTERN);
  const drive = source.match(WINDOWS_DRIVE_ROOT_PATTERN);
  if (unc) {
    separator = "\\";
    splitter = /[\\/]+/;
    root = unc[0].replaceAll("/", "\\");
  } else if (drive) {
    separator = source.charAt(drive[0].length);
    splitter = /[\\/]+/;
    root = `${drive[0]}${separator}`;
  } else if (source.startsWith("/") && !/^\/\/(?!\/)/.test(source)) {
    separator = "/";
    splitter = /\/+/;
    root = "/";
  } else {
    return path;
  }
  const rest = source.slice(unc ? unc[0].length : root.length);
  const segments: string[] = [];
  for (const segment of rest.split(splitter)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  if (unc) return segments.length > 0 ? `${root}\\${segments.join("\\")}` : root;
  return `${root}${segments.join(separator)}`;
}

/**
 * Writes a Windows path (drive or UNC) with `/` separators for comparison. A
 * POSIX path is returned as is: there a backslash is part of a file name.
 */
function portableSeparators(path: string): string {
  return WINDOWS_DRIVE_ROOT_PATTERN.test(path) || path.startsWith("\\\\")
    ? path.replaceAll("\\", "/")
    : path;
}
// SCIENT-FORK:END

/**
 * The path relative to the workspace root, or null when the path is not inside
 * it. Dot segments are resolved first, so `<root>/../notes.md` is correctly
 * outside the workspace rather than the workspace path `../notes.md`.
 */
export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  // SCIENT-FORK:START — resolve dot segments before workspace containment.
  const normalizedPath = portableSeparators(collapseAbsoluteFilePath(path));
  const normalizedRoot = portableSeparators(collapseAbsoluteFilePath(workspaceRoot)).replace(
    /\/+$/,
    "",
  );
  // SCIENT-FORK:END
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (pathForCompare.replace(/\/+$/, "") === rootForCompare) return ".";
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}
