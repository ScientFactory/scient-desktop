// FILE: providerConnectionDialogStore.ts
// Purpose: Owns presentation state for the single global provider connection dialog.
// Layer: Web UI state

import type { ProviderKind } from "@synara/contracts";
import { create } from "zustand";

export type ProviderConnectionSource =
  | "provider_picker"
  | "send"
  | "health_banner"
  | "settings"
  | "empty_state"
  | "runtime_error"
  | "runtime_authentication_error"
  | "managed_update";

interface ProviderConnectionDialogStore {
  isOpen: boolean;
  provider: ProviderKind | null;
  source: ProviderConnectionSource | null;
  openDialog: (provider: ProviderKind, source: ProviderConnectionSource) => void;
  setOpen: (open: boolean) => void;
}

export const useProviderConnectionDialogStore = create<ProviderConnectionDialogStore>((set) => ({
  isOpen: false,
  provider: null,
  source: null,
  openDialog: (provider, source) => set({ isOpen: true, provider, source }),
  setOpen: (open) => set(open ? { isOpen: true } : { isOpen: false, provider: null, source: null }),
}));
