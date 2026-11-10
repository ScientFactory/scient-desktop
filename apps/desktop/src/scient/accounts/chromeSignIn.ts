import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopChromeSignInResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { setCookies } from "@t3tools/shared/scientSessionCookies";
import * as Effect from "effect/Effect";
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
} from "./chromeWindow.ts";
import { FillMainInput, fillMainStaged } from "./mainFill.ts";
import { withCookieDebugger } from "./sessionCookies.ts";

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

/**
 * The person signs in to a site in a window of their own Chromium browser, on a profile folder
 * Scient owns; then what they signed in to is copied into a Scient profile.
 */
export const chromeSignIn = Effect.fn("DesktopAccounts.chromeSignIn")(function* (
  input: typeof ChromeSignInInput.Type,
) {
  const environmentId = input.environmentId ?? PRIMARY_LOCAL_ENVIRONMENT_ID;
  const intoMain = input.profileId === DEFAULT_BROWSER_PROFILE_ID;
  if (input.profileId === INCOGNITO_BROWSER_PROFILE_ID || (intoMain && !input.main))
    return { outcome: "failed" } satisfies DesktopChromeSignInResult;
  const { platform, found } = yield* browsers;
  const browser = found[0];
  if (!browser) return { outcome: "no-browser" } satisfies DesktopChromeSignInResult;
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
  if (read.units.length === 0) return { outcome: "nothing", browser: browser.name } as const;
  const sites = read.units.flat();
  if (intoMain && input.main) {
    const manager = yield* PreviewManager;
    const filled = yield* fillMainStaged(
      environmentId,
      { ...input.main, units: read.units },
      (scope) =>
        manager
          .getBrowserSession(scope, false)
          .pipe(
            Effect.flatMap((staging) =>
              Effect.promise(() =>
                withCookieDebugger(staging, (send) => setCookies(send, read.cookies)),
              ),
            ),
          ),
    ).pipe(Effect.orElseSucceed(() => null));
    return filled
      ? ({ outcome: "signed-in", browser: browser.name, sites, main: filled } as const)
      : ({ outcome: "failed", browser: browser.name } as const);
  }
  const manager = yield* PreviewManager;
  const scope = resolvePartitionScope(environmentId, input.profileId);
  const written = yield* manager
    .getBrowserSession(scope.scope, scope.persistent, scope.namespace)
    .pipe(
      Effect.flatMap((session) =>
        Effect.tryPromise({
          try: async () => {
            await withCookieDebugger(session, (send) => setCookies(send, read.cookies));
            await session.cookies.flushStore();
          },
          catch: () => new DesktopAccountsError({}),
        }),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  return written
    ? ({ outcome: "signed-in", browser: browser.name, sites } as const)
    : ({ outcome: "failed", browser: browser.name } as const);
});

/** Done or Cancel on the open sign-in window. */
export const endChromeSignIn = Effect.fn("DesktopAccounts.endChromeSignIn")(function* (
  keep: boolean,
) {
  const platform = yield* HostProcess.Platform;
  return endSignInWindow(keep, platform);
});
