import { useEffect, useRef, useState } from "react";
import { KeyRoundIcon, XIcon } from "lucide-react";
import type { AccountSummary, DesktopCapturedSignIn, EnvironmentId } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { capturedSignInInput, matchingAccounts } from "./accountsView";

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
  onClose,
}: {
  capture: DesktopCapturedSignIn;
  environmentId: EnvironmentId;
  matching: ReadonlyArray<AccountSummary>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const save = useAccountCommand(accountsState.save, environmentId);
  const origin = new URL(capture.url).origin;
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await save(capturedSignInInput(capture, matching));
    setBusy(false);
    if (result.ok) onClose();
  };
  return (
    <div
      className="absolute right-2 top-full z-30 mt-2 w-80 rounded-lg border bg-popover p-3 shadow-md"
      role="dialog"
      aria-label="Save sign-in?"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Save sign-in?</span>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss sign-in" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="my-2 text-xs text-muted-foreground">
        {new URL(origin).hostname} · {capture.username}
      </div>
      <div className="mb-2 text-xs">Scient</div>
      <div className="flex items-center gap-2">
        <Button size="xs" disabled={busy} onClick={() => void submit()}>
          Save
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
  const [capture, setCapture] = useState<DesktopCapturedSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const currentUrl = useRef(url);
  useEffect(() => {
    currentUrl.current = url;
    return () => {
      currentUrl.current = "";
    };
  }, [url]);
  const getValues = useAccountCommand(accountsState.fillValues, environmentId);
  useEffect(() => {
    if (!canWrite) return;
    return window.desktopBridge?.accounts?.onSignInCaptured((capture) => {
      if (capture.tabId !== tabId || capture.profileId !== profileId || !capture.password) return;
      try {
        const origin = new URL(capture.url).origin;
        if (origin.startsWith("https://") && !neverSaveSites().includes(origin))
          setCapture(capture);
      } catch {
        return;
      }
    });
  }, [tabId, profileId, canWrite]);
  const matches =
    data && window.desktopBridge?.accounts?.originBoundFill === true
      ? matchingAccounts(data.accounts, url, profileId)
      : [];
  const fill = async (account: AccountSummary) => {
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
          ...(result.value.username !== undefined ? { username: result.value.username } : {}),
          ...(result.value.password !== undefined ? { password: result.value.password } : {}),
          ...(result.value.otp !== undefined ? { otp: result.value.otp } : {}),
        });
        if (!filled) toastManager.add({ type: "error", title: "No sign-in form found" });
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not fill sign-in" });
    } finally {
      setBusy(false);
    }
  };
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
                {account.name}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
      {capture ? (
        <SaveSignIn
          key={`${capture.tabId}:${capture.url}:${capture.username}`}
          capture={capture}
          environmentId={environmentId}
          matching={matchingAccounts(data.accounts, capture.url, profileId)}
          onClose={() => setCapture(null)}
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
