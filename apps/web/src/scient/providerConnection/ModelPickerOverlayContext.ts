import type { ProviderInstanceId } from "@t3tools/contracts";
import {
  createContext,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { composerFloatingLayerProps } from "../../components/chat/composerEventScope";

/** The picker retains its setup owner while an owned, portaled dialog has focus. */
export const ModelPickerOverlayContext = createContext<{
  instanceId: ProviderInstanceId | null;
  pickerTriggerRef: RefObject<HTMLButtonElement | null>;
  setInstanceId: (instanceId: ProviderInstanceId | null) => void;
} | null>(null);

/** Shared ownership for the regular model picker and the first-connection picker. */
export function useModelPickerOverlay(composerOwned: boolean) {
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const instanceRef = useRef<ProviderInstanceId | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const setOverlayInstance = useCallback((next: ProviderInstanceId | null) => {
    instanceRef.current = next;
    setInstanceId(next);
  }, []);
  const context = useMemo(
    () => ({ instanceId, pickerTriggerRef, setInstanceId: setOverlayInstance }),
    [instanceId, setOverlayInstance],
  );
  const scrollScope = useMemo(
    () => ({ id, ...(composerOwned ? { portalProps: composerFloatingLayerProps } : {}) }),
    [id, composerOwned],
  );
  return { context, instanceRef, pickerTriggerRef, scrollScope };
}
