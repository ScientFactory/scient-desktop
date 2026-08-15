/**
 * Resolves which .tex file a build should compile. A `% !TEX root = …` magic
 * comment wins; a file declaring `\documentclass` is its own root; anything
 * else falls back to itself, where the compile error names the real problem.
 * Decisions are pure — callers supply the file's contents.
 */

const MAGIC_ROOT_PATTERN = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/imu;
const DOCUMENTCLASS_PATTERN = /^[^%\r\n]*\\documentclass\b/mu;
const MAGIC_COMMENT_SCAN_LIMIT = 4_000;

export const LATEX_SOURCE_EXTENSIONS = [".tex", ".latex", ".ltx"] as const;

export function isLatexSourcePath(relativePath: string): boolean {
  const cleanPath = relativePath.split(/[?#]/u, 1)[0] ?? "";
  return LATEX_SOURCE_EXTENSIONS.some((extension) => cleanPath.toLowerCase().endsWith(extension));
}

export interface LatexRootResolution {
  /** Workspace-relative path of the root document to compile. */
  readonly rootRelativePath: string;
  readonly reason: "magic-comment" | "documentclass" | "fallback-self";
}

/** Joins a magic-comment root (relative to the declaring file) into a workspace-relative path with forward slashes. */
function joinRelative(fromRelativePath: string, target: string): string {
  const normalizedTarget = target.replaceAll("\\", "/");
  const baseSegments = fromRelativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of normalizedTarget.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (baseSegments.length === 0) return normalizedTarget;
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }
  return baseSegments.join("/");
}

export function resolveLatexRoot(input: {
  readonly relativePath: string;
  readonly contents: string;
}): LatexRootResolution {
  const head = input.contents.slice(0, MAGIC_COMMENT_SCAN_LIMIT);
  const magic = MAGIC_ROOT_PATTERN.exec(head);
  if (magic?.[1] !== undefined) {
    const target = magic[1].replace(/^["']|["']$/gu, "");
    const rootRelativePath = joinRelative(input.relativePath, target);
    if (isLatexSourcePath(rootRelativePath)) {
      return { rootRelativePath, reason: "magic-comment" };
    }
  }
  if (DOCUMENTCLASS_PATTERN.test(input.contents)) {
    return {
      rootRelativePath: input.relativePath.replaceAll("\\", "/"),
      reason: "documentclass",
    };
  }
  return {
    rootRelativePath: input.relativePath.replaceAll("\\", "/"),
    reason: "fallback-self",
  };
}
