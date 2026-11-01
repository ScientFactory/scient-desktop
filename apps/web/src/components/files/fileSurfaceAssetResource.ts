import { EnvironmentFilePath, type ThreadId } from "@t3tools/contracts";

import { isAbsolutePath } from "@t3tools/shared/path";

/**
 * Use the tab's rooted/host classification; re-deriving it from a joined path can misclassify roots
 * that cannot round-trip. Host HTML needs document serving with adjacent resources, including in
 * viewers without the integrated browser.
 */
export function fileSurfaceAssetResource(input: {
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
  /** The surface shows this file as an HTML page. */
  readonly htmlDocument?: boolean;
}) {
  if (input.htmlDocument && isAbsolutePath(input.relativePath)) {
    return {
      _tag: "environment-file" as const,
      path: EnvironmentFilePath.make(input.absolutePath),
      access: "html-document" as const,
    };
  }
  return isAbsolutePath(input.relativePath)
    ? {
        _tag: "media-file" as const,
        threadId: input.threadId,
        path: input.absolutePath,
      }
    : {
        _tag: "workspace-file" as const,
        cwd: input.workspaceRoot,
        relativePath: input.relativePath,
        threadId: input.threadId,
        path: input.absolutePath,
      };
}
