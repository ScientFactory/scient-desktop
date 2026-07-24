import type { CloneProjectSourceInput, RepositoryProvider } from "@synara/contracts";

import {
  resolveDroppedFileAbsolutePath,
  type ComposerDroppedFileItem,
} from "~/lib/composerDropPaths";

export type AddProjectSource = "local" | "git-url" | RepositoryProvider;

export type DroppedProjectFolderResult =
  | { readonly path: string; readonly requiresDirectoryValidation?: true }
  | { readonly error: string };

export interface ProjectFolderDataTransfer {
  readonly items: Iterable<ComposerDroppedFileItem>;
  readonly files: Iterable<File>;
}

export function isProjectFolderDrag(types: Iterable<string>): boolean {
  return Array.from(types).includes("Files");
}

function getDroppedItemKind(
  item: ComposerDroppedFileItem | undefined,
): "directory" | "file" | "unknown" {
  if (!item || typeof item.webkitGetAsEntry !== "function") {
    return "unknown";
  }
  try {
    const entry = item.webkitGetAsEntry();
    if (!entry) return "unknown";
    return entry.isDirectory === true ? "directory" : "file";
  } catch {
    return "unknown";
  }
}

export function canAcceptProjectFolderDrop(dataTransfer: ProjectFolderDataTransfer): boolean {
  const fileItems = Array.from(dataTransfer.items).filter((item) => item.kind === "file");
  const files = Array.from(dataTransfer.files);
  if (fileItems.length > 1 || files.length > 1) return false;

  // Finder and some Electron/Chromium versions withhold both File objects and
  // webkit entries until `drop`. Keep the surface receptive while the payload
  // is opaque, then validate the resolved path before opening it.
  return getDroppedItemKind(fileItems[0]) !== "file";
}

function getDroppedProjectFile(
  item: ComposerDroppedFileItem | undefined,
  files: Iterable<File>,
): File | null {
  try {
    return item?.getAsFile() ?? Array.from(files)[0] ?? null;
  } catch {
    return Array.from(files)[0] ?? null;
  }
}

export function resolveDroppedProjectFolder(
  dataTransfer: ProjectFolderDataTransfer,
): DroppedProjectFolderResult {
  const fileItems = Array.from(dataTransfer.items).filter((item) => item.kind === "file");
  const files = Array.from(dataTransfer.files);
  if (fileItems.length > 1 || files.length > 1) {
    return { error: "Drop one folder at a time." };
  }

  const item = fileItems[0];
  const file = getDroppedProjectFile(item, files);
  if (!file) {
    return { error: "Could not read the dropped folder. Use browse below instead." };
  }
  const itemKind = getDroppedItemKind(item);
  if (itemKind === "file") {
    return { error: "Drop a folder, not a file." };
  }

  const absolutePath = resolveDroppedFileAbsolutePath(file);
  if (!absolutePath) {
    return { error: "Could not read the folder's path. Use browse below instead." };
  }
  if (absolutePath !== absolutePath.trim()) {
    return {
      error:
        "Folders with names ending in whitespace are not supported. Rename the folder and try again.",
    };
  }
  return itemKind === "unknown"
    ? { path: absolutePath, requiresDirectoryValidation: true }
    : { path: absolutePath };
}

export function inferCloneDirectoryName(source: AddProjectSource, value: string): string {
  const trimmed = value
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "");
  if (!trimmed) return "repository";
  if (source === "git-url") {
    const scpPath = trimmed.match(/^[^/@:]+@[^/:]+:(.+)$/)?.[1];
    const pathValue =
      scpPath ??
      (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return trimmed;
        }
      })();
    return pathValue.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "repository";
  }
  return trimmed.split("/").findLast((segment) => segment.length > 0) ?? "repository";
}

export function joinProjectPath(basePath: string, childName: string): string {
  const separator = basePath.includes("\\") && !basePath.startsWith("/") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${childName}`;
}

export function getAvailableNewFolderName(
  directoryNames: readonly string[],
  baseName = "New folder",
): string {
  // Avoid a name that collides on case-insensitive filesystems as well as on Linux.
  const existingNames = new Set(directoryNames.map((name) => name.toLowerCase()));
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

export function buildCloneProjectSourceInput(input: {
  source: Exclude<AddProjectSource, "local">;
  repositoryInput: string;
  destinationPath: string;
}): CloneProjectSourceInput {
  return input.source === "git-url"
    ? {
        source: "git-url",
        remoteUrl: input.repositoryInput.trim(),
        destinationPath: input.destinationPath,
      }
    : {
        source: input.source,
        repository: input.repositoryInput.trim(),
        destinationPath: input.destinationPath,
      };
}
