import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useContext, useEffect, useRef, useState } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { extensionsChanges } from "./extensionsState";
import {
  createProviderInventoryRequest,
  providerInventoryScope,
  type ProviderInventoryView,
  UNKNOWN_PROVIDER_INVENTORY,
} from "./providerInventory";

export function useProviderInventory({
  environmentId,
  roots,
  projectsKnown,
  providers,
  enabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly roots: ReadonlyArray<string>;
  readonly projectsKnown: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly enabled: boolean;
}): ProviderInventoryView {
  const registry = useContext(RegistryContext);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const permitted = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const rootsKey = JSON.stringify([...new Set(roots)].sort());
  const providersKey = providerInventoryScope(providers);
  const scopeKey = JSON.stringify([
    environmentId,
    rootsKey,
    providersKey,
    enabled,
    projectsKnown,
    canRead,
    permitted,
  ]);
  const serial = useRef(Promise.resolve());
  const [result, setResult] = useState<{
    readonly scopeKey: string;
    readonly view: ProviderInventoryView;
  } | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- The mounted page owns cancellable inventory requests and its revision subscription.
  useEffect(() => {
    if (!enabled || !projectsKnown || !canRead || !permitted) return;
    let active = true;
    const request = createProviderInventoryRequest({
      roots: new Set<string>(JSON.parse(rootsKey)),
      providerScope: providersKey,
      read: (input) => {
        const next = serial.current.then(async () => {
          if (!active) throw new Error("Inventory request cancelled.");
          const reply = await serverEnvironment.refreshProviders.run(registry, {
            environmentId,
            input,
          });
          if (reply._tag === "Failure") throw new Error(formatEnvironmentQueryError(reply.cause));
          return reply.value;
        });
        serial.current = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      publish: (view) => setResult({ scopeKey, view }),
    });
    void request.refresh(null);
    const unsubscribe = registry.subscribe(
      extensionsChanges({ environmentId, input: {} }),
      (change) => {
        if (change._tag === "Failure") {
          request.changesFailed(formatEnvironmentQueryError(change.cause));
        } else if (change._tag === "Success") {
          request.changesFailed(null);
          void request.refresh(change.value.revision);
        }
      },
      { immediate: true },
    );
    return () => {
      active = false;
      request.dispose();
      unsubscribe();
    };
  }, [
    registry,
    environmentId,
    rootsKey,
    providersKey,
    scopeKey,
    enabled,
    projectsKnown,
    canRead,
    permitted,
  ]);

  if (enabled && (!canRead || !permitted)) {
    return {
      providers: [],
      phase: "error",
      errors: ["This connection cannot read agent extensions."],
    };
  }
  return result?.scopeKey === scopeKey ? result.view : UNKNOWN_PROVIDER_INVENTORY;
}
