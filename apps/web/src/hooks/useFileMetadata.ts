import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  isAbsolutePath,
  isNetworkPath,
  normalizeProjectPathForComparison,
  // SCIENT-FORK:START — a chip names a literal file, not a positioned Markdown link.
  resolveWorkspaceFilePath,
  // SCIENT-FORK:END
} from "@t3tools/shared/path";
import { useContext } from "react";

import { useEnvironmentScope } from "../state/session";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

export function getFileMetadataQueryAtom(
  environmentId: EnvironmentId,
  path: string,
  cwd?: string,
  threadRef?: ScopedThreadRef | null,
  // SCIENT-FORK:START — a chip names a literal file; only terminal links carry positions.
  literal = false,
  // SCIENT-FORK:END
) {
  const hostPath = splitFilePathPosition(path).path;
  // SCIENT-FORK:START — a chip names a literal file, not a positioned Markdown link.
  const targetPath = literal
    ? cwd
      ? resolveWorkspaceFilePath(path, cwd)
      : path
    : normalizeProjectPathForComparison(
        hostPath.startsWith("~/") || !cwd ? hostPath : resolvePathLinkTarget(hostPath, cwd),
      );
  const absolute =
    isAbsolutePath(targetPath) || targetPath.startsWith("~/") || targetPath.startsWith("~\\");
  // SCIENT-FORK:END
  return (
    // Servers stat what they are asked about, and a network path leaks the
    // Windows user's NTLM credentials to its host before any chip is clicked.
    absolute && !isNetworkPath(targetPath) && targetPath.length <= 512
      ? projectEnvironment.fileMetadata({
          environmentId,
          input: {
            path: targetPath,
            ...(threadRef?.environmentId === environmentId ? { threadId: threadRef.threadId } : {}),
          },
        })
      : null
  );
}

export function useFileMetadata(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd?: string,
) {
  const canRead = useEnvironmentScope(environmentId ?? null, AuthFilesystemReadScope);
  const threadRef = useContext(FileMetadataThreadContext);
  // SCIENT-FORK:START — chips stat their literal file name.
  return useEnvironmentQuery(
    environmentId && canRead
      ? getFileMetadataQueryAtom(environmentId, path, cwd, threadRef, true)
      : null,
  ).data;
  // SCIENT-FORK:END
}
