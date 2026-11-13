import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";

import { CHROME_WINDOW_ACTION, useChromeSignIn } from "./ChromeSignIn";

interface Props {
  readonly environmentId: EnvironmentId;
  /** The tab's profile; Incognito keeps nothing, so it gets no sign-in window. */
  readonly profile: { readonly id: string; readonly name: string; readonly incognito: boolean };
  /** The site whose "Continue with Google" was stopped, or null for Google's own sign-in. */
  readonly restartUrl: string | null;
  readonly onOpenExternal: (url: string) => void;
}

const GOOGLE_SIGN_IN_URL = "https://accounts.google.com/";

function useRecovery({ environmentId, profile, restartUrl, onOpenExternal }: Props) {
  const chromeSignIn = useChromeSignIn(environmentId);
  const url = restartUrl ?? GOOGLE_SIGN_IN_URL;
  const site = restartUrl ? (URL.parse(restartUrl)?.hostname ?? restartUrl) : null;
  const withWindow = chromeSignIn.available && !profile.incognito;
  // Only the window brings a sign-in into the profile; the person's browser keeps its own.
  const explanation = withWindow
    ? site
      ? `To use “Continue with Google” on ${site}, choose “${CHROME_WINDOW_ACTION}” and sign in to ${site} there; ${profile.name} then gets that site's sign-in. “Open in my browser” continues in your browser instead.`
      : `Choose “${CHROME_WINDOW_ACTION}” and sign in to Google there; ${profile.name} then gets the sign-in. “Open in my browser” keeps you signed in to Google there instead.`
    : site
      ? `“Open in my browser” opens ${site} in your own browser, where “Continue with Google” works.`
      : `“Open in my browser” opens Google in your own browser, where signing in works.`;
  const actions = (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => onOpenExternal(url)}>
        Open in my browser
      </Button>
      {withWindow ? (
        <Button
          type="button"
          size="sm"
          onClick={() => chromeSignIn.start(profile, url, site ? "site" : "google")}
        >
          {CHROME_WINDOW_ACTION}
        </Button>
      ) : null}
    </>
  );
  return { explanation, actions, dialog: chromeSignIn.dialog };
}

/** Shown in place of a Google sign-in page the tab stopped. */
export function GoogleSignInBlockedPage(props: Props) {
  const { explanation, actions, dialog } = useRecovery(props);
  return (
    <div className="scrollbar-gutter-both relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 py-12 sm:py-16">
        <h1 className="mb-3 text-2xl font-semibold leading-tight text-foreground">
          Google doesn&rsquo;t allow signing in here
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Google blocks sign-in inside the browsers built into apps, Scient&rsquo;s included, so
          Scient stopped Google&rsquo;s sign-in page here.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{explanation}</p>
        <div className="mt-auto flex items-center gap-2 pt-8">
          <div className="flex-1" />
          {actions}
        </div>
      </div>
      {dialog}
    </div>
  );
}

/** Shown over the page when a sign-in window it opened, or Google's refusal, was stopped. */
export function GoogleSignInBlockedNotice(props: Props & { readonly onDismiss: () => void }) {
  const { explanation, actions, dialog } = useRecovery(props);
  return (
    <div
      role="status"
      className="absolute inset-x-3 top-3 z-20 rounded-lg border border-border bg-popover p-4 text-sm shadow-lg"
    >
      <p className="font-medium text-foreground">Google doesn&rsquo;t allow signing in here</p>
      <p className="mt-1 leading-relaxed text-muted-foreground">{explanation}</p>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onDismiss}>
          Dismiss
        </Button>
        <div className="flex-1" />
        {actions}
      </div>
      {dialog}
    </div>
  );
}
