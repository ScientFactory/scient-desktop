import {
  DEFAULT_BROWSER_PROFILE_ID,
  GOOGLE_SITE,
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
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";

import {
  beginAccountBrowserObservation,
  browserPlatform,
  chromiumBrowserName,
  type AccountBrowserEvents,
} from "../analytics/accountBrowserAnalytics";
import { noteGoogleCopy } from "./googleCopyObservation";
import { recordImportedSessions } from "./importedSessions";
import { chromeSignInIntoMain } from "./mainFill";

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/";
export const CHROME_WINDOW_ACTION = "Sign in in a Chrome window";

type WindowEvent = AccountBrowserEvents["accounts.browser_window"];

const isGoogle = (site: string) => site === GOOGLE_SITE || site.endsWith(`.${GOOGLE_SITE}`);

/** The copy as the person should read it: what was copied, what wasn't, and Google's answer. */
function copyReport(result: Extract<DesktopChromeSignInResult, { outcome: "copied" }>) {
  const units = result.main?.units ?? [{ sites: result.sites, outcome: "copied" as const }];
  const sitesWith = (keep: (outcome: string) => boolean) =>
    units.filter(({ outcome }) => keep(outcome)).flatMap(({ sites }) => sites);
  return {
    copied: sitesWith((outcome) => outcome === "copied" || outcome === "same"),
    held: sitesWith((outcome) => outcome === "conflict"),
    missed: sitesWith((outcome) => !["copied", "same", "conflict"].includes(outcome)),
    google: result.google,
  };
}

/** One observation per run, in fixed codes only. */
function windowEvent(
  result: DesktopChromeSignInResult,
  purpose: WindowEvent["purpose"],
): WindowEvent {
  const browser = chromiumBrowserName("browser" in result ? result.browser : undefined);
  if (result.outcome !== "copied")
    return {
      variant: result.outcome === "no-browser" ? "no_browser" : result.outcome,
      browser,
      purpose,
      google: "none",
    };
  const { held, missed, google } = copyReport(result);
  return {
    variant: held.length > 0 || missed.length > 0 ? "partial" : "copied",
    browser,
    purpose,
    google: google ?? "none",
  };
}

/** What the person learns once the window has closed. */
function report(result: DesktopChromeSignInResult, into: string) {
  const browser = "browser" in result ? result.browser : undefined;
  if (result.outcome === "copied") {
    const { copied, held, missed, google } = copyReport(result);
    const others = copied.filter((site) => !isGoogle(site));
    const alsoCopied = others.length > 0 ? `Also copied: ${others.join(", ")}.` : undefined;
    if (held.length > 0)
      toastManager.add({
        type: "info",
        title: `${into} already holds a sign-in for ${held.join(", ")}`,
        description: `Sign out of it in ${into}, then sign in again.`,
      });
    else if (missed.length > 0)
      toastManager.add({
        type: "error",
        title: `Couldn't bring the sign-in for ${missed.join(", ")} into ${into}`,
        ...(copied.length > 0 ? { description: `Copied: ${copied.join(", ")}.` } : {}),
      });
    else if (google === "rejected")
      toastManager.add({
        type: "error",
        title: "Google didn't accept the copied sign-in",
        description: `Google turned down the copy in ${into}. Using Google in your own browser is the reliable way.${alsoCopied ? ` ${alsoCopied}` : ""}`,
      });
    else if (google === "accepted")
      toastManager.add({
        type: "success",
        title: `Google accepted the sign-in in ${into}`,
        ...(alsoCopied ? { description: alsoCopied } : {}),
      });
    else if (google === "unknown")
      toastManager.add({
        type: "info",
        title: `Copied the sign-in into ${into}, but couldn't check it with Google`,
        ...(alsoCopied ? { description: alsoCopied } : {}),
      });
    else
      toastManager.add({
        type: "success",
        title: `Copied the sign-in for ${copied.join(", ")} into ${into}`,
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
    readonly purpose: WindowEvent["purpose"];
    readonly ending: boolean;
  } | null>(null);
  const end = (keep: boolean) => {
    setOpen((current) => (current ? { ...current, ending: true } : current));
    void accounts?.endChromeSignIn?.(keep).catch(() => undefined);
  };
  const start = async (
    profile: { readonly id: string; readonly name: string },
    url = GOOGLE_SIGN_IN_URL,
    purpose: WindowEvent["purpose"] = "google",
  ) => {
    if (!accounts?.chromeSignIn || open) return;
    const observation = beginAccountBrowserObservation(environmentId);
    const browser = await accounts.chromeSignInBrowser?.().catch(() => null);
    if (!browser) {
      const result = { outcome: "no-browser" } as const;
      observation.record("accounts.browser_window", windowEvent(result, purpose));
      report(result, profile.name);
      return;
    }
    setOpen({
      browser: browser.name,
      canQuit: browser.canQuit,
      into: profile.name,
      purpose,
      ending: false,
    });
    const result: DesktopChromeSignInResult = await (
      profile.id === DEFAULT_BROWSER_PROFILE_ID
        ? chromeSignInIntoMain(environmentId, url)
        : accounts.chromeSignIn({ environmentId, profileId: profile.id, url })
    ).catch(() => ({ outcome: "failed" }) as const);
    observation.record("accounts.browser_window", windowEvent(result, purpose));
    // Google's cookies went in over no session it accepted: follow how long it accepts them.
    if (result.outcome === "copied" && result.google !== undefined && !result.googleHeldBefore)
      noteGoogleCopy(environmentId, profile.id, "browser_window", observation);
    if (result.outcome === "copied" && profile.id !== DEFAULT_BROWSER_PROFILE_ID)
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
              ? `Sign in in the ${open.browser} window, then click Done. ${open.into} gets a copy of the sign-in and the window closes.`
              : `Sign in in the ${open.browser} window, then close it. ${open.into} gets a copy of the sign-in.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="list-disc space-y-1 ps-4 text-muted-foreground text-sm">
            {open.purpose === "google" ? (
              <>
                <li>
                  If {browserPlatform() === "windows" ? "Windows Security" : open.browser} asks for
                  a passkey you don't have, cancel it, then choose Try another way on Google's page.
                </li>
                <li>You don't need to install an authenticator app for this window.</li>
              </>
            ) : null}
            <li>
              The window uses its own temporary profile, apart from your {open.browser} profiles,
              and it's deleted afterwards.
            </li>
          </ul>
        </DialogPanel>
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
    start: (
      profile: { readonly id: string; readonly name: string },
      url?: string,
      purpose?: WindowEvent["purpose"],
    ) => void start(profile, url, purpose),
    dialog,
  };
}
