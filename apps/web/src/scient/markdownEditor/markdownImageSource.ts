import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";

import { joinWorkspaceImagePath } from "~/scient/images/inlineWorkspaceImage";

import { resolveMarkdownUrlPath } from "./workspacePaths";

/** One classification for display and explicit actions; authored paths never become signed URLs. */
export function resolveMarkdownImageSource(
  source: string,
  context: { cwd: string; documentPath: string; threadRef: ScopedThreadRef },
):
  | { kind: "direct"; url: string; fileName: string }
  | {
      kind: "workspace";
      resource: Extract<AssetResource, { _tag: "workspace-file" }>;
      relativePath: string;
      absolutePath: string;
      fileName: string;
      suffix: string;
    }
  | null {
  if (/^https:\/\//iu.test(source)) {
    try {
      const url = new URL(source);
      return { kind: "direct", url: source, fileName: url.pathname.split("/").at(-1) || "image" };
    } catch {
      return null;
    }
  }
  if (source.startsWith("data:image/")) {
    const subtype = source.slice("data:image/".length).split(/[;,]/u, 1)[0];
    const extension = subtype === "svg+xml" ? "svg" : subtype;
    return {
      kind: "direct",
      url: source,
      fileName: extension && /^[a-z0-9]+$/iu.test(extension) ? `image.${extension}` : "image",
    };
  }
  const resolved = resolveMarkdownUrlPath(context.documentPath, source);
  if (!resolved) return null;
  const { relativePath, suffix } = resolved;
  const absolutePath = joinWorkspaceImagePath(context.cwd, relativePath);
  return {
    kind: "workspace",
    relativePath,
    absolutePath,
    suffix,
    fileName: relativePath.split("/").at(-1) || "image",
    resource: {
      _tag: "workspace-file",
      cwd: context.cwd,
      relativePath,
      threadId: context.threadRef.threadId,
      path: absolutePath,
    },
  };
}
