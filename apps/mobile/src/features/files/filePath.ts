import { collapseAbsoluteFilePath } from "@t3tools/client-runtime/markdown-links";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";

export interface FileBreadcrumb {
  readonly label: string;
  readonly path: string;
  readonly kind: "project" | "directory" | "file";
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** A file route holding an absolute path shows a host file outside the workspace. */
export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

/** Route segments that `normalizeRoutePath` joins back into the same path, root included. */
export function fileRoutePathSegments(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return path.startsWith("/") ? ["", ...segments] : segments;
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /^[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function resolveWorkspaceFilePath(cwd: string, relativePath: string): string {
  if (isAbsolutePath(relativePath)) {
    return relativePath;
  }

  const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
  return joinPath(cwd, relativePath, separator);
}

function normalizeRelativePath(value: string): string | null {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

export function resolveWorkspaceRelativeFilePath(
  workspaceRoot: string | null | undefined,
  targetPath: string,
): string | null {
  if (!isAbsolutePath(targetPath)) {
    if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
      return null;
    }
    return normalizeRelativePath(targetPath);
  }
  if (!workspaceRoot) {
    return null;
  }

  const normalizedTarget = targetPath.replaceAll("\\", "/");
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const caseInsensitive = isWindowsAbsolutePath(targetPath) || isWindowsAbsolutePath(workspaceRoot);
  const comparableTarget = caseInsensitive ? normalizedTarget.toLowerCase() : normalizedTarget;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!comparableTarget.startsWith(`${comparableRoot}/`)) {
    return null;
  }

  const relativePath = normalizedTarget.slice(normalizedRoot.length + 1);
  // `/repo/../x` starts with the root but escapes it.
  if (relativePath.split("/").includes("..")) {
    return null;
  }
  return normalizeRelativePath(relativePath);
}

/**
 * The absolute host path a file link names when it is not a workspace file:
 * an absolute path as written, or a relative path that climbs above the
 * workspace root. Such a file opens read-only in the file screen, like any
 * other host file. Returns null when the link cannot be placed on the host.
 */
export function resolveHostFilePath(
  workspaceRoot: string | null | undefined,
  targetPath: string,
): string | null {
  if (isAbsolutePath(targetPath)) return collapseAbsoluteFilePath(targetPath);
  if (!workspaceRoot || targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return null;
  }
  return collapseAbsoluteFilePath(resolveWorkspaceFilePath(workspaceRoot, targetPath));
}

/**
 * Where a file link opens: the workspace file it names (editable), or the host
 * file it names when it lies outside the workspace (read-only). A path that
 * leaves and re-enters the workspace is a workspace file. Null when the link
 * cannot be placed at all, such as a home-relative path.
 */
export function resolveFileLinkTarget(
  workspaceRoot: string | null | undefined,
  targetPath: string,
): { readonly kind: "workspace" | "host"; readonly path: string } | null {
  const workspacePath = resolveWorkspaceRelativeFilePath(workspaceRoot, targetPath);
  if (workspacePath !== null) return { kind: "workspace", path: workspacePath };
  const hostPath = resolveHostFilePath(workspaceRoot, targetPath);
  if (hostPath === null) return null;
  const reentered = resolveWorkspaceRelativeFilePath(workspaceRoot, hostPath);
  return reentered !== null
    ? { kind: "workspace", path: reentered }
    : { kind: "host", path: hostPath };
}

export function isVideoPreviewFile(path: string): boolean {
  return isWorkspaceVideoPreviewPath(path);
}

export function isAudioPreviewFile(path: string): boolean {
  return isWorkspaceAudioPreviewPath(path.split(/[?#]/, 1)[0] ?? "");
}

export function isSvgImagePreviewFile(path: string): boolean {
  return /\.svg$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function isMarkdownPreviewFile(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const parts = relativePath.split("/").filter(Boolean);
  return [
    { label: projectName, path: "", kind: "project" },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
      kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
}

/**
 * The location line under a file's name: `project · parent/dir`. A host file outside the
 * workspace is not under the project, so it shows its directory alone.
 */
export function fileHeaderSubtitle(projectName: string, relativePath: string): string {
  const parentDir = relativePath.slice(
    0,
    Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"), 0),
  );
  return isAbsolutePath(relativePath)
    ? parentDir
    : [projectName, parentDir].filter(Boolean).join(" · ");
}
