import { createContext, useContext, type ReactNode } from "react";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

export type { ProviderLifecycleController } from "./useProviderLifecycleController";

const Context = createContext<ProviderLifecycleController | null>(null);

export function ProviderLifecycleControllerProvider(props: {
  readonly controller: ProviderLifecycleController;
  readonly children: ReactNode;
}) {
  return <Context.Provider value={props.controller}>{props.children}</Context.Provider>;
}

export function useOptionalProviderLifecycleController(): ProviderLifecycleController | null {
  return useContext(Context);
}
