import { T, useGT, useMessages } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";

import { CHROME_WINDOW_ACTION, useChromeSignIn } from "./ChromeSignIn";
import { parseUrl } from "@t3tools/shared/url";

interface Props {
  readonly environmentId: EnvironmentId;
  /** The tab's profile; Incognito keeps nothing, so it gets no sign-in window. */
  readonly profile: { readonly id: string; readonly name: string; readonly incognito: boolean };
  /** The site whose "Continue with Google" Google refused, or null for Google's own sign-in. */
  readonly restartUrl: string | null;
  readonly onOpenExternal: (url: string) => void;
  /** Shows `url` in the tab once the sign-in window brought the sign-in into its profile. */
  readonly onSignedIn: (url: string) => void;
}

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/";

function useRecovery({ environmentId, profile, restartUrl, onOpenExternal, onSignedIn }: Props) {
  const gt = useGT();
  const messages = useMessages();
  const chromeSignIn = useChromeSignIn(environmentId);
  const action = messages(CHROME_WINDOW_ACTION);
  const url = restartUrl ?? GOOGLE_SIGN_IN_URL;
  const site = restartUrl ? (parseUrl(restartUrl)?.hostname ?? restartUrl) : null;
  const withWindow = chromeSignIn.available && !profile.incognito;
  // Only the window brings a sign-in into the profile; the person's browser keeps its own.
  const explanation = withWindow
    ? site
      ? gt(
          "To use “Continue with Google” on {site}, choose “{action}” and sign in to {site} there; {profile} then gets that site's sign-in. “Open in my browser” continues in your browser instead.",
          { site, action, profile: profile.name },
        )
      : gt(
          "Choose “{action}” and sign in to Google there; {profile} then gets the sign-in. “Open in my browser” keeps you signed in to Google there instead.",
          { action, profile: profile.name },
        )
    : site
      ? gt(
          "“Open in my browser” opens {site} in your own browser, where “Continue with Google” works.",
          { site },
        )
      : gt("“Open in my browser” opens Google in your own browser, where signing in works.");
  const actions = (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => onOpenExternal(url)}>
        <T>Open in my browser</T>
      </Button>
      {withWindow ? (
        <Button
          type="button"
          size="sm"
          onClick={() =>
            chromeSignIn.start(profile, url, site ? "site" : "google", () => onSignedIn(url))
          }
        >
          {action}
        </Button>
      ) : null}
    </>
  );
  return { explanation, actions, dialog: chromeSignIn.dialog };
}

/** Shown over Google's refusal, or over the page whose sign-in window or frame Google refused. */
export function GoogleSignInBlockedNotice(props: Props & { readonly onDismiss: () => void }) {
  const { explanation, actions, dialog } = useRecovery(props);
  return (
    <div
      role="status"
      className="absolute inset-x-3 top-3 z-20 rounded-lg border border-border bg-popover p-4 text-sm shadow-lg"
    >
      <p className="font-medium text-foreground">
        <T>Google doesn&rsquo;t allow signing in here</T>
      </p>
      <p className="mt-1 leading-relaxed text-muted-foreground">{explanation}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onDismiss}>
          <T>Dismiss</T>
        </Button>
        <div className="flex-1" />
        {actions}
      </div>
      {dialog}
    </div>
  );
}
