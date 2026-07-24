// FILE: EnvironmentStudioFolderRow.tsx
// Purpose: Opens a Studio chat's selected folder in the native platform file manager.
// Layer: Environment panel action

import { useRef, useState } from "react";

import { FolderClosed } from "~/components/FolderClosed";
import { basenameOfPath } from "~/file-icons";
import { ArrowUpRightIcon } from "~/lib/icons";
import { transientAlertManager } from "~/notifications/transientAlert";

import { shouldShowStudioFolderRow, studioFolderActionLabel } from "./EnvironmentPanel.logic";
import { ENVIRONMENT_ROW_ICON_CLASS_NAME, EnvironmentRow } from "./EnvironmentRow";

export function EnvironmentStudioFolderRow({
  isStudioChat,
  studioFolderPath,
  onClose,
}: {
  isStudioChat: boolean;
  studioFolderPath: string | null;
  onClose: () => void;
}) {
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const showInFolder =
    typeof window === "undefined" ? undefined : window.desktopBridge?.showInFolder;
  const showRow = shouldShowStudioFolderRow({
    isStudioChat,
    studioFolderPath,
    nativeShellAvailable: typeof showInFolder === "function",
  });

  if (!showRow || !studioFolderPath || !showInFolder) {
    return null;
  }

  const actionLabel = studioFolderActionLabel({
    studioFolderPath,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
  });
  const folderName = basenameOfPath(studioFolderPath) || studioFolderPath;

  const handleOpenFolder = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await showInFolder(studioFolderPath);
    } catch (error) {
      transientAlertManager.add({
        title: "Unable to open folder",
        description:
          error instanceof Error ? error.message : "An unknown error occurred opening the folder.",
      });
      return;
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
    onClose();
  };

  return (
    <EnvironmentRow
      aria-label={actionLabel}
      title={actionLabel}
      icon={<FolderClosed className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
      label={
        <span className="truncate" title={studioFolderPath}>
          {folderName}
        </span>
      }
      trailing={<ArrowUpRightIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
      disabled={opening}
      onClick={() => void handleOpenFolder()}
    />
  );
}
