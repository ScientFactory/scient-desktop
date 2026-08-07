import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { resolveDroppedProjectFolder } from "../lib/projectEntry";
import { toastManager } from "../components/ui/toast";

export function useProjectFolderDrop(input: {
  readonly enabled: boolean;
  readonly onFolder: (path: string) => void;
}) {
  const { enabled, onFolder } = input;
  const [isActive, setIsActive] = useState(false);
  const dragDepthRef = useRef(0);

  const reset = useCallback(() => {
    dragDepthRef.current = 0;
    setIsActive(false);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsActive(true);
    },
    [enabled],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !event.dataTransfer.types.includes("Files")) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsActive(false);
    },
    [enabled],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
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
    },
    [enabled, onFolder, reset],
  );

  return { isActive, onDragEnter, onDragLeave, onDragOver, onDrop } as const;
}
