import { msg, T, useGT, Var } from "gt-react";
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
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/";
/** A button label, resolved where it is shown. */
export const CHROME_WINDOW_ACTION = msg("Sign in in a Chrome window");

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
    const alsoCopied =
      others.length > 0 ? m(msg("Also copied: {sites}.", { sites: others.join(", ") })) : undefined;
    if (held.length > 0)
      toastManager.add({
        type: "info",
        title: m(
          msg("{into} already holds a sign-in for {sites}", { into, sites: held.join(", ") }),
        ),
        description: m(msg("Sign out of it in {into}, then sign in again.", { into })),
      });
    else if (missed.length > 0)
      toastManager.add({
        type: "error",
        title: m(
          msg("Couldn't bring the sign-in for {sites} into {into}", {
            sites: missed.join(", "),
            into,
          }),
        ),
        ...(copied.length > 0
          ? { description: m(msg("Copied: {sites}.", { sites: copied.join(", ") })) }
          : {}),
      });
    else if (google === "rejected")
      toastManager.add({
        type: "error",
        title: m(msg("Google didn't accept the copied sign-in")),
        description: `${m(
          msg(
            "Google turned down the copy in {into}. Using Google in your own browser is the reliable way.",
            { into },
          ),
        )}${alsoCopied ? ` ${alsoCopied}` : ""}`,
      });
    else if (google === "accepted")
      toastManager.add({
        type: "success",
        title: m(msg("Google accepted the sign-in in {into}", { into })),
        ...(alsoCopied ? { description: alsoCopied } : {}),
      });
    else if (google === "unknown")
      toastManager.add({
        type: "info",
        title: m(
          msg("Copied the sign-in into {into}, but couldn't check it with Google", { into }),
        ),
        ...(alsoCopied ? { description: alsoCopied } : {}),
      });
    else
      toastManager.add({
        type: "success",
        title: m(
          msg("Copied the sign-in for {sites} into {into}", { sites: copied.join(", "), into }),
        ),
      });
  } else if (result.outcome === "nothing")
    toastManager.add({
      type: "info",
      title: browser
        ? m(msg("No sign-in found in the {browser} window", { browser }))
        : m(msg("No sign-in found in the browser window")),
    });
  else if (result.outcome === "no-browser")
    toastManager.add({
      type: "info",
      title: m(msg("Signing in this way needs Chrome or Edge on this computer")),
    });
  else if (result.outcome === "busy")
    toastManager.add({ type: "info", title: m(msg("A sign-in window is already open")) });
  else if (result.outcome === "failed")
    toastManager.add({
      type: "error",
      title: m(msg("Couldn't bring the sign-in into {into}", { into })),
    });
}

/**
 * Sites that refuse Scient's browser, Google first: the person signs in in a small window of their
 * own Chrome (or Edge…), on a profile Scient owns, and the sign-in comes into a Scient profile.
 */
export function useChromeSignIn(environmentId: EnvironmentId) {
  const gt = useGT();
  const accounts = window.desktopBridge?.accounts;
  const [open, setOpen] = useState<{
    readonly browser: string;
    readonly canQuit: boolean;
    readonly into: string;
    readonly purpose: WindowEvent["purpose"];
    /**
     * After Done, Cancel still stops a browser that doesn't quit, or a copy not yet written;
     * `committed` once the copy is past that point, when only its result is left to wait for.
     */
    readonly phase: "signing-in" | "finishing" | "cancelling" | "committed";
    /** Names this sign-in to the desktop, before it has even started there. */
    readonly attemptId: string;
  } | null>(null);
  const end = (keep: boolean) => {
    if (!open) return;
    setOpen((current) =>
      current ? { ...current, phase: keep ? "finishing" : "cancelling" } : current,
    );
    void accounts
      ?.endChromeSignIn?.(keep, open.attemptId)
      .then((ended) => {
        // A Cancel refused: the copy was already being written, so it is not cancelled.
        if (!keep && ended === false)
          setOpen((current) => (current ? { ...current, phase: "committed" } : current));
      })
      .catch(() => undefined);
  };
  const start = async (
    profile: { readonly id: string; readonly name: string },
    url = GOOGLE_SIGN_IN_URL,
    purpose: WindowEvent["purpose"] = "google",
    onCopied?: () => void,
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
    const attemptId = randomUUID();
    setOpen({
      browser: browser.name,
      canQuit: browser.canQuit,
      into: profile.name,
      purpose,
      phase: "signing-in",
      attemptId,
    });
    const result: DesktopChromeSignInResult = await (
      profile.id === DEFAULT_BROWSER_PROFILE_ID
        ? chromeSignInIntoMain(environmentId, url, attemptId)
        : accounts.chromeSignIn({ environmentId, profileId: profile.id, url, attemptId })
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
    if (result.outcome === "copied") onCopied?.();
  };
  const dialog = open ? (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && open.phase !== "cancelling" && open.phase !== "committed") end(false);
      }}
    >
      <DialogPopup data-accounts-dialog>
        <DialogHeader>
          <DialogTitle>
            <T>
              Sign in in <Var>{open.browser}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            {open.canQuit
              ? gt(
                  "Sign in in the {browser} window, then click Done. {into} gets a copy of the sign-in and the window closes.",
                  { browser: open.browser, into: open.into },
                )
              : gt(
                  "Sign in in the {browser} window, then close it. {into} gets a copy of the sign-in.",
                  { browser: open.browser, into: open.into },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="list-disc space-y-1 ps-4 text-muted-foreground text-sm">
            {open.purpose === "google" ? (
              <>
                <li>
                  <T>
                    If{" "}
                    <Var>{browserPlatform() === "windows" ? "Windows Security" : open.browser}</Var>{" "}
                    asks for a passkey you don't have, cancel it, then choose Try another way on
                    Google's page.
                  </T>
                </li>
                <li>
                  <T>You don't need to install an authenticator app for this window.</T>
                </li>
              </>
            ) : null}
            <li>
              <T>If the page stays blank, reload it in the window.</T>
            </li>
            <li>
              <T>
                The window uses its own temporary profile, apart from your <Var>{open.browser}</Var>{" "}
                profiles, and it's deleted afterwards.
              </T>
            </li>
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={open.phase === "cancelling" || open.phase === "committed"}
            onClick={() => end(false)}
          >
            <T>Cancel</T>
          </Button>
          {open.canQuit ? (
            <Button disabled={open.phase !== "signing-in"} onClick={() => end(true)}>
              {open.phase === "finishing" || open.phase === "committed"
                ? gt("Bringing it into {into}…", { into: open.into })
                : gt("Done")}
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
      /** Called once the sign-in is in the profile, such as to show the page signed in. */
      onCopied?: () => void,
    ) => void start(profile, url, purpose, onCopied),
    dialog,
  };
}
