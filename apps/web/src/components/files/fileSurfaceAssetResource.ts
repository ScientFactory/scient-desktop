import { EnvironmentFilePath, type ThreadId } from "@t3tools/contracts";

import { isAbsolutePath } from "@t3tools/shared/path";

/**
 * The asset a file surface's media or document viewer loads. A workspace file
 * is named by its rooted workspace locator; a host file outside the workspace
 * is served on its own as a media file, which a rooted locator cannot name.
 *
 * The tab's own path decides which: the files panel has already turned any
 * path that leaves the workspace into an absolute host path, so a relative
 * path is a workspace file. Re-deriving that from the joined absolute path
 * would misjudge a workspace root whose name the join cannot round-trip.
 *
 * A host HTML page is served as a document, with the files beside it, so its
 * stylesheets, scripts and images load in the panel exactly as they do in the
 * integrated browser, which is not available to every viewer.
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
