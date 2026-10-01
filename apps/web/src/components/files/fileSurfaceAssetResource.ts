import type { ThreadId } from "@t3tools/contracts";

import { isAbsolutePath } from "~/terminal-links";

/**
 * The asset a file surface's media or document viewer loads. A workspace file
 * is named by its rooted workspace locator; a host file outside the workspace
 * is served on its own as a media file, which a rooted locator cannot name.
 *
 * The tab's own path decides which: the files panel has already turned any
 * path that leaves the workspace into an absolute host path, so a relative
 * path is a workspace file. Re-deriving that from the joined absolute path
 * would misjudge a workspace root whose name the join cannot round-trip.
 */
export function fileSurfaceAssetResource(input: {
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}) {
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
