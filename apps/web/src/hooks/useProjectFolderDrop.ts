import { useEffect, useRef, useState, type DragEvent } from "react";

import { resolveDroppedProjectFolder } from "../lib/projectEntry";
import { toastManager } from "../components/ui/toast";

export function useProjectFolderDrop(input: {
  readonly enabled: boolean;
  readonly onFolder: (path: string) => void;
}) {
  const { enabled, onFolder } = input;
  const [isActive, setIsActive] = useState(false);
  const dragDepthRef = useRef(0);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) setIsActive(false);
  }

  const reset = () => {
    dragDepthRef.current = 0;
    setIsActive(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resets the drag-depth counter when folder drop is disabled
  useEffect(() => {
    if (!enabled) dragDepthRef.current = 0;
  }, [enabled]);

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!enabled || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!enabled || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!enabled || !event.dataTransfer.types.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!enabled || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    reset();

    const getPathForFile = window.desktopBridge?.getPathForFile;
    if (!getPathForFile) return;
    const dropped = resolveDroppedProjectFolder(event.dataTransfer, getPathForFile);
    if ("error" in dropped) {
      toastManager.add({
        type: "warning",
        title: "Unable to add folder",
        description: dropped.error,
      });
      return;
    }
    onFolder(dropped.path);
  };

  return { isActive, onDragEnter, onDragLeave, onDragOver, onDrop } as const;
}
