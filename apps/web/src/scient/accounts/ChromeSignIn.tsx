import {
  DEFAULT_BROWSER_PROFILE_ID,
  type DesktopChromeSignInResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";

import { recordImportedSessions } from "./importedSessions";
import { chromeSignInIntoMain } from "./mainFill";

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/";
export const CHROME_WINDOW_ACTION = "Sign in in a Chrome window";

/** What the person learns once the window has closed. */
function report(result: DesktopChromeSignInResult, into: string) {
  const browser = "browser" in result ? result.browser : undefined;
  if (result.outcome === "signed-in") {
    const held = result.main?.units.filter(({ outcome }) => outcome === "conflict") ?? [];
    const missed = result.main?.units.some(
      ({ outcome }) => outcome !== "copied" && outcome !== "same",
    );
    if (held.length)
      toastManager.add({
        type: "info",
        title: `${into} already holds a sign-in for ${held.flatMap(({ sites }) => sites).join(", ")}`,
        description: `Sign out of it in ${into}, then sign in again.`,
      });
    else if (missed)
      toastManager.add({ type: "error", title: `Couldn't bring the sign-in into ${into}` });
    else
      toastManager.add({
        type: "success",
        title: `Signed in to ${result.sites.join(", ")} in ${into}`,
      });
  } else if (result.outcome === "nothing")
    toastManager.add({
      type: "info",
      title: `No sign-in found in the ${browser ?? "browser"} window`,
    });
  else if (result.outcome === "no-browser")
    toastManager.add({
      type: "info",
      title: "Signing in this way needs Chrome or Edge on this computer",
    });
  else if (result.outcome === "busy")
    toastManager.add({ type: "info", title: "A sign-in window is already open" });
  else if (result.outcome === "failed")
    toastManager.add({ type: "error", title: `Couldn't bring the sign-in into ${into}` });
}

/**
 * Sites that refuse Scient's browser, Google first: the person signs in in a small window of their
 * own Chrome (or Edge…), on a profile Scient owns, and the sign-in comes into a Scient profile.
 */
export function useChromeSignIn(environmentId: EnvironmentId) {
  const accounts = window.desktopBridge?.accounts;
  const [open, setOpen] = useState<{
    readonly browser: string;
    readonly canQuit: boolean;
    readonly into: string;
    readonly ending: boolean;
  } | null>(null);
  const end = (keep: boolean) => {
    setOpen((current) => (current ? { ...current, ending: true } : current));
    void accounts?.endChromeSignIn?.(keep).catch(() => undefined);
  };
  const start = async (
    profile: { readonly id: string; readonly name: string },
    url = GOOGLE_SIGN_IN_URL,
  ) => {
    if (!accounts?.chromeSignIn || open) return;
    const browser = await accounts.chromeSignInBrowser?.().catch(() => null);
    if (!browser) {
      report({ outcome: "no-browser" }, profile.name);
      return;
    }
    setOpen({ browser: browser.name, canQuit: browser.canQuit, into: profile.name, ending: false });
    const result: DesktopChromeSignInResult = await (
      profile.id === DEFAULT_BROWSER_PROFILE_ID
        ? chromeSignInIntoMain(environmentId, url)
        : accounts.chromeSignIn({ environmentId, profileId: profile.id, url })
    ).catch(() => ({ outcome: "failed" }) as const);
    if (result.outcome === "signed-in" && profile.id !== DEFAULT_BROWSER_PROFILE_ID)
      await recordImportedSessions(environmentId, profile.id, `${result.browser} window`, {
        fillMain: true,
      });
    setOpen(null);
    // Google and every row look again at what the window brought.
    window.dispatchEvent(new Event("scient-accounts-session-changed"));
    report(result, profile.name);
  };
  const dialog = open ? (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !open.ending) end(false);
      }}
    >
      <DialogPopup data-accounts-dialog>
        <DialogHeader>
          <DialogTitle>Sign in in {open.browser}</DialogTitle>
          <DialogDescription>
            {open.canQuit
              ? `Sign in in the ${open.browser} window, then click Done. ${open.into} gets the sign-in and the window closes.`
              : `Sign in in the ${open.browser} window, then close it. ${open.into} gets the sign-in.`}{" "}
            The window has its own profile, apart from your {open.browser} profiles.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={open.ending} onClick={() => end(false)}>
            Cancel
          </Button>
          {open.canQuit ? (
            <Button disabled={open.ending} onClick={() => end(true)}>
              {open.ending ? `Bringing it into ${open.into}…` : "Done"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ) : null;
  return {
    available: !!accounts?.chromeSignIn,
    start: (profile: { readonly id: string; readonly name: string }, url?: string) =>
      void start(profile, url),
    dialog,
  };
}
