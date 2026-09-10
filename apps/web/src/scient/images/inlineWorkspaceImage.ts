import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import { resolveMarkdownFileLinkMeta } from "~/markdown-links";

export interface InlineWorkspaceImageDescriptor {
  readonly absolutePath: string;
  readonly alt: string;
  readonly displayPath: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly source: string;
  readonly workspaceRoot: string;
}

const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sourcePath(src: string): string {
  const normalized = src.trim();
  const unwrapped =
    normalized.startsWith("<") && normalized.endsWith(">") ? normalized.slice(1, -1) : normalized;
  return safeDecode(unwrapped.split(/[?#]/u, 1)[0] ?? unwrapped);
}

function normalizeWorkspaceRelativePath(value: string): string | null {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/** Join a normalized workspace-relative path without interpreting shell syntax. */
export function joinWorkspaceImagePath(workspaceRoot: string, relativePath: string): string {
  const separator = WINDOWS_ABSOLUTE_PATH.test(workspaceRoot) ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/u, "")}${separator}${relativePath.replaceAll(
    "/",
    separator,
  )}`;
}

export function resolveInlineWorkspaceImage(input: {
  readonly alt?: string | undefined;
  readonly cwd?: string | undefined;
  readonly src?: string | undefined;
}): InlineWorkspaceImageDescriptor | null {
  if (!input.cwd || !input.src) return null;

  const file = resolveMarkdownFileLinkMeta(input.src, input.cwd);
  const rawSourcePath = sourcePath(input.src);
  const sourceIsAbsoluteOrExternal =
    rawSourcePath.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(rawSourcePath) ||
    URI_SCHEME.test(rawSourcePath);
  const relativePath = normalizeWorkspaceRelativePath(
    file?.workspaceRelativePath ?? (sourceIsAbsoluteOrExternal ? "" : rawSourcePath),
  );
  if (!relativePath || !isWorkspaceImagePreviewPath(relativePath)) return null;

  const fileName = relativePath.split("/").at(-1) ?? relativePath;

  const alt = input.alt?.trim();
  return {
    absolutePath: joinWorkspaceImagePath(input.cwd, relativePath),
    alt: alt || fileName,
    displayPath: relativePath,
    fileName,
    relativePath,
    source: input.src,
    workspaceRoot: input.cwd,
  };
}

export function inlineWorkspaceImageResource(
  image: InlineWorkspaceImageDescriptor,
  threadRef: ScopedThreadRef,
): Extract<AssetResource, { readonly _tag: "workspace-file" }> {
  return {
    _tag: "workspace-file",
    cwd: image.workspaceRoot,
    relativePath: image.relativePath,
    // Keep the legacy locator during client/server version skew. It is access
    // context only; the rooted locator remains the stable document location.
    threadId: threadRef.threadId,
    path: image.absolutePath,
  };
}

export function inlineImageFormatLabel(fileName: string): string {
  const extension = fileName.split(/[?#]/u, 1)[0]?.split(".").at(-1)?.toLowerCase();
  if (!extension || extension === fileName.toLowerCase()) return "Image";
  if (extension === "jpg" || extension === "jpeg") return "JPEG";
  return extension.toUpperCase();
}

export function inlineWorkspaceImageMarkdownSource(
  alt: string,
  src: string,
  title?: string | undefined,
): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const destination = /\s/u.test(src) ? `<${src.replaceAll(">", "%3E")}>` : src;
  const normalizedTitle = title?.replace(/\s+/gu, " ").trim();
  const serializedTitle = normalizedTitle
    ? ` "${normalizedTitle.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : "";
  return `![${escapedAlt}](${destination}${serializedTitle})`;
}
