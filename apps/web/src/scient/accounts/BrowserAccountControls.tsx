import { useSessionOffer } from "./useSessionOffer";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import type {
  AccountSummary,
  AccountWriteStore,
  AccountStoresStatus,
  AccountMatchSignInResult,
  DesktopCapturedSignIn,
  DesktopLoginForm,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useQuietThreadShell } from "~/state/entities";
import { Button } from "~/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useClientSettings } from "~/hooks/useSettings";
import { useAccountCommand, useAccounts } from "./useAccounts";
import {
  automaticSignIn,
  canAutomaticallyFill,
  capturedSignInInput,
  matchingAccounts,
  profileAccounts,
  signInLabel,
} from "./accountsView";

import { SaveStores } from "./SaveStores";

const NEVER_KEY = "scient.accounts.never-save.v1";
function neverSaveSites(): ReadonlyArray<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(NEVER_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((site): site is string => typeof site === "string").slice(0, 500)
      : [];
  } catch {
    return [];
  }
}

function SaveSignIn({
  capture,
  environmentId,
  matching,
  comparison,
  stores,
  anchor,
  onClose,
}: {
  anchor: HTMLElement | null;
  capture: DesktopCapturedSignIn;
  environmentId: EnvironmentId;
  matching: ReadonlyArray<AccountSummary>;
  comparison: AccountMatchSignInResult;
  stores: AccountStoresStatus;
  onClose: () => void;
}) {
  const [selectedStores, setSelectedStores] = useState<ReadonlyArray<AccountWriteStore>>([
    { type: "scient" },
  ]);
  const [busy, setBusy] = useState(false);
  const save = useAccountCommand(accountsState.save, environmentId);
  const origin = new URL(capture.url).origin;
  const submit = async () => {
    if (busy || !selectedStores.length) return;
    setBusy(true);
    const input = capturedSignInInput(
      capture,
      comparison.result === "password-changed"
        ? matching.filter((account) => account.accountId === comparison.accountId)
        : matching.filter((account) => !account.secrets.password),
    );
    if (comparison.result === "password-changed" && input.accountId !== comparison.accountId) {
      setBusy(false);
      return;
    }
    const result = await save({
      ...input,
      secrets: { password: { type: "scient", value: capture.password, saveTo: selectedStores } },
    });
    setBusy(false);
    if (result.ok) onClose();
  };
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverPopup anchor={anchor} align="end">
        <div
          className="w-72"
          role="dialog"
          aria-label={
            comparison.result === "password-changed" ? "Update password?" : "Save sign-in?"
          }
        >
          <div className="text-sm font-medium">
            {comparison.result === "password-changed" ? "Update password?" : "Save sign-in?"}
          </div>
          <div className="my-2 text-xs text-muted-foreground">
            {new URL(origin).hostname} · {capture.username}
          </div>
          <div className="mb-3">
            <SaveStores
              kept={
                matching.find((account) => account.accountId === comparison.accountId)?.secrets
                  .password
              }
              stores={stores}
              selected={selectedStores}
              onChange={setSelectedStores}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              disabled={busy || selectedStores.length === 0}
              onClick={() => void submit()}
            >
              {comparison.result === "password-changed" ? "Update" : "Save"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                try {
                  localStorage.setItem(
                    NEVER_KEY,
                    JSON.stringify([...new Set([...neverSaveSites(), origin])].slice(-500)),
                  );
                } catch {
                  /* Storage may be disabled in the browser. */
                }
                onClose();
              }}
            >
              Never for this site
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function DesktopBrowserAccountControls({
  threadRef,
  environmentId,
  tabId,
  profileId,
  url,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  profileId: string;
  url: string;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const newTabProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const saveSession = useAccountCommand(accountsState.save, environmentId);
  const thread = useQuietThreadShell(threadRef);
  const [pending, setPending] = useState<{
    capture: DesktopCapturedSignIn;
    comparison: AccountMatchSignInResult;
  } | null>(null);
  const session = useSessionOffer({
    environmentId,
    tabId,
    profileId,
    url,
    accounts: data?.accounts ?? [],
    enabled: canWrite && pending === null,
  });
  const [filledAccount, setFilledAccount] = useState<{ accountId: string; url: string } | null>(
    null,
  );
  const attemptedDocument = useRef<string | null>(null);
  const captureGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const currentUrl = useRef(url);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Track the tab's page for fills in flight, and clear it on unmount so a late answer never fills the page another tab now shows.
  useEffect(() => {
    currentUrl.current = url;
    return () => {
      currentUrl.current = "";
    };
  }, [url]);
  const getValues = useAccountCommand(accountsState.fillValues, environmentId);
  const compare = useAccountCommand(accountsState.matchSignIn, environmentId);
  const onCapture = useEffectEvent((capture: DesktopCapturedSignIn) => {
    if (capture.tabId !== tabId || capture.profileId !== profileId || !capture.password) return;
    try {
      const origin = new URL(capture.url).origin;
      if (!origin.startsWith("https://") || neverSaveSites().includes(origin)) return;
      void (async () => {
        const generation = ++captureGeneration.current;
        const result = await compare({
          origin,
          username: capture.username,
          password: capture.password,
          profileId: capture.profileId,
        });
        if (generation !== captureGeneration.current || !result.ok) return;
        session.close();
        setPending(result.value.result === "same" ? null : { capture, comparison: result.value });
      })();
    } catch {
      return;
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the desktop's sign-in captures while this toolbar can save, and drop late comparisons on cleanup.
  useEffect(() => {
    if (!canWrite) return;
    const unsubscribe = window.desktopBridge?.accounts?.onSignInCaptured((capture) =>
      onCapture(capture),
    );
    return () => {
      captureGeneration.current++;
      unsubscribe?.();
    };
  }, [canWrite]);
  const matches =
    data && window.desktopBridge?.accounts?.originBoundFill === true
      ? matchingAccounts(data.accounts, url, profileId)
      : [];
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const filled =
    filledAccount?.url === url
      ? matches.find((account) => account.accountId === filledAccount.accountId)
      : undefined;
  const fill = async (account: AccountSummary, form?: DesktopLoginForm) => {
    if (!canWrite || busy || window.desktopBridge?.accounts?.originBoundFill !== true) return;
    const requestedUrl = currentUrl.current;
    setBusy(true);
    try {
      const result = await getValues({
        accountId: account.accountId,
        origin: new URL(requestedUrl).origin,
      });
      if (result.ok && currentUrl.current === requestedUrl) {
        const filled = await window.desktopBridge?.accounts?.fill({
          tabId,
          expectedOrigin: new URL(requestedUrl).origin,
          ...(form ? { documentId: form.documentId, automatic: true } : {}),
          ...(result.value.username !== undefined ? { username: result.value.username } : {}),
          ...(result.value.password !== undefined ? { password: result.value.password } : {}),
          ...(result.value.otp !== undefined ? { otp: result.value.otp } : {}),
        });
        if (filled) setFilledAccount({ accountId: account.accountId, url: requestedUrl });
        else if (!form) toastManager.add({ type: "error", title: "No sign-in form found" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not fill sign-in" });
    }
    setBusy(false);
  };
  const onForm = useEffectEvent((form: DesktopLoginForm) => {
    const account =
      thread && data
        ? matches.find((match) =>
            canAutomaticallyFill(match.controls, data.agentAccess, thread.projectId),
          )
        : undefined;
    if (
      !canWrite ||
      !account ||
      !automaticSignIn(
        form,
        { tabId, profileId, url: currentUrl.current },
        attemptedDocument.current,
      )
    )
      return;
    attemptedDocument.current = form.documentId;
    void fill(account, form);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to login forms the desktop detects in this tab, and ask once for a form already on the page.
  useEffect(() => {
    const bridge = window.desktopBridge?.accounts;
    if (!canWrite || !data || !bridge?.originBoundFill) return;
    let live = true;
    const off = bridge.onLoginFormDetected?.((form) => {
      if (live) onForm(form);
    });
    void bridge
      .loginForm?.(tabId)
      .then((form) => {
        if (live && form && url === currentUrl.current) onForm(form);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off?.();
    };
  }, [canWrite, data, tabId, url]);
  if (!data || !canWrite) return null;
  return (
    <>
      <span ref={setAnchor} className="flex">
        {matches.length === 1 && !filled ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Fill sign-in"
            disabled={busy}
            onClick={() => void fill(matches[0]!)}
          >
            <KeyRoundIcon />
          </Button>
        ) : matches.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant={filled ? "secondary" : "ghost"}
                  aria-label={filled ? `Filled: ${signInLabel(filled)}` : "Fill sign-in"}
                  disabled={busy}
                />
              }
            >
              <KeyRoundIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {matches.map((account) => (
                <MenuItem key={account.accountId} onClick={() => void fill(account)}>
                  <span className="flex-1">{signInLabel(account)}</span>
                  {account.accountId === filled?.accountId ? <CheckIcon /> : null}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </span>
      {session.offer && !pending ? (
        <Popover open onOpenChange={(open) => !open && session.close()}>
          <PopoverPopup anchor={anchor} align="end">
            <div
              className="w-72"
              role="dialog"
              aria-label={`Save ${new URL(session.offer).hostname} to Accounts?`}
            >
              <div className="mb-3 text-sm font-medium">
                Save {new URL(session.offer).hostname} to Accounts?
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={async () => {
                    if (!session.offer || busy) return;
                    if (
                      profileAccounts(data.accounts, session.offer, profileId, newTabProfileId)
                        .length
                    ) {
                      session.close();
                      return;
                    }
                    setBusy(true);
                    const site = new URL(session.offer).origin;
                    const result = await saveSession({
                      name: new URL(site).hostname,
                      details: { kind: "website", sites: [site], profileId },
                      secrets: {},
                    });
                    setBusy(false);
                    if (result.ok) {
                      session.close();
                      toastManager.add({
                        type: "success",
                        title: `${new URL(site).hostname} saved to Accounts`,
                      });
                    }
                  }}
                >
                  Save
                </Button>
                <Button size="xs" variant="ghost" onClick={session.close}>
                  Not now
                </Button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
      {pending ? (
        <SaveSignIn
          key={`${pending.capture.tabId}:${pending.capture.url}:${pending.capture.username}`}
          capture={pending.capture}
          comparison={pending.comparison}
          stores={data.stores}
          environmentId={environmentId}
          matching={matchingAccounts(data.accounts, pending.capture.url, profileId)}
          anchor={anchor}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

export function BrowserAccountControls(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  profileId: string;
  url: string;
}) {
  return window.desktopBridge?.accounts ? (
    <DesktopBrowserAccountControls
      key={`${props.environmentId}:${props.tabId}:${props.profileId}`}
      {...props}
    />
  ) : null;
}
