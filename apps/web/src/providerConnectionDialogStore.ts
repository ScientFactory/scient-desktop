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
  | "managed_update"
  | "onboarding";

export interface ProviderConnectChain {
  readonly provider: ProviderKind;
  readonly token: string;
}

interface ProviderConnectionDialogStore {
  isOpen: boolean;
  provider: ProviderKind | null;
  source: ProviderConnectionSource | null;
  /**
   * Active one-click connect chain: after a managed install completes, the
   * provider's browser sign-in starts automatically. Survives closing the
   * dialog; cleared when the sign-in starts or the install stops.
   */
  connectChain: ProviderConnectChain | null;
  openDialog: (provider: ProviderKind, source: ProviderConnectionSource) => void;
  setOpen: (open: boolean) => void;
  beginConnectChain: (provider: ProviderKind) => ProviderConnectChain;
  clearConnectChain: (token?: string) => void;
}

export const useProviderConnectionDialogStore = create<ProviderConnectionDialogStore>((set) => ({
  isOpen: false,
  provider: null,
  source: null,
  connectChain: null,
  openDialog: (provider, source) => set({ isOpen: true, provider, source }),
  setOpen: (open) => set(open ? { isOpen: true } : { isOpen: false, provider: null, source: null }),
  beginConnectChain: (provider) => {
    const chain: ProviderConnectChain = { provider, token: crypto.randomUUID() };
    set({ connectChain: chain });
    return chain;
  },
  clearConnectChain: (token) =>
    set((state) =>
      token === undefined || state.connectChain?.token === token ? { connectChain: null } : state,
    ),
}));
