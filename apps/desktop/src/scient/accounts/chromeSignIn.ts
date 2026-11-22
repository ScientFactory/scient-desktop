import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  GOOGLE_SITE,
  INCOGNITO_BROWSER_PROFILE_ID,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopChromeSignInResult,
  type DesktopGoogleCopyCheck,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { setCookies } from "@t3tools/shared/scientSessionCookies";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { resolvePartitionScope } from "../../ipc/methods/preview.ts";
import { PreviewManager } from "../../preview/Manager.ts";
import { DesktopAccountsError } from "./errors.ts";
import {
  canQuitWindow,
  endSignInWindow,
  installedChromiumBrowsers,
  signInInWindow,
  type ChromiumBrowser,
} from "./chromeWindow.ts";
import { FillMainInput, fillMainStaged } from "./mainFill.ts";
import { readGoogleSessions } from "./googleSessions.ts";
import { withCookieDebugger } from "./sessionCookies.ts";

const GOOGLE_CHECK_TIMEOUT = "15 seconds";

const { mode, replaceAllowedSince, replaceGoogle, skipSites } = FillMainInput.fields;
export const ChromeSignInInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  profileId: BrowserProfileId,
  url: Schema.String.check(
    Schema.isMaxLength(2048),
    Schema.isPattern(/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)[:/])/),
  ),
  /** Required for Main: what the copy into it may do, as for an import into Main. */
  main: Schema.optional(Schema.Struct({ mode, replaceAllowedSince, replaceGoogle, skipSites })),
});

const browsers = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  return {
    platform,
    found: installedChromiumBrowsers({ platform, env, home: env.HOME ?? env.USERPROFILE ?? "" }),
  };
});

/** The browser a sign-in window opens in, or null when none is installed. */
export const chromeSignInBrowser = browsers.pipe(
  Effect.map(({ platform, found }) =>
    found[0] ? { name: found[0].name, canQuit: canQuitWindow(platform) } : null,
  ),
);

/** Google's list for a profile: one account it accepts is enough. Never fails nor waits long. */
const readGoogle = (session: Parameters<typeof readGoogleSessions>[0]) =>
  Effect.promise(() => readGoogleSessions(session).catch(() => null)).pipe(
    Effect.timeoutOption(GOOGLE_CHECK_TIMEOUT),
    Effect.map((answer): DesktopGoogleCopyCheck => {
      const sessions = Option.getOrNull(answer);
      if (sessions === null) return "unknown";
      // An empty list after copying Google's cookies: Google holds no session from them.
      return sessions.some(({ valid }) => valid) ? "accepted" : "rejected";
    }),
  );

interface Copy {
  cancelled: boolean;
  writing: boolean;
}

/**
 * The sign-in in progress. After its window closes, Cancel still stops the copy until its first
 * write: reading the profile and asking Google first can take a while. Then the result stands.
 */
let copying: Copy | undefined;

/**
 * The person signs in to a site in a window of their own Chromium browser, on a profile folder
 * Scient owns; then what they signed in to is copied into a Scient profile.
 */
export const chromeSignIn = Effect.fn("DesktopAccounts.chromeSignIn")(function* (
  input: typeof ChromeSignInInput.Type,
) {
  const intoMain = input.profileId === DEFAULT_BROWSER_PROFILE_ID;
  if (input.profileId === INCOGNITO_BROWSER_PROFILE_ID || (intoMain && !input.main))
    return { outcome: "failed" } satisfies DesktopChromeSignInResult;
  const { platform, found } = yield* browsers;
  const browser = found[0];
  if (!browser) return { outcome: "no-browser" } satisfies DesktopChromeSignInResult;
  if (copying) return { outcome: "busy", browser: browser.name } as const;
  const copy: Copy = { cancelled: false, writing: false };
  copying = copy;
  return yield* copyFromWindow(input, browser, platform, copy).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (copying === copy) copying = undefined;
      }),
    ),
  );
});

const copyFromWindow = Effect.fn("DesktopAccounts.copyFromWindow")(function* (
  input: typeof ChromeSignInInput.Type,
  browser: ChromiumBrowser,
  platform: NodeJS.Platform,
  copy: Copy,
) {
  const environmentId = input.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
  const intoMain = input.profileId === DEFAULT_BROWSER_PROFILE_ID;
  const cancelled = { outcome: "cancelled", browser: browser.name } as const;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const read = yield* Effect.promise(() =>
    signInInWindow({
      browser,
      folder: environment.path.join(environment.stateDir, "scient", "chrome-sign-in"),
      url: input.url,
      platform,
    }),
  );
  if (read.outcome !== "read") return { ...read, browser: browser.name };
  if (copy.cancelled) return cancelled;
  if (read.units.length === 0) return { outcome: "nothing", browser: browser.name } as const;
  const sites = read.units.flat();
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(environmentId, input.profileId);
  const session = yield* manager
    .getBrowserSession(scope.scope, scope.persistent, scope.namespace)
    .pipe(Effect.option);
  if (Option.isNone(session)) return { outcome: "failed", browser: browser.name } as const;
  const askGoogle = readGoogle(session.value);
  if (intoMain && input.main) {
    if (copy.cancelled) return cancelled;
    copy.writing = true;
    const filled = yield* fillMainStaged(
      environmentId,
      { ...input.main, units: read.units },
      (staging) =>
        manager
          .getBrowserSession(staging, false)
          .pipe(
            Effect.flatMap((source) =>
              Effect.promise(() =>
                withCookieDebugger(source, (send) => setCookies(send, read.cookies)),
              ),
            ),
          ),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!filled) return { outcome: "failed", browser: browser.name } as const;
    // Main's Google unit is written only where Main holds no session Google accepts.
    const google = filled.units.some(
      ({ sites, outcome }) => outcome === "copied" && sites.includes(GOOGLE_SITE),
    )
      ? { google: yield* askGoogle }
      : {};
    return { outcome: "copied", browser: browser.name, sites, main: filled, ...google } as const;
  }
  const copiesGoogle = read.units.some((unit) => unit.includes(GOOGLE_SITE));
  const before = copiesGoogle ? yield* askGoogle : undefined;
  if (copy.cancelled) return cancelled;
  copy.writing = true;
  const written = yield* Effect.tryPromise({
    try: async () => {
      await withCookieDebugger(session.value, (send) => setCookies(send, read.cookies));
      await session.value.cookies.flushStore();
    },
    catch: () => new DesktopAccountsError({}),
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!written) return { outcome: "failed", browser: browser.name } as const;
  return {
    outcome: "copied",
    browser: browser.name,
    sites,
    ...(copiesGoogle ? { google: yield* askGoogle } : {}),
    ...(before === "accepted" ? { googleHeldBefore: true } : {}),
  } as const;
});

/**
 * Done or Cancel on the open sign-in window. Cancel also stops a copy that hasn't started writing.
 * False when there is nothing left to end: the dialog then waits for the result.
 */
export const endChromeSignIn = Effect.fn("DesktopAccounts.endChromeSignIn")(function* (
  keep: boolean,
) {
  const platform = yield* HostProcess.Platform;
  if (endSignInWindow(keep, platform)) return true;
  if (keep || !copying || copying.writing) return false;
  copying.cancelled = true;
  return true;
});
