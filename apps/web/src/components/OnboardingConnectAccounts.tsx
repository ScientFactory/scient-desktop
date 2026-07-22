// FILE: OnboardingConnectAccounts.tsx
// Purpose: First-run "connect your accounts" surface. Lists the featured
// providers with live status and hands each Connect click to the regular
// provider connection dialog, so install + browser sign-in stay one flow.
// Layer: Root web overlay

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  INITIAL_ONBOARDING_STORAGE,
  ONBOARDING_FEATURED_PROVIDERS,
  ONBOARDING_STORAGE_KEY,
  OnboardingStorageSchema,
  decideOnboardingVisibility,
  onboardingProviderState,
} from "../lib/onboarding.logic";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { useProviderConnectionDialogStore } from "../providerConnectionDialogStore";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "./ProviderIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

const STATE_LABELS = {
  connected: "Connected",
  sign_in_pending: "Sign-in in progress",
  not_connected: "Not connected",
  checking: "Checking…",
} as const;

export function OnboardingConnectAccounts() {
  const navigate = useNavigate();
  const openConnectionDialog = useProviderConnectionDialogStore((store) => store.openDialog);
  const [storage, setStorage] = useLocalStorage(
    ONBOARDING_STORAGE_KEY,
    INITIAL_ONBOARDING_STORAGE,
    OnboardingStorageSchema,
  );
  const configQuery = useQuery(serverConfigQueryOptions());
  const providers = configQuery.data?.providers;
  const decision = decideOnboardingVisibility({ storage, providers });

  const [open, setOpen] = useState(false);
  const everOpenedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (decision === "show" && !everOpenedRef.current) {
      everOpenedRef.current = true;
      setOpen(true);
    }
  }, [decision]);

  // A featured account is connected: record completion once. The surface stays
  // open (if it was) so the user sees the connected state and a Done button.
  useEffect(() => {
    if (decision !== "complete" || storage.completedAt !== null || storage.dismissed) return;
    setStorage({ ...storage, completedAt: new Date().toISOString() });
  }, [decision, storage, setStorage]);

  const skip = useCallback(() => {
    setOpen(false);
    if (storage.completedAt === null) setStorage({ ...storage, dismissed: true });
  }, [setStorage, storage]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setOpen(true);
        return;
      }
      skip();
    },
    [skip],
  );

  const openAllProviders = useCallback(() => {
    setOpen(false);
    if (storage.completedAt === null && !storage.dismissed) {
      setStorage({ ...storage, dismissed: true });
    }
    void navigate({ to: "/settings", search: { section: "providers" } });
  }, [navigate, setStorage, storage]);

  if (!open) return null;
  const anyConnected = storage.completedAt !== null || decision === "complete";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* "Skip for now" is the close affordance; a popup X would duplicate it. */}
      <DialogPopup
        surface="solid"
        showCloseButton={false}
        initialFocus={sheetRef}
        className="max-w-[460px] rounded-[20px]"
      >
        <div ref={sheetRef} tabIndex={-1} className="flex flex-col p-5 outline-none">
          <DialogHeader className="gap-2 p-0">
            <DialogTitle className="text-[19px] leading-tight">Connect your accounts</DialogTitle>
            <DialogDescription className="text-[14px] leading-[19.5px]">
              Sign in with the AI accounts you already have. Scient opens each provider&rsquo;s
              official browser sign-in — no API keys, and your credentials stay with the provider.
            </DialogDescription>
          </DialogHeader>

          <ul className="mt-4 flex flex-col gap-2" aria-label="Featured providers">
            {ONBOARDING_FEATURED_PROVIDERS.map((provider) => {
              const status = providers?.find((entry) => entry.provider === provider);
              const stateKind = onboardingProviderState(status);
              const Icon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider];
              const label = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
              return (
                <li
                  key={provider}
                  className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-secondary)] px-3 py-2.5"
                >
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/30"
                  >
                    <Icon className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {STATE_LABELS[stateKind]}
                    </span>
                  </span>
                  {stateKind === "connected" ? (
                    <span className="text-xs font-medium text-muted-foreground">✓</span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={stateKind === "sign_in_pending"}
                      onClick={() => openConnectionDialog(provider, "onboarding")}
                    >
                      {stateKind === "sign_in_pending" ? <Spinner className="size-4" /> : null}
                      Connect
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>

          <DialogFooter className="gap-2 p-0 pt-4">
            <Button variant="ghost" className="rounded-[10px]" onClick={openAllProviders}>
              More providers
            </Button>
            {anyConnected ? (
              <Button className="rounded-[10px]" onClick={() => setOpen(false)}>
                Done
              </Button>
            ) : (
              <Button variant="ghost" className="rounded-[10px]" onClick={skip}>
                Skip for now
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
