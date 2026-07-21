// FILE: ProviderConnectionDialog.tsx
// Purpose: One plain-language setup and recovery flow for AI providers.
// Layer: Shared UI component

import type { ServerProviderConnectionMethod, ServerProviderInstallPlan } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  CLAUDE_CONNECTION_METHOD_OPTIONS,
  describeProviderConnection,
  providerConnectionMethod,
  providerInstallUrl,
} from "~/lib/providerConnectionPresentation";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { applyProviderStatusesToCache } from "~/lib/providerStatusCache";
import { ensureNativeApi } from "~/nativeApi";
import { useProviderConnectionDialogStore } from "~/providerConnectionDialogStore";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "./ProviderIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

const CONNECTION_TIMEOUT_MS = 10 * 60 * 1_000;

function formatRemainingTime(startedAt: string, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - Date.parse(startedAt));
  const remainingSeconds = Math.max(0, Math.ceil((CONNECTION_TIMEOUT_MS - elapsedMs) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function ProviderConnectionDialog() {
  const { isOpen, provider, source, setOpen } = useProviderConnectionDialogStore();
  const configQuery = useQuery({ ...serverConfigQueryOptions(), enabled: isOpen });
  const queryClient = useQueryClient();
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installPlan, setInstallPlan] = useState<ServerProviderInstallPlan | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [runtimeReconnectBaselineOperationId, setRuntimeReconnectBaselineOperationId] = useState<
    string | null | undefined
  >(undefined);
  const status = provider
    ? configQuery.data?.providers.find((entry) => entry.provider === provider)
    : undefined;
  const runtimeReauthenticationFlow =
    isOpen && provider === "codex" && source === "runtime_authentication_error";
  const runtimeReconnectCompleted =
    runtimeReconnectBaselineOperationId !== undefined &&
    status?.connectionState?.status === "connected" &&
    status.connectionState.operationId !== runtimeReconnectBaselineOperationId;
  const runtimeReconnectRequired = runtimeReauthenticationFlow && !runtimeReconnectCompleted;
  const presentation = provider
    ? describeProviderConnection(provider, status, {
        forceReconnect: runtimeReconnectRequired,
      })
    : null;
  const Icon = provider ? PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider] : null;
  const activeConnection =
    status?.connectionState &&
    ["starting", "waiting_for_browser", "verifying"].includes(status.connectionState.status)
      ? status.connectionState
      : null;

  useEffect(() => {
    setRuntimeReconnectBaselineOperationId(undefined);
  }, [isOpen, provider, source]);

  useEffect(() => {
    setActionPending(false);
    setActionError(null);
    setInstallPlan(null);
    if (!isOpen || !provider || activeConnection) return;

    let disposed = false;
    setActionPending(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .then((result) => {
        if (!disposed) applyProviderStatusesToCache(queryClient, result.providers);
      })
      .catch((error) => {
        if (!disposed) {
          setActionError(
            error instanceof Error ? error.message : "Scient could not check this connection.",
          );
        }
      })
      .finally(() => {
        if (!disposed) setActionPending(false);
      });
    return () => {
      disposed = true;
    };
  }, [isOpen, provider, queryClient, activeConnection]);

  useEffect(() => {
    if (!isOpen || !activeConnection) return;
    setClockMs(Date.now());
    const intervalId = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [isOpen, activeConnection]);

  if (!provider || !presentation || !Icon) return null;
  const startsProviderSignIn =
    status?.available === true && providerConnectionMethod(provider) !== null;

  const runAction = async (action: () => Promise<void>) => {
    setActionPending(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The connection action failed.");
    } finally {
      setActionPending(false);
    }
  };

  const refresh = () =>
    runAction(async () => {
      const result = await ensureNativeApi().server.refreshProviders();
      applyProviderStatusesToCache(queryClient, result.providers);
    });

  const performStartSignIn = async (requestedMethod?: ServerProviderConnectionMethod) => {
    const previousMethod = status?.connectionState?.method;
    const method =
      requestedMethod ??
      (previousMethod !== "claude_subscription" ? previousMethod : undefined) ??
      providerConnectionMethod(provider);
    if (!method) throw new Error("In-app sign in is not supported for this provider yet.");
    const reauthenticate = runtimeReauthenticationFlow;
    if (reauthenticate) {
      setRuntimeReconnectBaselineOperationId(status?.connectionState?.operationId ?? null);
    }
    try {
      const result = await ensureNativeApi().server.startProviderConnection({
        provider,
        method,
        ...(reauthenticate ? { mode: "reauthenticate" as const } : {}),
      });
      applyProviderStatusesToCache(queryClient, result.providers);
    } catch (error) {
      if (reauthenticate) setRuntimeReconnectBaselineOperationId(undefined);
      throw error;
    }
  };

  const startSignIn = (method?: ServerProviderConnectionMethod) =>
    runAction(() => performStartSignIn(method));

  const cancelSignIn = () => {
    const operationId = status?.connectionState?.operationId;
    if (!operationId) return Promise.resolve();
    return runAction(async () => {
      const result = await ensureNativeApi().server.cancelProviderConnection({
        provider,
        operationId,
      });
      applyProviderStatusesToCache(queryClient, result.providers);
    });
  };

  const restartSignIn = () => {
    const operation = status?.connectionState;
    if (!operation) return Promise.resolve();
    return runAction(async () => {
      const cancelled = await ensureNativeApi().server.cancelProviderConnection({
        provider,
        operationId: operation.operationId,
      });
      applyProviderStatusesToCache(queryClient, cancelled.providers);
      await performStartSignIn(operation.method);
    });
  };

  const reopenAuthorization = () => {
    const authorizationUrl = activeConnection?.authorizationUrl;
    if (!authorizationUrl) return Promise.resolve();
    return runAction(() => ensureNativeApi().shell.openExternal(authorizationUrl));
  };

  const install = () =>
    runAction(async () => {
      if (!installPlan) {
        const plan = await ensureNativeApi().server.prepareProviderInstall({ provider });
        setInstallPlan(plan);
        return;
      }
      const result = await ensureNativeApi().server.installProvider({
        provider,
        planToken: installPlan.planToken,
      });
      setInstallPlan(null);
      applyProviderStatusesToCache(queryClient, result.providers);
    });

  const cancelInstall = () => {
    const operationId = status?.installationState?.operationId;
    if (!operationId) return Promise.resolve();
    return runAction(async () => {
      const result = await ensureNativeApi().server.cancelProviderInstall({
        provider,
        operationId,
      });
      applyProviderStatusesToCache(queryClient, result.providers);
    });
  };

  const handlePrimary = () => {
    switch (presentation.primaryAction) {
      case "install":
        return install();
      case "sign_in":
        return startSignIn();
      case "check_again":
        return refresh();
      case "open_install_guide": {
        const url = providerInstallUrl(provider);
        return url ? runAction(() => ensureNativeApi().shell.openExternal(url)) : refresh();
      }
      case "done":
        setOpen(false);
        return Promise.resolve();
      case "none":
        return Promise.resolve();
    }
  };

  const busy = presentation.busy || actionPending;

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      <DialogPopup surface="solid" className="max-w-md">
        <DialogHeader className="gap-2 px-5 pt-5 pb-3">
          <div className="flex items-center gap-3 pr-8">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)]">
              <Icon aria-hidden="true" className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{presentation.title}</DialogTitle>
              <DialogDescription>Guided setup</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel className="space-y-4 px-5 pb-2">
          <p className="text-sm leading-relaxed text-foreground" aria-live="polite">
            {presentation.description}
          </p>

          {busy ? (
            <div className="space-y-1 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] px-3 py-2.5 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Spinner className="size-4" />
                <span>
                  {presentation.busy
                    ? "You can close this dialog; sign in continues in the background."
                    : "Checking the current provider state."}
                </span>
              </div>
              {activeConnection ? (
                <p className="pl-6 text-xs">
                  Automatic timeout in {formatRemainingTime(activeConnection.startedAt, clockMs)}
                </p>
              ) : null}
            </div>
          ) : null}

          {provider === "grok" && activeConnection?.authorizationUrl ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={actionPending}
              onClick={reopenAuthorization}
            >
              Open xAI sign-in again
            </Button>
          ) : null}

          {provider === "claudeAgent" && presentation.primaryAction === "sign_in" ? (
            <div className="space-y-2" aria-label="Claude sign-in methods">
              <p className="text-xs font-medium text-muted-foreground">Other sign-in methods</p>
              {CLAUDE_CONNECTION_METHOD_OPTIONS.slice(1).map((option) => (
                <Button
                  key={option.method}
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-start px-3 py-2 text-left"
                  disabled={actionPending}
                  onClick={() => startSignIn(option.method)}
                >
                  <span>
                    <span className="block text-sm">{option.label}</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          ) : null}

          {installPlan ? (
            <div className="space-y-1.5 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] px-3 py-2.5 text-sm">
              <p className="font-medium">Ready to install version {installPlan.version}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {installPlan.downloadBytes
                  ? `${(installPlan.downloadBytes / 1_048_576).toFixed(1)} MB from ${installPlan.sourceHost}`
                  : `Verified download from ${installPlan.sourceHost}`}
                {`. Installed only inside Scient for ${installPlan.target}.`}
              </p>
            </div>
          ) : null}

          {actionError ? (
            <p
              className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
              role="alert"
            >
              {actionError}
            </p>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {startsProviderSignIn
              ? "Scient starts the provider's official sign-in. Passwords and account tokens stay with the provider and are never stored in Scient."
              : "Installation and sign-in happen directly with the provider. Passwords and account tokens are never entered into or stored in Scient."}
          </p>
        </DialogPanel>

        <DialogFooter className="px-5 pb-5">
          {presentation.canRestart ? (
            <Button
              type="button"
              variant="outline"
              disabled={actionPending}
              onClick={restartSignIn}
            >
              Restart sign in
            </Button>
          ) : null}
          {presentation.canCancel ? (
            <Button
              type="button"
              variant="outline"
              disabled={actionPending}
              onClick={status?.installationState ? cancelInstall : cancelSignIn}
            >
              {status?.installationState ? "Cancel installation" : "Cancel sign in"}
            </Button>
          ) : null}
          {presentation.primaryAction !== "none" ? (
            <Button type="button" disabled={actionPending} onClick={handlePrimary}>
              {actionPending ? <Spinner /> : null}
              {installPlan ? "Download and install" : presentation.primaryLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
