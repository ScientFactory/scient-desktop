import { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  collapseAbsoluteFilePath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/shared/path";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";

import type { WorkLogEntry } from "../../session-logic";

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

/** A trace heading's path, shortened, with its full path and the surrounding action text. */
export interface TraceEntryPathPresentation {
  label: string;
  fullPath: string;
  prefix: string;
  suffix: string;
  text: string;
}

/**
 * The path that owns a trace heading, with its surrounding action text: "Read "
 * before a read file, " +N more" after the first of several. `readRawPaths` is
 * the host's reading of the paths a read tool recorded.
 */
export function traceEntryPathPresentation(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  readRawPaths: (entry: WorkLogEntry) => readonly string[],
): TraceEntryPathPresentation | undefined {
  if (entry.itemType === "reasoning" || entry.tone === "thinking" || entry.command?.trim()) {
    return undefined;
  }
  const action = toolGroupAction(entry);
  const paths = action === "read" ? readRawPaths(entry) : (entry.changedFiles ?? []);
  const detail = entry.detail?.trim();
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  if (
    action !== "read" &&
    item?.type === "dynamic_tool" &&
    dynamicToolTitle(item.toolName, item.input)
  ) {
    return undefined;
  }
  const path =
    action !== "read" && detail && !providerRetry
      ? compactPathPresentation(detail, workspaceRoot)
      : paths[0]
        ? tracePathPresentation(paths[0], workspaceRoot)
        : undefined;
  if (!path) return undefined;
  const prefix = action === "read" ? "Read " : "";
  const suffix =
    paths.length > 1 && (action === "read" || !detail || providerRetry)
      ? ` +${paths.length - 1} more`
      : "";
  return { ...path, prefix, suffix, text: `${prefix}${path.label}${suffix}` };
}
