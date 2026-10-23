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
 * The host path of a file named by a file tab or a workspace locator: an
 * absolute path as it is, a workspace path joined to the workspace root.
 *
 * A locator is never a link. A workspace folder really named `~` yields the
 * locator `~/notes.md`, which must stay under the workspace root; expanding it
 * as a home-relative link would name a different file. Links are placed before
 * they become locators.
 */
export function workspaceFileHostPath(path: string, workspaceRoot: string): string {
  if (!workspaceRoot || isAbsolutePath(path)) return path;
  const windowsRoot = isWindowsAbsolutePath(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  // On POSIX a trailing backslash is part of the folder's name, not a separator.
  const root = workspaceRoot.replace(windowsRoot ? /[\\/]+$/ : /\/+$/, "");
  return windowsRoot ? `${root}\\${path.replaceAll("/", "\\")}` : `${root}/${path}`;
}

/**
 * The path a file tab actually reads. A workspace-relative path that climbs
 * out of the workspace (`../notes.md`, including tabs saved before links were
 * resolved) names a host file, so it becomes that absolute path and opens
 * read-only like any other file outside the project. Paths inside the
 * workspace are returned unchanged.
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
 * Tab titles for open files. A title is the file's name; when several open
 * files share a name, each also gets the shortest run of parent folders that
 * tells it apart from the others (`plan.md — a`, `plan.md — b`). A file with
 * no parent folder left to show keeps its bare name, and two tabs on the very
 * same path cannot be told apart by path at all.
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
      titles.set(file.path, folders.length === 0 ? name : `${name} — ${folders.join("/")}`);
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
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/**
 * `relativePath` written the way its own crumb names it, so a link with a
 * trailing or repeated separator still finds its crumb.
 */
export function breadcrumbPathOf(relativePath: string): string {
  return fileBreadcrumbs("", relativePath).at(-1)?.path ?? relativePath;
}

/**
 * Whether a host folder crumb names a directory the server can list. A UNC
 * server (`\\server`) is not one; its shares (`\\server\share`) are.
 */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

/** Index of `path`'s crumb among `trail`'s crumbs; -1 when the trail does not pass through it. */
function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/**
 * The deepest path the breadcrumbs keep showing after the browser moves to `path`.
 * Going up keeps the folders below visible so the way back down is one click;
 * moving anywhere else starts over at `path`.
 */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

/** The entry of `folder` that leads toward `trail`; null when the trail ends at the folder. */
export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

/**
 * A host path for `relativePath` (as a host folder's listing names it, with `/`)
 * inside host folder `folder`, using the folder's own separator.
 */
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
