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

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { isRuntimePlanStale } from "./isRuntimePlanStale";
import { startProviderSignIn } from "./providerSignInFlow";
import { openProviderAuthorizationPage } from "./providerSignInPage";
import type { ProviderSignInKey } from "./providerSignInRequests";

export interface ProviderLifecycleController {
  /** The environment and instance whose sign-in page openings this controller shares. */
  readonly signInKey: ProviderSignInKey;
  /**
   * Starts a sign-in. When it waits on a page Scient opens, this client opens
   * it once, even if the view that asked has closed by then.
   */
  readonly startConnection: (
    method: ProviderConnectionMethod,
    mode?: "connect" | "reauthenticate",
  ) => Promise<ServerProvider>;
  readonly cancelConnection: (operationId: string) => Promise<ServerProvider>;
  readonly submitAuthorizationCode: (
    operationId: string,
    authorizationCode: string,
  ) => Promise<ServerProvider>;
  readonly disconnect: () => Promise<ServerProvider>;
  readonly openAuthorizationPage: (url: string) => Promise<void>;
  readonly planRuntime: (action: ProviderManagedRuntimeAction) => Promise<ProviderRuntimePlan>;
  /** Starts the qualified managed release chosen by the explicit action. */
  readonly startRuntime: (
    plan: ProviderRuntimePlan,
    options?: { readonly acceptOlderThanSystem?: boolean },
  ) => Promise<ServerProvider>;
  readonly cancelRuntime: (operationId: string) => Promise<ServerProvider>;
  readonly updateExternalRuntime: () => Promise<ServerProvider>;
  /** Runs one full status check of this provider instance and returns what it found. */
  readonly refresh: () => Promise<ServerProvider>;
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
 * Plans and starts a reviewed runtime action for any provider instance. For
 * callers that act on several providers, where one controller per provider
 * would need a hook per instance.
 */
export function useStartProviderRuntimeAction(): (input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ServerProvider["instanceId"];
  readonly action: ProviderManagedRuntimeAction;
}) => Promise<ServerProvider> {
  const planProviderRuntime = useAtomCommand(serverEnvironment.planProviderRuntime, {
    reportFailure: false,
  });
  const startProviderRuntime = useAtomCommand(serverEnvironment.startProviderRuntime, {
    reportFailure: false,
  });
  return async ({ environmentId, instanceId, action }) => {
    const plan = resultValue(
      await planProviderRuntime({ environmentId, input: { instanceId, action } }),
      "Scient could not prepare the provider runtime action.",
    );
    const started = resultValue(
      await startProviderRuntime({
        environmentId,
        input: { instanceId, action: plan.action, catalogRevision: plan.catalogRevision },
      }),
      "Scient could not start the provider runtime action.",
    );
    return providerFromResult(started.providers, instanceId);
  };
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
  const submitProviderAuthorizationCode = useAtomCommand(
    serverEnvironment.submitProviderAuthorizationCode,
    { reportFailure: false },
  );
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
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const instanceId = input.provider.instanceId;
  const providerDriver = input.provider.driver;
  const signInKey = { environmentId: input.environmentId, instanceId };
  const providerName = input.provider.displayName?.trim() || "provider";
  const currentOperationId = input.provider.connection?.operation?.operationId ?? null;

  const startConnection = async (
    method: ProviderConnectionMethod,
    mode?: "connect" | "reauthenticate",
  ) => {
    return startProviderSignIn({
      key: signInKey,
      providerName,
      previousOperationId: currentOperationId,
      start: async (signInRequestId) => {
        const result = await startProviderConnection({
          environmentId: input.environmentId,
          input: { instanceId, method, signInRequestId, ...(mode ? { mode } : {}) },
        });
        const value = resultValue(result, "Scient could not start provider sign in.");
        return providerFromResult(value.providers, instanceId);
      },
      operationOf: (provider) => provider.connection?.operation,
    });
  };

  const cancelConnection = async (operationId: string) => {
    const result = await cancelProviderConnection({
      environmentId: input.environmentId,
      input: { instanceId, operationId },
    });
    const value = resultValue(result, "Scient could not cancel provider sign in.");
    return providerFromResult(value.providers, instanceId);
  };

  const submitAuthorizationCode = async (operationId: string, authorizationCode: string) => {
    const result = await submitProviderAuthorizationCode({
      environmentId: input.environmentId,
      input: { instanceId, operationId, authorizationCode },
    });
    const value = resultValue(result, "Scient could not submit the provider authorization code.");
    return providerFromResult(value.providers, instanceId);
  };

  const disconnect = async () => {
    const result = await disconnectProvider({
      environmentId: input.environmentId,
      input: { instanceId },
    });
    const value = resultValue(result, "Scient could not disconnect the provider account.");
    return providerFromResult(value.providers, instanceId);
  };

  const planRuntime = async (action: ProviderManagedRuntimeAction) => {
    const result = await planProviderRuntime({
      environmentId: input.environmentId,
      input: { instanceId, action },
    });
    return resultValue(result, "Scient could not prepare the provider runtime action.");
  };

  const startRuntime = async (
    plan: ProviderRuntimePlan,
    options?: { readonly acceptOlderThanSystem?: boolean },
  ) => {
    const start = async (currentPlan: ProviderRuntimePlan) =>
      resultValue(
        await startProviderRuntime({
          environmentId: input.environmentId,
          input: {
            instanceId,
            action: currentPlan.action,
            catalogRevision: currentPlan.catalogRevision,
            ...(options?.acceptOlderThanSystem === true ? { acceptOlderThanSystem: true } : {}),
          },
        }),
        "Scient could not start the provider runtime action.",
      );
    const value = await start(plan).catch(async (cause: unknown) => {
      if (plan.action === "remove" || !isRuntimePlanStale(cause)) throw cause;
      return start(await planRuntime(plan.action));
    });
    return providerFromResult(value.providers, instanceId);
  };

  const cancelRuntime = async (operationId: string) => {
    const result = await cancelProviderRuntime({
      environmentId: input.environmentId,
      input: { instanceId, operationId },
    });
    const value = resultValue(result, "Scient could not cancel the provider runtime action.");
    return providerFromResult(value.providers, instanceId);
  };

  const updateExternalRuntime = async () => {
    const result = await updateProvider({
      environmentId: input.environmentId,
      input: { provider: providerDriver, instanceId },
    });
    const value = resultValue(result, "Scient could not update the provider.");
    return providerFromResult(value.providers, instanceId);
  };

  const refresh = async () => {
    const result = await refreshProviders({
      environmentId: input.environmentId,
      input: { instanceId },
    });
    const value = resultValue(result, "Scient could not check the provider.");
    return providerFromResult(value.providers, instanceId);
  };

  return {
    signInKey,
    startConnection,
    cancelConnection,
    submitAuthorizationCode,
    disconnect,
    openAuthorizationPage: openProviderAuthorizationPage,
    planRuntime,
    startRuntime,
    cancelRuntime,
    updateExternalRuntime,
    refresh,
  };
}
