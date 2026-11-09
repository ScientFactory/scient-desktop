import { useSignInRecording } from "./useSignInRecording";
import { useUniversityBrowsing } from "./useUniversityBrowsing";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ACCOUNTS_PROTOCOL } from "@t3tools/contracts";
import type {
  AccountSummary,
  AccountWriteStore,
  AccountStoresStatus,
  AccountMatchSignInResult,
  DesktopCapturedSignIn,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { InputGroupAddon } from "~/components/ui/input-group";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import {
  capturedSignInInput,
  fillableAccounts,
  matchingAccounts,
  mergeProfiles,
} from "./accountsView";
import { SignInKey } from "./SignInKey";

import { SaveStores } from "./SaveStores";
import { autofilledTabs, filledTabRecord } from "./accountAutofill";
import { useClientSettings } from "~/hooks/useSettings";
import { useThreadPreviewState } from "~/previewStateStore";

const NEVER_KEY = "scient.accounts.never-save.v1";
/** A submitted form has had time to reject the password by now. */
const SIGN_IN_SETTLE_MS = 6_000;
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
  environmentId,
  threadRef,
  tabId,
  previewTabId,
  profileId,
  url,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  previewTabId?: string | undefined;
  profileId: string;
  url: string;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const inAttempt = (data?.attempts ?? []).some((attempt) => attempt.tabId === previewTabId);
  const [pending, setPending] = useState<{
    capture: DesktopCapturedSignIn;
    comparison: AccountMatchSignInResult;
  } | null>(null);
  useSignInRecording({
    environmentId,
    tabId,
    profileId,
    url,
    accounts: data?.accounts ?? [],
    sessionsSeen: (data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL,
    signingIn: inAttempt,
    enabled: canWrite && pending === null,
  });
  useUniversityBrowsing({
    environmentId,
    threadRef,
    tabId: previewTabId ?? "",
    profileId,
    url,
    accounts: data?.accounts ?? [],
    enabled: canWrite && previewTabId !== undefined,
  });
  const [filledAccount, setFilledAccount] = useState<{ accountId: string; url: string } | null>(
    null,
  );
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
  const signInSeen = useAccountCommand(accountsState.signInSeen, environmentId);
  const onCapture = useEffectEvent((capture: DesktopCapturedSignIn) => {
    if (capture.tabId !== tabId || capture.profileId !== profileId || !capture.password) return;
    // Scient's own sign-in on this tab keeps what is typed once it is proven (`signInKeeps`).
    if (inAttempt && (data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL) return;
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
        // The saved password went in; once the login form is gone, it worked.
        const { accountId } = result.value;
        if (result.value.result === "same" && accountId) {
          const submittedFrom = currentUrl.current;
          await new Promise((settled) => setTimeout(settled, SIGN_IN_SETTLE_MS));
          const form = await window.desktopBridge?.accounts?.loginForm?.(tabId);
          // No form could also mean the tab closed or the page is reloading.
          const moved = currentUrl.current !== "" && currentUrl.current !== submittedFrom;
          if (form === null && moved && generation === captureGeneration.current)
            void signInSeen({ accountId, outcome: "signed-in" });
        }
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
      ? fillableAccounts(data.accounts, url, profileId)
      : [];
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  // A page an agent controls could read what is filled or shown, so it gets no key.
  const agentTab =
    useThreadPreviewState(threadRef).sessions[previewTabId ?? ""]?.automationOwner !== undefined;
  const navigate = useNavigate();
  const profileNames = new Map(
    mergeProfiles(
      useClientSettings((settings) => settings.browserProfiles),
      data?.profiles ?? [],
    ).map((profile) => [profile.id, profile.name]),
  );
  const profileOf = (account: AccountSummary) =>
    ("profileId" in account.details ? account.details.profileId : undefined) ?? profileId;
  const profiles = new Set(matches.map(profileOf));
  const profileName = (account: AccountSummary) => profileNames.get(profileOf(account));
  const autofilled = useSyncExternalStore(autofilledTabs.subscribe, () =>
    autofilledTabs.get(tabId),
  );
  const shown =
    filledAccount?.url === url ? filledAccount : autofilled?.url === url ? autofilled : null;
  const filled = shown
    ? matches.find((account) => account.accountId === shown.accountId)
    : undefined;
  const fill = async (account: AccountSummary) => {
    if (!canWrite || busy || window.desktopBridge?.accounts?.originBoundFill !== true) return;
    const requestedUrl = currentUrl.current;
    setBusy(true);
    try {
      const tab = filledTabRecord(tabId, requestedUrl);
      const result = await getValues({
        accountId: account.accountId,
        origin: new URL(requestedUrl).origin,
        ...(tab ? { tab } : {}),
      });
      if (result.ok && currentUrl.current === requestedUrl) {
        const filled = await window.desktopBridge?.accounts?.fill({
          tabId,
          expectedOrigin: new URL(requestedUrl).origin,
          ...(result.value.username !== undefined ? { username: result.value.username } : {}),
          ...(result.value.password !== undefined ? { password: result.value.password } : {}),
          ...(result.value.otp !== undefined ? { otp: result.value.otp } : {}),
        });
        if (filled) setFilledAccount({ accountId: account.accountId, url: requestedUrl });
        else toastManager.add({ type: "error", title: "No sign-in form found" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not fill sign-in" });
    }
    setBusy(false);
  };
  if (!data || !canWrite) return null;
  return (
    <>
      {matches.length > 0 && !agentTab ? (
        <InputGroupAddon align="inline-end">
          <span ref={setAnchor} className="flex">
            <SignInKey
              site={new URL(url).hostname}
              rows={matches.map((account) => ({
                accountId: account.accountId,
                username:
                  account.details.kind === "website" ? (account.details.username ?? "") : "",
                profile: profiles.size > 1 ? profileName(account) : undefined,
              }))}
              filledId={filled?.accountId}
              busy={busy}
              onFill={(accountId) => {
                const account = matches.find((match) => match.accountId === accountId);
                if (account) void fill(account);
              }}
              onReveal={async (accountId) => {
                const account = matches.find((match) => match.accountId === accountId);
                if (!account) return undefined;
                const result = await getValues({
                  accountId: account.accountId,
                  origin: new URL(url).origin,
                });
                return result.ok ? result.value.password : undefined;
              }}
              onEdit={() => void navigate({ to: "/settings/accounts" })}
            />
          </span>
        </InputGroupAddon>
      ) : (
        <span ref={setAnchor} className="flex" />
      )}
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
  previewTabId?: string;
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
