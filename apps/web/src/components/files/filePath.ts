import { collapseAbsoluteFilePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath, isAbsolutePath } from "@t3tools/shared/path";

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
  const hostPath = isAbsolutePath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : hostPath && separator === "/" ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => ({
      label: part,
      path: root + parts.slice(0, index + 1).join(separator),
      kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
    })),
  ];
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
