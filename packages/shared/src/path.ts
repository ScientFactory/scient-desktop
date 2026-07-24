// FILE: path.ts
// Purpose: Shared path classification and workspace-relative conversion helpers.
// Layer: Cross-package utility
// Exports: absolute-path predicates plus safe workspace relative path helpers

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isLocalAbsolutePath(
  value: string,
  options: { readonly allowWindowsPaths?: boolean } = {},
): boolean {
  return (
    value.startsWith("/") || ((options.allowWindowsPaths ?? true) && isWindowsAbsolutePath(value))
  );
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

function normalizePathForComparison(value: string): string {
  const withForwardSlashes = value.replace(/\\/g, "/");
  // Normalize the drive letter so "C:/foo" and "c:/foo" compare equal.
  return isWindowsDrivePath(withForwardSlashes)
    ? withForwardSlashes.charAt(0).toLowerCase() + withForwardSlashes.slice(1)
    : withForwardSlashes;
}

// Converts an absolute path inside `workspaceRoot` to its workspace-relative
// form (forward-slash separated). Returns null for the root itself, for paths
// outside the root, and for anything that still fails the relative-path safety
// check (so callers can hand the result straight to workspace file RPCs).
export function workspaceRelativePathOf(targetPath: string, workspaceRoot: string): string | null {
  const normalizedTarget = normalizePathForComparison(targetPath.trim());
  const normalizedRoot = normalizePathForComparison(workspaceRoot.trim()).replace(/\/+$/, "");
  if (normalizedRoot.length === 0 || normalizedTarget.length === 0) {
    return null;
  }
  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return null;
  }
  const relativePath = normalizedTarget.slice(normalizedRoot.length + 1).replace(/\/+$/, "");
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

// Inverse of `workspaceRelativePathOf`: joins a workspace root with a
// forward-slash relative path, matching the root's own separator style so the
// result stays a valid native path on Windows.
export function joinWorkspaceRelativePath(workspaceRoot: string, relativePath: string): string {
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const normalizedRelativePath = relativePath.split("/").join(separator);
  return `${normalizedRoot}${separator}${normalizedRelativePath}`;
}

/**
 * Returns the parent directory of an absolute local path without depending on
 * the host operating system. This matters when a macOS Scient instance is
 * displaying a Windows path from a remote/provider transcript (and vice
 * versa): node:path would otherwise apply only the host's separator rules.
 */
export function parentDirectoryOfLocalPath(value: string): string | null {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!isLocalAbsolutePath(trimmed)) {
    return null;
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separatorIndex < 0) {
    return null;
  }
  if (separatorIndex === 0) {
    return "/";
  }
  // Preserve a Windows drive root (`C:\\`) instead of returning `C:`.
  if (separatorIndex === 2 && isWindowsDrivePath(trimmed)) {
    return trimmed.slice(0, 3);
  }
  return trimmed.slice(0, separatorIndex);
}

// True for workspace-relative paths that cannot escape the workspace root:
// rejects absolute paths (POSIX and Windows) and any "." / ".." segments.
export function isWorkspaceRelativePathSafe(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
    return false;
  }
  return trimmed.split(/[\\/]/).every((segment) => segment !== ".." && segment !== ".");
}
