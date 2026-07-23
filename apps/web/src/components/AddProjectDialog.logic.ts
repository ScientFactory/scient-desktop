import type { CloneProjectSourceInput, RepositoryProvider } from "@synara/contracts";

export type AddProjectSource = "local" | "git-url" | RepositoryProvider;

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
