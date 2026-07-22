// FILE: messageArtifacts.ts
// Purpose: Derive reviewable document artifacts from explicit local file links in settled replies.
// Layer: Web chat presentation logic

import { lowerCaseExtensionOf } from "@synara/shared/localPreviewFiles";

import { basenameOfPath } from "../file-icons";
import { resolveMarkdownFileLinkTarget } from "../markdown-links";

export type MessageArtifactKind = "html" | "markdown";

export interface MessageArtifactReference {
  readonly path: string;
  readonly label: string;
  readonly kind: MessageArtifactKind;
}

const DOCUMENT_KIND_BY_EXTENSION: Readonly<Record<string, MessageArtifactKind>> = {
  ".htm": "html",
  ".html": "html",
  ".markdown": "markdown",
  ".md": "markdown",
  ".mdx": "markdown",
};

// This intentionally recognizes only authored Markdown links. Inline code and
// plain path mentions remain lightweight chips; the shelf is reserved for files
// the answer explicitly presents as something the user can open.
const MARKDOWN_LINK_PATTERN =
  /(^|[^!])\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;

function withoutMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function cleanLinkLabel(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\[\]*_~]/g, "")
    .replace(/\\([\\`*{}\[\]()#+.!_-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeFileName(path: string): string {
  const basename = basenameOfPath(path).replace(/:\d+(?::\d+)?$/, "");
  const extension = lowerCaseExtensionOf(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const words = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return basename;
  if (/^[A-Z0-9 ]+$/.test(words)) return words;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeArtifactPath(path: string): string {
  return path.replaceAll("/./", "/").replaceAll("\\.\\", "\\");
}

export function extractMessageArtifacts(
  markdown: string,
  cwd?: string,
): ReadonlyArray<MessageArtifactReference> {
  const artifacts: MessageArtifactReference[] = [];
  const seenPaths = new Set<string>();
  const source = withoutMarkdownCode(markdown);

  for (const match of source.matchAll(MARKDOWN_LINK_PATTERN)) {
    const href = match[3] ?? match[4];
    const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
    if (!targetPath) continue;
    const pathWithoutPosition = normalizeArtifactPath(targetPath.replace(/:\d+(?::\d+)?$/, ""));
    const extension = lowerCaseExtensionOf(pathWithoutPosition);
    const kind = extension ? DOCUMENT_KIND_BY_EXTENSION[extension] : undefined;
    if (!kind || seenPaths.has(pathWithoutPosition)) continue;

    const authoredLabel = cleanLinkLabel(match[2] ?? "");
    const rawFileName = basenameOfPath(pathWithoutPosition);
    const label =
      authoredLabel.length > 0 && authoredLabel !== rawFileName
        ? authoredLabel
        : humanizeFileName(pathWithoutPosition);
    artifacts.push({ path: pathWithoutPosition, label, kind });
    seenPaths.add(pathWithoutPosition);
  }

  return artifacts;
}
