/**
 * The Markdown writer: a conversation document bundle as a `.md` file. Text
 * only lists attachments by name; the packaged form points at
 * `attachments/…` inside the same `.zip`.
 */
import { DOCUMENT_ASSET_URL_PREFIX, type ConversationMarkdownPackaging } from "@t3tools/contracts";
import type { Image, Link } from "mdast";

import type { ConversationDocumentBundle } from "./conversationDocument.ts";
import { formatFrontMatter } from "./conversationMarkdown.ts";
import {
  applyEdits,
  escapeMarkdownText,
  nodeRange,
  parseMarkdown,
  visitNodes,
  type SourceEdit,
} from "./markdownAst.ts";

/** A relative link to a package file; a lone surrogate never makes encoding throw. */
function encodePackagePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment.toWellFormed()))
    .join("/");
}

/** Resolves `scient-asset:` destinations for the chosen packaging. */
export function resolveAssetLinks(
  markdown: string,
  bundle: ConversationDocumentBundle,
  packaging: ConversationMarkdownPackaging,
): string {
  if (!markdown.includes(DOCUMENT_ASSET_URL_PREFIX)) return markdown;
  const assets = new Map(bundle.assets.map((asset) => [asset.id, asset]));
  const root = parseMarkdown(markdown);
  const edits: SourceEdit[] = [];
  visitNodes(root, (node) => {
    if (node.type !== "link" && node.type !== "image") return;
    const url = (node as Link | Image).url;
    if (!url.startsWith(DOCUMENT_ASSET_URL_PREFIX)) return;
    const range = nodeRange(node);
    const asset = assets.get(url.slice(DOCUMENT_ASSET_URL_PREFIX.length));
    if (!range || !asset) return;
    if (packaging === "with-attachments" && asset.content._tag !== "unavailable") {
      const at = markdown.lastIndexOf(url, range.end);
      if (at >= range.start) {
        edits.push({ start: at, end: at + url.length, text: encodePackagePath(asset.packagePath) });
      }
      return;
    }
    edits.push({ start: range.start, end: range.end, text: escapeMarkdownText(asset.fileName) });
  });
  return applyEdits(markdown, edits);
}

export function writeConversationMarkdown(input: {
  readonly bundle: ConversationDocumentBundle;
  readonly exportValue: string;
  readonly exported: string;
  readonly packaging: ConversationMarkdownPackaging;
}): string {
  const frontMatter = formatFrontMatter({
    exportValue: input.exportValue,
    title: input.bundle.metadata.title,
    exported: input.exported,
  });
  return `${frontMatter}\n${resolveAssetLinks(input.bundle.markdown, input.bundle, input.packaging)}`;
}

/** A file a packaged export stores: its bytes, or the attachment the writer copies. */
export type PackagedAsset =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly localId: string; readonly byteLength: number };

/** The assets a packaged export stores, in package order. */
export function packagedAssets(bundle: ConversationDocumentBundle): ReadonlyArray<PackagedAsset> {
  return bundle.assets.flatMap((asset): PackagedAsset[] =>
    asset.content._tag === "bytes"
      ? [{ path: asset.packagePath, bytes: asset.content.bytes }]
      : asset.content._tag === "external"
        ? [
            {
              path: asset.packagePath,
              localId: asset.content.localId,
              byteLength: asset.byteLength,
            },
          ]
        : [],
  );
}
