import { useEffect, useEffectEvent, useRef, useState } from "react";
import { KeyRoundIcon, XIcon } from "lucide-react";
import type {
  AccountSummary,
  AccountWriteStore,
  AccountStoresStatus,
  AccountMatchSignInResult,
  DesktopCapturedSignIn,
  DesktopLoginForm,
  EnvironmentId,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import {
  automaticSignIn,
  capturedSignInInput,
  matchingAccounts,
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
  onClose,
}: {
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
        : [],
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
    <div
      className="absolute right-2 top-full z-30 mt-2 w-80 rounded-lg border bg-popover p-3 shadow-md"
      role="dialog"
      aria-label={comparison.result === "password-changed" ? "Update password?" : "Save sign-in?"}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {comparison.result === "password-changed" ? "Update password?" : "Save sign-in?"}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss sign-in" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="my-2 text-xs text-muted-foreground">
        {new URL(origin).hostname} · {capture.username}
      </div>
      <div className="mb-3">
        <SaveStores
          kept={
            matching.find((account) => account.accountId === comparison.accountId)?.secrets.password
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
  );
}

function DesktopBrowserAccountControls({
  environmentId,
  tabId,
  profileId,
  url,
}: {
  environmentId: EnvironmentId;
  tabId: string;
  profileId: string;
  url: string;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const [pending, setPending] = useState<{
    capture: DesktopCapturedSignIn;
    comparison: AccountMatchSignInResult;
  } | null>(null);
  const [filledAccount, setFilledAccount] = useState<{ accountId: string; url: string } | null>(
    null,
  );
  const attemptedDocument = useRef<string | null>(null);
  const captureGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const currentUrl = useRef(url);
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
        setPending(result.value.result === "same" ? null : { capture, comparison: result.value });
      })();
    } catch {
      return;
    }
  });
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
    if (
      !canWrite ||
      !matches[0] ||
      !automaticSignIn(
        form,
        { tabId, profileId, url: currentUrl.current },
        attemptedDocument.current,
      )
    )
      return;
    attemptedDocument.current = form.documentId;
    void fill(matches[0], form);
  });
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
      {matches.length === 1 ? (
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
      ) : matches.length > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Fill sign-in"
                disabled={busy}
              />
            }
          >
            <KeyRoundIcon />
          </MenuTrigger>
          <MenuPopup>
            {matches.map((account) => (
              <MenuItem key={account.accountId} onClick={() => void fill(account)}>
                {signInLabel(account)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
      {filledAccount?.url === url &&
      matches.some((account) => account.accountId === filledAccount.accountId) ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="ghost" />}>
            {signInLabel(matches.find((account) => account.accountId === filledAccount.accountId)!)}
          </MenuTrigger>
          <MenuPopup>
            {matches.map((account) => (
              <MenuItem key={account.accountId} onClick={() => void fill(account)}>
                {signInLabel(account)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
      {pending ? (
        <SaveSignIn
          key={`${pending.capture.tabId}:${pending.capture.url}:${pending.capture.username}`}
          capture={pending.capture}
          comparison={pending.comparison}
          stores={data.stores}
          environmentId={environmentId}
          matching={matchingAccounts(data.accounts, pending.capture.url, profileId)}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

export function BrowserAccountControls(props: {
  environmentId: EnvironmentId;
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
