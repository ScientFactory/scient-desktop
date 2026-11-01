import { collapseAbsoluteFilePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { ProjectEntry } from "@t3tools/contracts";
import { isAbsolutePath, isWindowsAbsolutePath, isHostPath } from "@t3tools/shared/path";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

/**
 * Locators are not links: a workspace folder named ~ must stay workspace-relative.
 * Expand home-relative links before converting them to locators.
 */
export function workspaceFileHostPath(path: string, workspaceRoot: string): string {
  if (!workspaceRoot || isAbsolutePath(path)) return path;
  const windowsRoot = isWindowsAbsolutePath(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  // On POSIX a trailing backslash is part of the folder's name, not a separator.
  const root = workspaceRoot.replace(windowsRoot ? /[\\/]+$/ : /\/+$/, "");
  return windowsRoot ? `${root}\\${path.replaceAll("/", "\\")}` : `${root}/${path}`;
}

/**
 * Workspace-relative paths escaping via .. become absolute host paths and open read-only,
 * including tabs saved before link resolution. Keep paths within the workspace unchanged.
 */
export function resolveFileTabPath(path: string, workspaceRoot: string): string {
  if (!workspaceRoot || isAbsolutePath(path)) return path;
  const windowsRoot = isWindowsAbsolutePath(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  const separator = windowsRoot ? "\\" : "/";
  // On POSIX a trailing backslash is part of the folder's name, not a separator.
  const root = workspaceRoot.replace(windowsRoot ? /[\\/]+$/ : /\/+$/, "");
  const hostPath = collapseAbsoluteFilePath(`${root}${separator}${path}`);
  return workspaceRelativeFilePath(hostPath, workspaceRoot) === null ? hostPath : path;
}

/**
 * A path's parts. The first part of an absolute path keeps its root, so
 * `/tmp/report.md` on the host and `tmp/report.md` in the workspace never
 * look like the same folder.
 */
function pathSegments(path: string): string[] {
  // Only a Windows path separates with backslashes; on POSIX one is part of a name.
  const windowsPath = isWindowsAbsolutePath(path) || path.startsWith("\\\\");
  const segments = path.split(windowsPath ? /[\\/]/ : "/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return segments;
  const root = path.startsWith("\\\\") ? "\\\\" : path.startsWith("/") ? "/" : "";
  return root === "" ? segments : [`${root}${first}`, ...segments.slice(1)];
}

/**
 * Disambiguate equal filenames with the shortest distinguishing parent suffix.
 * Identical paths or paths with no remaining parent cannot be distinguished further.
 */
export function fileTabTitles(paths: ReadonlyArray<string>): Map<string, string> {
  const titles = new Map<string, string>();
  const byName = new Map<string, Array<{ path: string; parents: string[] }>>();
  for (const path of new Set(paths)) {
    const segments = pathSegments(path);
    const name = segments.at(-1) ?? path;
    const group = byName.get(name) ?? [];
    group.push({ path, parents: segments.slice(0, -1) });
    byName.set(name, group);
  }
  for (const [name, group] of byName) {
    for (const file of group) {
      const others = group.filter((other) => other !== file);
      let depth = others.length === 0 ? 0 : 1;
      // Grow the shown folders until no other file ends in the same ones.
      while (
        depth < file.parents.length &&
        others.some(
          (other) => other.parents.slice(-depth).join("/") === file.parents.slice(-depth).join("/"),
        )
      ) {
        depth += 1;
      }
      const folders = depth === 0 ? [] : file.parents.slice(-depth);
      titles.set(file.path, folders.length === 0 ? name : `${name} (${folders.join("/")})`);
    }
  }
  return titles;
}

/**
 * Crumbs for a workspace-relative path start at the project. An absolute host
 * path is outside the workspace, so its crumbs start at the filesystem root.
 */
export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isHostPath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        // A bare `~` is not a host path; the home folder is `~/`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : hostPath && path === "~" ? "~/" : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/** Use the crumb's path spelling so trailing or repeated separators still match. */
export function breadcrumbPathOf(relativePath: string): string {
  return fileBreadcrumbs("", relativePath).at(-1)?.path ?? relativePath;
}

/** UNC servers are not listable directories; their shares are. */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/** Retain descendant crumbs when navigating up; other navigation resets the trail to path. */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

export function joinHostPath(folder: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(folder) ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return base + relativePath.split("/").join(separator);
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}
