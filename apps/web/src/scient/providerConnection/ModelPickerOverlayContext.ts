import type { ProviderInstanceId } from "@t3tools/contracts";
import { createContext, type RefObject } from "react";

/** The picker retains its setup owner while an owned, portaled dialog has focus. */
export const ModelPickerOverlayContext = createContext<{
  instanceId: ProviderInstanceId | null;
  pickerTriggerRef: RefObject<HTMLButtonElement | null>;
  setInstanceId: (instanceId: ProviderInstanceId | null) => void;
} | null>(null);
