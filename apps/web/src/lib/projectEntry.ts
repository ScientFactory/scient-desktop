export interface DroppedProjectFolderData {
  readonly files: Iterable<File>;
  readonly items: Iterable<{
    readonly kind: string;
    getAsFile(): File | null;
    webkitGetAsEntry?: () => { readonly isDirectory: boolean; readonly isFile: boolean } | null;
  }>;
}

export type DroppedProjectFolderResult = { readonly path: string } | { readonly error: string };

export function getAvailableNewFolderName(
  directoryNames: ReadonlyArray<string>,
  baseName = "New folder",
): string {
  const existing = new Set(directoryNames.map((name) => name.toLocaleLowerCase()));
  if (!existing.has(baseName.toLocaleLowerCase())) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function joinProjectPath(basePath: string, childName: string): string {
  const separator = basePath.includes("\\") && !basePath.startsWith("/") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/u, "")}${separator}${childName}`;
}

export function getAvailableNewProjectPath(
  browseDirectoryPath: string,
  directoryNames: ReadonlyArray<string>,
): string {
  return joinProjectPath(browseDirectoryPath, getAvailableNewFolderName(directoryNames));
}

export function resolveDroppedProjectFolder(
  data: DroppedProjectFolderData,
  getPathForFile: (file: File) => string | null,
): DroppedProjectFolderResult {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  const files = Array.from(data.files);
  if (items.length > 1 || files.length > 1) return { error: "Drop one folder at a time." };
  const item = items[0];
  let entry: { readonly isDirectory: boolean; readonly isFile: boolean } | null = null;
  try {
    entry = item?.webkitGetAsEntry?.() ?? null;
  } catch {
    entry = null;
  }
  if (entry?.isFile) return { error: "Drop a folder, not a file." };
  const file = item?.getAsFile() ?? files[0] ?? null;
  if (!file) return { error: "Could not read the dropped folder. Use browse instead." };
  const resolved = getPathForFile(file);
  if (!resolved) return { error: "Could not read the folder path. Use browse instead." };
  if (resolved !== resolved.trim()) {
    return { error: "Folders with names ending in whitespace are not supported." };
  }
  return { path: resolved };
}
