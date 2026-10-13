import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  collapseAbsoluteFilePath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/shared/path";

const PATH_START = /^(?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/u;
const KEPT_SEGMENTS = 2;

/** A recorded tool path, shortened for its row and retained for hover and inspection. */
export function tracePathPresentation(path: string, workspaceRoot: string | undefined) {
  const position = splitFilePathPosition(path.trim());
  const authored = stripSlashPrefixedWindowsDrive(position.path);
  const homeRelative = /^~[\\/]/u.test(authored);
  const absolute = authored.startsWith("/") || isWindowsAbsolutePath(authored);
  const windows =
    isWindowsAbsolutePath(authored) ||
    /^(?:~|\.{1,2})\\/u.test(authored) ||
    (!absolute &&
      !homeRelative &&
      workspaceRoot !== undefined &&
      isWindowsAbsolutePath(workspaceRoot));
  const separator = windows && workspaceRoot?.includes("\\") ? "\\" : "/";
  const root = workspaceRoot?.replace(windows ? /[\\/]+$/u : /\/+$/u, "");
  const resolved =
    !absolute && !homeRelative && workspaceRoot
      ? collapseAbsoluteFilePath(`${root}${separator}${authored}`)
      : authored;
  const segments = authored
    .split(windows ? /[\\/]/u : /\//u)
    .filter((segment) => segment !== "" && segment !== ".");
  const labelPath = segments.slice(-KEPT_SEGMENTS).join("/") || authored;
  return {
    label: formatFilePathPosition({ ...position, path: labelPath }),
    fullPath: formatFilePathPosition({ ...position, path: resolved }),
  };
}

/** Only literal path details are eligible; diagnostics and file bodies keep their text. */
export function compactPathPresentation(text: string, workspaceRoot: string | undefined) {
  const trimmed = text.trim();
  return PATH_START.test(trimmed) && !/[\r\n]/u.test(trimmed)
    ? tracePathPresentation(trimmed, workspaceRoot)
    : undefined;
}

/**
 * A collapsed trace row names a file by its last two path segments
 * (`Layers/ProviderCommandReactor.ts`), not its full path. Text that is not a
 * single path is returned unchanged; the full path stays in the expanded row.
 */
export function compactPathLabel(text: string, workspaceRoot: string | undefined): string {
  return compactPathPresentation(text, workspaceRoot)?.label ?? text;
}
