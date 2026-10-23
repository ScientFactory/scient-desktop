import type { EnvironmentId } from "@t3tools/contracts";
import type { MarkdownFileLinkMeta } from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function markdownFileCopyMenuItems({
  workspaceRelativePath,
}: Pick<MarkdownFileLinkMeta, "workspaceRelativePath">) {
  const items = [{ id: "copy-full", label: "Copy full path" }];
  if (workspaceRelativePath !== null) {
    items.unshift({
      id: "copy-relative",
      label: "Copy relative path",
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInBrowser: boolean;
}): boolean {
  // SCIENT-FORK:START — the caller already selected the canonical workspace-file action.
  // The caller supplies this action only when the canonical workspace-file
  // policy selected Browser preview. Do not duplicate extension policy here.
  return input.canOpenInBrowser;
  // SCIENT-FORK:END
}
