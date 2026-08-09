import {
  type EnvironmentId,
  type ProviderConnectionMethod,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimePlan,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isSafeProviderAuthorizationUrl } from "./providerConnectionPresentation";

export interface ProviderLifecycleController {
  readonly startConnection: (method: ProviderConnectionMethod) => Promise<ServerProvider>;
  readonly cancelConnection: (operationId: string) => Promise<ServerProvider>;
  readonly disconnect: () => Promise<ServerProvider>;
  readonly openAuthorizationPage: (url: string) => Promise<void>;
  readonly planRuntime: (action: ProviderManagedRuntimeAction) => Promise<ProviderRuntimePlan>;
  readonly startRuntime: (plan: ProviderRuntimePlan) => Promise<ServerProvider>;
  readonly cancelRuntime: (operationId: string) => Promise<ServerProvider>;
  readonly updateExternalRuntime: () => Promise<ServerProvider>;
}

function providerFromResult(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ServerProvider["instanceId"],
): ServerProvider {
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (!provider) throw new Error("Scient could not read the updated provider state.");
  return provider;
}

function resultValue<A, E>(result: AtomCommandResult<A, E>, fallback: string): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("The provider action was cancelled.");
  const failure = squashAtomCommandFailure(result);
  throw failure instanceof Error ? failure : new Error(fallback);
}

/**
 * The production adapter between Scient's provider lifecycle UI and T3's
 * environment-scoped provider commands. It owns no provider state: every
 * successful action returns the canonical server snapshot.
 */
export function useProviderLifecycleController(input: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}): ProviderLifecycleController {
  const startProviderConnection = useAtomCommand(serverEnvironment.startProviderConnection, {
    reportFailure: false,
  });
  const cancelProviderConnection = useAtomCommand(serverEnvironment.cancelProviderConnection, {
    reportFailure: false,
  });
  const disconnectProvider = useAtomCommand(serverEnvironment.disconnectProvider, {
    reportFailure: false,
  });
  const planProviderRuntime = useAtomCommand(serverEnvironment.planProviderRuntime, {
    reportFailure: false,
  });
  const startProviderRuntime = useAtomCommand(serverEnvironment.startProviderRuntime, {
    reportFailure: false,
  });
  const cancelProviderRuntime = useAtomCommand(serverEnvironment.cancelProviderRuntime, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });

  const instanceId = input.provider.instanceId;
  const providerDriver = input.provider.driver;

  const startConnection = useCallback(
    async (method: ProviderConnectionMethod) => {
      const result = await startProviderConnection({
        environmentId: input.environmentId,
        input: { instanceId, method },
      });
      const value = resultValue(result, "Scient could not start provider sign in.");
      return providerFromResult(value.providers, instanceId);
    },
    [input.environmentId, instanceId, startProviderConnection],
  );

  const cancelConnection = useCallback(
    async (operationId: string) => {
      const result = await cancelProviderConnection({
        environmentId: input.environmentId,
        input: { instanceId, operationId },
      });
      const value = resultValue(result, "Scient could not cancel provider sign in.");
      return providerFromResult(value.providers, instanceId);
    },
    [cancelProviderConnection, input.environmentId, instanceId],
  );

  const disconnect = useCallback(async () => {
    const result = await disconnectProvider({
      environmentId: input.environmentId,
      input: { instanceId },
    });
    const value = resultValue(result, "Scient could not disconnect the provider account.");
    return providerFromResult(value.providers, instanceId);
  }, [disconnectProvider, input.environmentId, instanceId]);

  const openAuthorizationPage = useCallback(async (url: string) => {
    if (!isSafeProviderAuthorizationUrl(url)) {
      throw new Error("Scient refused an invalid or insecure provider sign-in link.");
    }
    await ensureLocalApi().shell.openExternal(url);
  }, []);

  const planRuntime = useCallback(
    async (action: ProviderManagedRuntimeAction) => {
      const result = await planProviderRuntime({
        environmentId: input.environmentId,
        input: { instanceId, action },
      });
      return resultValue(result, "Scient could not prepare the provider runtime action.");
    },
    [input.environmentId, instanceId, planProviderRuntime],
  );

  const startRuntime = useCallback(
    async (plan: ProviderRuntimePlan) => {
      const result = await startProviderRuntime({
        environmentId: input.environmentId,
        input: {
          instanceId,
          action: plan.action,
          catalogRevision: plan.catalogRevision,
        },
      });
      const value = resultValue(result, "Scient could not start the provider runtime action.");
      return providerFromResult(value.providers, instanceId);
    },
    [input.environmentId, instanceId, startProviderRuntime],
  );

  const cancelRuntime = useCallback(
    async (operationId: string) => {
      const result = await cancelProviderRuntime({
        environmentId: input.environmentId,
        input: { instanceId, operationId },
      });
      const value = resultValue(result, "Scient could not cancel the provider runtime action.");
      return providerFromResult(value.providers, instanceId);
    },
    [cancelProviderRuntime, input.environmentId, instanceId],
  );

  const updateExternalRuntime = useCallback(async () => {
    const result = await updateProvider({
      environmentId: input.environmentId,
      input: { provider: providerDriver, instanceId },
    });
    const value = resultValue(result, "Scient could not update the provider.");
    return providerFromResult(value.providers, instanceId);
  }, [input.environmentId, instanceId, providerDriver, updateProvider]);

  return useMemo(
    () => ({
      startConnection,
      cancelConnection,
      disconnect,
      openAuthorizationPage,
      planRuntime,
      startRuntime,
      cancelRuntime,
      updateExternalRuntime,
    }),
    [
      cancelConnection,
      cancelRuntime,
      disconnect,
      openAuthorizationPage,
      planRuntime,
      startConnection,
      startRuntime,
      updateExternalRuntime,
    ],
  );
}
