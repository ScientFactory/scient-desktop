// FILE: ProviderConnectionDialog.tsx
// Purpose: One plain-language setup and recovery flow for AI providers.
// Layer: Shared UI component

import type { ServerProviderInstallPlan } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
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

export function ProviderConnectionDialog() {
  const { isOpen, provider, setOpen } = useProviderConnectionDialogStore();
  const configQuery = useQuery({ ...serverConfigQueryOptions(), enabled: isOpen });
  const queryClient = useQueryClient();
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installPlan, setInstallPlan] = useState<ServerProviderInstallPlan | null>(null);

  const status = provider
    ? configQuery.data?.providers.find((entry) => entry.provider === provider)
    : undefined;
  const presentation = provider ? describeProviderConnection(provider, status) : null;
  const Icon = provider ? PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider] : null;

  useEffect(() => {
    setActionPending(false);
    setActionError(null);
    setInstallPlan(null);
  }, [isOpen, provider]);

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

  const startSignIn = () =>
    runAction(async () => {
      const method = providerConnectionMethod(provider);
      if (!method) throw new Error("In-app sign in is not supported for this provider yet.");
      const result = await ensureNativeApi().server.startProviderConnection({ provider, method });
      applyProviderStatusesToCache(queryClient, result.providers);
    });

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
            <div className="flex items-center gap-2 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] px-3 py-2.5 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              <span>You can close this dialog; sign in continues in the background.</span>
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
