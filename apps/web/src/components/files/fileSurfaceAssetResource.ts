import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import type { ThreadId } from "@t3tools/contracts";

/**
 * The asset a file surface's media or document viewer loads. A file inside the
 * workspace is a rooted workspace file; a host file outside it (an absolute
 * path, or one reached through `..`) is served on its own as a media file,
 * which a rooted workspace locator cannot name.
 */
export function fileSurfaceAssetResource(input: {
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}) {
  return mediaFileReference(input.absolutePath, input.workspaceRoot).relativePath !== undefined
    ? {
        _tag: "workspace-file" as const,
        cwd: input.workspaceRoot,
        relativePath: input.relativePath,
        threadId: input.threadId,
        path: input.absolutePath,
      }
    : {
        _tag: "media-file" as const,
        threadId: input.threadId,
        path: input.absolutePath,
      };
}
