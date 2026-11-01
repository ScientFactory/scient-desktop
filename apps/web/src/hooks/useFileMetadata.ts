import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { isAbsolutePath, isNetworkPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { useContext } from "react";

import { useEnvironmentScope } from "../state/session";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

export function useFileMetadata(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd?: string,
) {
  const canRead = useEnvironmentScope(environmentId ?? null, AuthFilesystemReadScope);
  const threadRef = useContext(FileMetadataThreadContext);
  // SCIENT-FORK:START — a chip names a literal file, not a positioned Markdown link.
  const targetPath = cwd ? resolveWorkspaceFilePath(path, cwd) : path;
  // SCIENT-FORK:END
  const absolute =
    isAbsolutePath(targetPath) || targetPath.startsWith("~/") || targetPath.startsWith("~\\");
  return useEnvironmentQuery(
    // Servers stat what they are asked about, and a network path leaks the
    // Windows user's NTLM credentials to its host before any chip is clicked.
    environmentId && canRead && absolute && !isNetworkPath(targetPath) && targetPath.length <= 512
      ? projectEnvironment.fileMetadata({
          environmentId,
          input: {
            path: targetPath,
            ...(threadRef?.environmentId === environmentId ? { threadId: threadRef.threadId } : {}),
          },
        })
      : null,
  ).data;
}
