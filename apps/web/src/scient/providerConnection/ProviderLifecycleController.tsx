import type {
  ProviderConnectionMethod,
  ProviderManagedRuntimeAction,
  ProviderRuntimePlan,
  ServerProvider,
} from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

export interface ProviderLifecycleController {
  readonly startConnection: (method: ProviderConnectionMethod) => Promise<ServerProvider>;
  readonly cancelConnection: (operationId: string) => Promise<ServerProvider>;
  readonly disconnect: () => Promise<ServerProvider>;
  readonly openAuthorizationPage: (url: string) => Promise<void>;
  readonly planRuntime: (action: ProviderManagedRuntimeAction) => Promise<ProviderRuntimePlan>;
  readonly startRuntime: (plan: ProviderRuntimePlan) => Promise<ServerProvider>;
  readonly cancelRuntime: (operationId: string) => Promise<ServerProvider>;
  /** Lab/prototype override. Production provider updates remain owned by T3's update command. */
  readonly startUpdate?: () => Promise<ServerProvider>;
}

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
